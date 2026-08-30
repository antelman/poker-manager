"""Counting the chips on the table and turning them into money.

Chips are round and roughly the same size, so a Hough circle transform finds
them; the colour is then read from the middle of each chip and matched against
the calibrated colours in the config, each of which carries a value.

Only chips the camera can actually see are counted - a stack seen from above is
one visible chip. Spread the bets out in front of each seat, or point a second
camera at the stacks from the side.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np

from .config import ChipColor, ChipTuning, TableConfig, from_cents


@dataclass
class DetectedChip:
    center: tuple[int, int]
    radius: int
    hsv: tuple[float, float, float]
    color: ChipColor | None

    @property
    def name(self) -> str:
        return self.color.name if self.color else "?"

    @property
    def value_cents(self) -> int:
        return self.color.value_cents if self.color else 0


def _sample_hsv(hsv_frame: np.ndarray, center: tuple[int, int], radius: int) -> tuple[float, float, float]:
    """Median HSV over the middle of a chip, ignoring the printed edge."""
    x, y = center
    inner = max(2, int(radius * 0.55))
    h, w = hsv_frame.shape[:2]
    x0, x1 = max(0, x - inner), min(w, x + inner)
    y0, y1 = max(0, y - inner), min(h, y + inner)
    patch = hsv_frame[y0:y1, x0:x1]
    if patch.size == 0:
        return 0.0, 0.0, 0.0
    pixels = patch.reshape(-1, 3)
    # Hue is circular, so average it on the unit circle instead of numerically.
    angles = pixels[:, 0].astype(np.float32) * (2 * np.pi / 180.0)
    hue = np.degrees(np.arctan2(np.sin(angles).mean(), np.cos(angles).mean())) / 2.0
    if hue < 0:
        hue += 180
    return float(hue), float(np.median(pixels[:, 1])), float(np.median(pixels[:, 2]))


def _is_solid(hsv_frame: np.ndarray, center: tuple[int, int], radius: int, limit: float) -> bool:
    """A chip face is one flat colour; card pips and felt texture are not."""
    x, y = center
    inner = max(2, int(radius * 0.55))
    h, w = hsv_frame.shape[:2]
    patch = hsv_frame[max(0, y - inner) : min(h, y + inner), max(0, x - inner) : min(w, x + inner)]
    if patch.size == 0:
        return False
    return float(np.std(patch[:, :, 2])) <= limit


def find_chips(frame: np.ndarray, config: TableConfig, exclude_boxes: list[tuple] | None = None) -> list[DetectedChip]:
    """Every chip-looking circle in the frame, with its colour resolved.

    `exclude_boxes` are areas to ignore - pass the detected cards, whose round
    pips otherwise read as small chips.
    """
    tuning: ChipTuning = config.chips
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV) if frame.ndim == 3 else None
    blurred = cv2.medianBlur(gray, 5)

    circles = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=tuning.dp,
        minDist=max(6, int(tuning.min_dist_frac * width)),
        param1=tuning.param1,
        param2=tuning.param2,
        minRadius=max(4, int(tuning.min_radius_frac * width)),
        maxRadius=max(6, int(tuning.max_radius_frac * width)),
    )
    if circles is None or hsv is None:
        return []

    chips = []
    for cx, cy, radius in np.round(circles[0]).astype(int):
        cx, cy, radius = int(cx), int(cy), int(radius)
        if not (0 <= cx < width and 0 <= cy < height):
            continue
        if any(bx <= cx <= bx + bw and by <= cy <= by + bh for bx, by, bw, bh in exclude_boxes or []):
            continue
        if not _is_solid(hsv, (cx, cy), radius, tuning.uniformity_max):
            continue
        sample = _sample_hsv(hsv, (cx, cy), radius)
        chips.append(
            DetectedChip(
                center=(cx, cy),
                radius=radius,
                hsv=sample,
                color=config.color_for(*sample),
            )
        )
    return chips


def summarize(chips: list[DetectedChip], config: TableConfig, size: tuple[int, int]) -> dict:
    """Group chips into betting regions and add up what each one is worth."""
    width, height = size
    betting = [r for r in config.regions if r.kind in ("player", "pot")]
    buckets: dict[str, dict] = {
        r.name: {"name": r.name, "kind": r.kind, "counts": {}, "valueCents": 0, "chips": 0}
        for r in betting
    }
    loose = {"name": "שאר השולחן", "kind": "loose", "counts": {}, "valueCents": 0, "chips": 0}

    for chip in chips:
        if chip.color is None:
            continue
        target = loose
        for region in betting:
            if region.contains(chip.center[0], chip.center[1], width, height):
                target = buckets[region.name]
                break
        target["counts"][chip.color.name] = target["counts"].get(chip.color.name, 0) + 1
        target["valueCents"] += chip.color.value_cents
        target["chips"] += 1

    regions = list(buckets.values())
    if loose["chips"]:
        regions.append(loose)
    total = sum(r["valueCents"] for r in regions)
    return {
        "unit": config.unit,
        "regions": regions,
        "totalCents": total,
        "total": from_cents(total),
        "unknown": sum(1 for c in chips if c.color is None),
    }


class ChipTracker:
    """Reports a bet only after it holds still for a few frames.

    Hands reaching over the table make chips appear and vanish between frames;
    without this every wave of a sleeve would look like a raise.
    """

    def __init__(self, tuning: ChipTuning):
        self.tuning = tuning
        self.history: dict[str, deque] = {}
        self.stable: dict[str, dict] = {}

    def update(self, summary: dict) -> dict:
        seen = set()
        for region in summary["regions"]:
            name = region["name"]
            seen.add(name)
            bucket = self.history.setdefault(name, deque(maxlen=self.tuning.history))
            bucket.append(region["valueCents"])
            recent = list(bucket)[-self.tuning.stable_frames :]
            if len(recent) >= self.tuning.stable_frames and len(set(recent)) == 1:
                self.stable[name] = region
        for name in list(self.stable):
            if name not in seen:
                bucket = self.history.get(name)
                if bucket is not None:
                    bucket.append(0)
                    recent = list(bucket)[-self.tuning.stable_frames :]
                    if len(recent) >= self.tuning.stable_frames and set(recent) == {0}:
                        del self.stable[name]

        regions = list(self.stable.values())
        total = sum(r["valueCents"] for r in regions)
        return {
            "unit": summary["unit"],
            "regions": regions,
            "totalCents": total,
            "total": from_cents(total),
            "unknown": summary["unknown"],
        }
