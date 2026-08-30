"""Detecting and reading playing cards from a camera frame.

The pipeline is the classic one: threshold the frame so the white cards stand
out from the felt, keep the four-cornered contours, flatten each one to a
canonical 200x300 image, then read the rank and the suit out of the top-left
corner by comparing them to template images captured from the real deck
(`table_vision.py learn-cards`).

Nothing here talks to a camera or draws on screen - it takes a frame in and
returns plain data, so it can be tested on a still image.
"""

from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .config import CardTuning

CARD_W, CARD_H = 200, 300
CORNER_W, CORNER_H = 34, 86
ZOOM = 4
RANK_SIZE = (70, 125)  # width, height
SUIT_SIZE = (70, 100)

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["s", "h", "d", "c"]
SUIT_SYMBOL = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}
RANK_FILENAME = {"10": "T"}  # "10" would be an odd file name


@dataclass
class DetectedCard:
    """One card seen in a frame."""

    rank: str | None
    suit: str | None
    rank_score: float
    suit_score: float
    center: tuple[int, int]
    box: tuple[int, int, int, int]
    quad: np.ndarray = field(repr=False, default=None)

    @property
    def label(self) -> str | None:
        if not self.rank or not self.suit:
            return None
        return f"{self.rank}{self.suit}"

    @property
    def pretty(self) -> str:
        if not self.label:
            return "?"
        return f"{self.rank}{SUIT_SYMBOL.get(self.suit, self.suit)}"

    @property
    def score(self) -> float:
        return min(self.rank_score, self.suit_score)

    def to_dict(self, region: str | None = None) -> dict:
        return {
            "label": self.label,
            "rank": self.rank,
            "suit": self.suit,
            "pretty": self.pretty,
            "score": round(self.score, 3),
            "box": list(self.box),
            "region": region,
        }


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Order four points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype("float32")
    ordered = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).ravel()
    ordered[0] = pts[np.argmin(s)]
    ordered[2] = pts[np.argmax(s)]
    ordered[1] = pts[np.argmin(diff)]
    ordered[3] = pts[np.argmax(diff)]
    return ordered


def find_card_quads(gray: np.ndarray, tuning: CardTuning) -> list[np.ndarray]:
    """Return the four-corner contours that look like cards, biggest first."""
    blur = max(1, tuning.blur | 1)  # OpenCV wants an odd kernel
    blurred = cv2.GaussianBlur(gray, (blur, blur), 0)

    # The felt is dark and the cards are light, so a threshold a bit above the
    # background level separates them without caring about the exact exposure.
    h, w = gray.shape[:2]
    background = int(np.median(blurred[::4, ::4]))
    level = min(250, background + tuning.threshold_offset)
    _, thresh = cv2.threshold(blurred, level, 255, cv2.THRESH_BINARY)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_area = float(h * w)
    quads = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if not (tuning.min_area_frac * frame_area <= area <= tuning.max_area_frac * frame_area):
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        # A card is roughly 2:3; reject squares, slivers and stray highlights.
        (_, _), (rw, rh), _ = cv2.minAreaRect(approx)
        if rw < 1 or rh < 1:
            continue
        ratio = max(rw, rh) / min(rw, rh)
        if not 1.15 <= ratio <= 2.1:
            continue
        quads.append(approx)
    quads.sort(key=cv2.contourArea, reverse=True)
    return quads


def warp_card(gray: np.ndarray, quad: np.ndarray) -> np.ndarray:
    """Flatten a card contour into an upright CARD_W x CARD_H grayscale image."""
    corners = order_corners(quad)
    (tl, tr, br, bl) = corners
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    if width > height:
        # The card is lying on its side - rotate the corners so it stands up.
        corners = np.array([tr, br, bl, tl], dtype="float32")
    dst = np.array(
        [[0, 0], [CARD_W - 1, 0], [CARD_W - 1, CARD_H - 1], [0, CARD_H - 1]], dtype="float32"
    )
    matrix = cv2.getPerspectiveTransform(corners, dst)
    return cv2.warpPerspective(gray, matrix, (CARD_W, CARD_H))


def _largest_symbol(binary: np.ndarray, size: tuple[int, int]) -> np.ndarray | None:
    """Crop the biggest blob in `binary` and scale it to `size`."""
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 40:
        return None
    x, y, w, h = cv2.boundingRect(contour)
    if w < 4 or h < 6:
        return None
    return cv2.resize(binary[y : y + h, x : x + w], size, interpolation=cv2.INTER_AREA)


def corner_symbols(card: np.ndarray) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Pull the rank and suit images out of a flattened card's top-left corner."""
    corner = card[0:CORNER_H, 0:CORNER_W]
    zoomed = cv2.resize(corner, (0, 0), fx=ZOOM, fy=ZOOM, interpolation=cv2.INTER_CUBIC)
    # The corner is mostly white card stock; anything clearly darker is ink.
    white = int(np.percentile(zoomed, 90))
    level = max(30, white - 60)
    _, binary = cv2.threshold(zoomed, level, 255, cv2.THRESH_BINARY_INV)

    split = int(binary.shape[0] * 0.58)
    rank = _largest_symbol(binary[0:split, :], RANK_SIZE)
    suit = _largest_symbol(binary[split:, :], SUIT_SIZE)
    return rank, suit


