"""A drawn poker table, for trying the pipeline without a camera.

`table_vision.py --source demo` renders these frames, and the tests use them to
check the detector end to end. It is deliberately plain: green felt, white
cards, flat chips - enough to exercise the geometry and the colour matching.
"""

from __future__ import annotations

import cv2
import numpy as np

FELT = (60, 110, 45)
CARD_FACE = (245, 245, 245)
RED_INK = (40, 40, 200)
BLACK_INK = (30, 30, 30)

CHIP_BGR = {
    "לבן": (235, 235, 235),
    "אדום": (45, 45, 200),
    "כחול": (190, 110, 40),
    "ירוק": (70, 160, 60),
    "שחור": (40, 40, 40),
}


def draw_suit(canvas: np.ndarray, suit: str, center: tuple[int, int], size: int, color) -> None:
    """Draw a suit pip centred on `center`, `size` pixels tall."""
    cx, cy = center
    half = size // 2
    if suit == "d":
        pts = np.array([[cx, cy - half], [cx + half * 3 // 4, cy], [cx, cy + half], [cx - half * 3 // 4, cy]])
        cv2.fillPoly(canvas, [pts], color)
    elif suit == "h":
        r = half // 2
        cv2.circle(canvas, (cx - r, cy - r // 2), r, color, -1)
        cv2.circle(canvas, (cx + r, cy - r // 2), r, color, -1)
        cv2.fillPoly(canvas, [np.array([[cx - 2 * r, cy - r // 2], [cx + 2 * r, cy - r // 2], [cx, cy + half]])], color)
    elif suit == "s":
        r = half // 2
        cv2.circle(canvas, (cx - r, cy + r // 3), r, color, -1)
        cv2.circle(canvas, (cx + r, cy + r // 3), r, color, -1)
        cv2.fillPoly(canvas, [np.array([[cx - 2 * r, cy + r // 3], [cx + 2 * r, cy + r // 3], [cx, cy - half]])], color)
        cv2.fillPoly(canvas, [np.array([[cx - r, cy + half], [cx + r, cy + half], [cx + r // 3, cy], [cx - r // 3, cy]])], color)
    elif suit == "c":
        r = max(3, half // 3)
        cv2.circle(canvas, (cx, cy - half + r), r, color, -1)
        cv2.circle(canvas, (cx - r, cy + r // 2), r, color, -1)
        cv2.circle(canvas, (cx + r, cy + r // 2), r, color, -1)
        cv2.fillPoly(canvas, [np.array([[cx - r, cy + half], [cx + r, cy + half], [cx + r // 3, cy], [cx - r // 3, cy]])], color)


def render_card(rank: str, suit: str, width: int = 130, height: int = 195) -> np.ndarray:
    """A single face-up card, drawn straight on.

    The corner index sits where a real card keeps it - rank on top, suit just
    below it - because that corner is exactly what the detector reads.
    """
    card = np.full((height, width, 3), CARD_FACE, dtype=np.uint8)
    cv2.rectangle(card, (0, 0), (width - 1, height - 1), (150, 150, 150), 2)
    ink = RED_INK if suit in ("h", "d") else BLACK_INK

    scale = width / 130.0
    font_scale = (0.5 if rank == "10" else 0.7) * scale
    cv2.putText(card, rank, (int(5 * scale), int(30 * scale)), cv2.FONT_HERSHEY_SIMPLEX,
                font_scale, ink, max(1, int(2 * scale)))
    draw_suit(card, suit, (int(12 * scale), int(44 * scale)), int(14 * scale), ink)
    draw_suit(card, suit, (width // 2, height // 2), int(60 * scale), ink)
    return card


def paste(frame: np.ndarray, patch: np.ndarray, top_left: tuple[int, int], angle: float = 0.0) -> None:
    """Drop `patch` onto `frame`, optionally rotated a few degrees."""
    if angle:
        h, w = patch.shape[:2]
        diag = int((h**2 + w**2) ** 0.5)
        canvas = np.zeros((diag, diag, 3), dtype=np.uint8)
        oy, ox = (diag - h) // 2, (diag - w) // 2
        canvas[oy : oy + h, ox : ox + w] = patch
        matrix = cv2.getRotationMatrix2D((diag / 2, diag / 2), angle, 1.0)
        patch = cv2.warpAffine(canvas, matrix, (diag, diag))
    x, y = top_left
    h, w = patch.shape[:2]
    fh, fw = frame.shape[:2]
    x, y = max(0, min(x, fw - w)), max(0, min(y, fh - h))
    region = frame[y : y + h, x : x + w]
    mask = patch.any(axis=2)
    region[mask] = patch[mask]


def render_table(
    cards: list[tuple[str, str]] | None = None,
    chips: list[tuple[int, int, str]] | None = None,
    size: tuple[int, int] = (960, 640),
    angle: float = 0.0,
) -> np.ndarray:
    """A felt table with `cards` in a row and `chips` at given positions."""
    width, height = size
    frame = np.full((height, width, 3), FELT, dtype=np.uint8)
    cards = cards or []
    if cards:
        card_w, card_h = 130, 195
        gap = 18
        total = len(cards) * card_w + (len(cards) - 1) * gap
        x = (width - total) // 2
        y = int(height * 0.18)
        for rank, suit in cards:
            paste(frame, render_card(rank, suit, card_w, card_h), (x, y), angle)
            x += card_w + gap
    for cx, cy, name in chips or []:
        color = CHIP_BGR.get(name, (200, 200, 200))
        cv2.circle(frame, (cx, cy), 26, tuple(int(c * 0.6) for c in color), -1)
        cv2.circle(frame, (cx, cy), 22, color, -1)
    return frame


def demo_frames(loops: int = 1):
    """A whole hand: flop, turn, river, with bets growing in front of two seats."""
    stages = [
        ([], []),
        ([("A", "s"), ("K", "h"), ("7", "d")], [(180, 520, "אדום")]),
        ([("A", "s"), ("K", "h"), ("7", "d"), ("10", "c")], [(180, 520, "אדום"), (240, 520, "אדום"), (760, 520, "ירוק")]),
        (
            [("A", "s"), ("K", "h"), ("7", "d"), ("10", "c"), ("Q", "s")],
            [(180, 520, "אדום"), (240, 520, "אדום"), (760, 520, "ירוק"), (700, 520, "כחול")],
        ),
    ]
    for _ in range(loops):
        for cards, chips in stages:
            for _ in range(8):  # hold each stage long enough for the trackers
                yield render_table(cards, chips)