class TemplateLibrary:
    """Rank and suit reference images, captured once from the real deck."""

    def __init__(self, ranks: dict[str, np.ndarray], suits: dict[str, np.ndarray]):
        self.ranks = ranks
        self.suits = suits

    @property
    def ready(self) -> bool:
        return bool(self.ranks) and bool(self.suits)

    @property
    def missing(self) -> list[str]:
        missing = [r for r in RANKS if r not in self.ranks]
        missing += [SUIT_SYMBOL[s] for s in SUITS if s not in self.suits]
        return missing

    @classmethod
    def load(cls, directory: str | Path) -> "TemplateLibrary":
        directory = Path(directory)
        return cls(cls._load_dir(directory / "ranks", RANK_FILENAME), cls._load_dir(directory / "suits"))

    @staticmethod
    def _load_dir(directory: Path, aliases: dict[str, str] | None = None) -> dict[str, np.ndarray]:
        reverse = {v: k for k, v in (aliases or {}).items()}
        out: dict[str, np.ndarray] = {}
        if not directory.exists():
            return out
        for path in sorted(directory.glob("*.png")):
            image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            if image is None:
                continue
            out[reverse.get(path.stem, path.stem)] = image
        return out

    @staticmethod
    def save(directory: str | Path, kind: str, label: str, image: np.ndarray) -> Path:
        directory = Path(directory) / kind
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{RANK_FILENAME.get(label, label)}.png"
        cv2.imwrite(str(path), image)
        return path

    def match(self, image: np.ndarray | None, kind: str) -> tuple[str | None, float]:
        """Best matching label plus a 0..1 confidence (1 = pixel-perfect)."""
        library = self.ranks if kind == "ranks" else self.suits
        if image is None or not library:
            return None, 0.0
        best_label, best_diff = None, 1.0
        for label, template in library.items():
            if template.shape != image.shape:
                template = cv2.resize(template, (image.shape[1], image.shape[0]))
            diff = float(np.count_nonzero(cv2.absdiff(image, template) > 96)) / image.size
            if diff < best_diff:
                best_label, best_diff = label, diff
        return best_label, 1.0 - best_diff


class CardReader:
    """Finds cards in a frame and names them."""

    def __init__(self, tuning: CardTuning, templates: TemplateLibrary):
        self.tuning = tuning
        self.templates = templates

    def read(self, frame: np.ndarray) -> list[DetectedCard]:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        cards = []
        for quad in find_card_quads(gray, self.tuning):
            card = warp_card(gray, quad)
            rank_img, suit_img = corner_symbols(card)
            rank, rank_score = self.templates.match(rank_img, "ranks")
            suit, suit_score = self.templates.match(suit_img, "suits")
            limit = 1.0 - self.tuning.match_max_diff
            if rank_score < limit:
                rank, rank_score = None, rank_score
            if suit_score < limit:
                suit, suit_score = None, suit_score
            x, y, w, h = cv2.boundingRect(quad)
            cards.append(
                DetectedCard(
                    rank=rank,
                    suit=suit,
                    rank_score=rank_score,
                    suit_score=suit_score,
                    center=(x + w // 2, y + h // 2),
                    box=(x, y, w, h),
                    quad=quad,
                )
            )
        cards.sort(key=lambda c: c.center[0])
        return cards


class CardTracker:
    """Smooths per-frame readings so a flicker never becomes a wrong card.

    Detections are bucketed by position on the table, and a card is only
    reported once the same label wins several frames in a row.
    """

    def __init__(self, tuning: CardTuning, cell: int = 60):
        self.tuning = tuning
        self.cell = cell
        self.history: dict[tuple[int, int], deque] = {}
        self.revealed: list[str] = []

    def _key(self, card: DetectedCard) -> tuple[int, int]:
        return (card.center[0] // self.cell, card.center[1] // self.cell)

    def update(self, cards: list[DetectedCard]) -> list[DetectedCard]:
        seen = set()
        stable: list[DetectedCard] = []
        for card in cards:
            key = self._key(card)
            seen.add(key)
            bucket = self.history.setdefault(key, deque(maxlen=self.tuning.history))
            bucket.append(card.label)
            label, votes = Counter(bucket).most_common(1)[0]
            if label and votes >= self.tuning.stable_frames:
                stable.append(
                    DetectedCard(
                        rank=label[:-1],
                        suit=label[-1],
                        rank_score=card.rank_score,
                        suit_score=card.suit_score,
                        center=card.center,
                        box=card.box,
                        quad=card.quad,
                    )
                )
                if label not in self.revealed:
                    self.revealed.append(label)
        for key in list(self.history):
            if key not in seen:
                self.history[key].append(None)
                if not any(self.history[key]):
                    del self.history[key]
        stable.sort(key=lambda c: c.center[0])
        return stable

    def reset(self) -> None:
        """Start a fresh hand: forget everything that was revealed."""
        self.history.clear()
        self.revealed.clear()
