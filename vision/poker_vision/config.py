"""Table configuration: chip colours, camera regions and detector tuning.

Everything the camera scripts need lives in one JSON file (``vision/config.json``
by default) so a table can be re-calibrated without touching code.

Money is kept in integer cents, exactly like ``src/engine.js`` does it, so that
counting a pile of chips never drifts on floating point.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

VISION_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = VISION_DIR / "config.json"
DEFAULT_TEMPLATE_DIR = VISION_DIR / "data" / "templates"
DEFAULT_STATE_PATH = VISION_DIR / "data" / "state.json"


def to_cents(amount) -> int:
    """Turn a user-entered amount (5 or 12.5) into integer cents."""
    try:
        return int(round(float(amount) * 100))
    except (TypeError, ValueError):
        return 0


def from_cents(cents) -> str:
    """Format integer cents for display: 5000 -> "50", 1250 -> "12.50"."""
    n = int(cents or 0)
    sign = "-" if n < 0 else ""
    whole, frac = divmod(abs(n), 100)
    return f"{sign}{whole}" if frac == 0 else f"{sign}{whole}.{frac:02d}"


@dataclass
class ChipColor:
    """One chip colour and what it is worth.

    ``h``/``s``/``v`` are the OpenCV HSV values sampled from a real chip during
    calibration (hue 0-179, saturation and value 0-255).
    """

    name: str
    value_cents: int
    h: float
    s: float
    v: float
    max_distance: float = 45.0

    def distance(self, h: float, s: float, v: float) -> float:
        """Weighted HSV distance between this colour and a sampled chip."""
        dh = abs(h - self.h)
        dh = min(dh, 180 - dh) * 2  # back to degrees on the colour wheel
        # White, grey and black chips have no meaningful hue - only compare
        # brightness there, otherwise camera noise flips them at random.
        if self.s < 60 and s < 60:
            dh = 0.0
        ds = abs(s - self.s)
        dv = abs(v - self.v)
        return math.sqrt((dh * 0.8) ** 2 + (ds * 0.7) ** 2 + (dv * 0.5) ** 2)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "value": round(self.value_cents / 100, 2),
            "hsv": [round(self.h, 1), round(self.s, 1), round(self.v, 1)],
            "maxDistance": self.max_distance,
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "ChipColor":
        hsv = raw.get("hsv") or [0, 0, 0]
        value_cents = raw["valueCents"] if "valueCents" in raw else to_cents(raw.get("value", 0))
        return cls(
            name=raw.get("name", "?"),
            value_cents=int(value_cents),
            h=float(hsv[0]),
            s=float(hsv[1]),
            v=float(hsv[2]),
            max_distance=float(raw.get("maxDistance", 45.0)),
        )


@dataclass
class Region:
    """A rectangle on the table, in normalised 0..1 frame coordinates.

    ``kind`` is one of ``board`` (community cards), ``player`` (a seat's betting
    area) or ``pot`` (the middle of the table).
    """

    name: str
    kind: str = "player"
    x: float = 0.0
    y: float = 0.0
    w: float = 1.0
    h: float = 1.0

    def rect(self, width: int, height: int) -> tuple[int, int, int, int]:
        x = int(round(self.x * width))
        y = int(round(self.y * height))
        return x, y, int(round(self.w * width)), int(round(self.h * height))

    def contains(self, px: float, py: float, width: int, height: int) -> bool:
        x, y, w, h = self.rect(width, height)
        return x <= px <= x + w and y <= py <= y + h

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "w": round(self.w, 4),
            "h": round(self.h, 4),
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "Region":
        return cls(
            name=raw.get("name", "?"),
            kind=raw.get("kind", "player"),
            x=float(raw.get("x", 0.0)),
            y=float(raw.get("y", 0.0)),
            w=float(raw.get("w", 1.0)),
            h=float(raw.get("h", 1.0)),
        )


@dataclass
class CardTuning:
    """Knobs for the card detector. Fractions are of the whole frame area."""

    min_area_frac: float = 0.004
    max_area_frac: float = 0.30
    threshold_offset: int = 40
    blur: int = 5
    match_max_diff: float = 0.42
    stable_frames: int = 4
    history: int = 8

    @classmethod
    def from_dict(cls, raw: dict) -> "CardTuning":
        return cls(**{k: v for k, v in _camel_to_snake(raw).items() if k in cls.__annotations__})

    def to_dict(self) -> dict:
        return _snake_to_camel(self.__dict__)


@dataclass
class ChipTuning:
    """Knobs for the chip detector. Radii are fractions of the frame width."""

    min_radius_frac: float = 0.012
    max_radius_frac: float = 0.060
    min_dist_frac: float = 0.030
    dp: float = 1.2
    param1: float = 110.0
    param2: float = 26.0
    uniformity_max: float = 45.0
    stable_frames: int = 3
    history: int = 6

    @classmethod
    def from_dict(cls, raw: dict) -> "ChipTuning":
        return cls(**{k: v for k, v in _camel_to_snake(raw).items() if k in cls.__annotations__})

    def to_dict(self) -> dict:
        return _snake_to_camel(self.__dict__)


@dataclass
class TableConfig:
    unit: str = "₪"
    chip_colors: list[ChipColor] = field(default_factory=list)
    regions: list[Region] = field(default_factory=list)
    cards: CardTuning = field(default_factory=CardTuning)
    chips: ChipTuning = field(default_factory=ChipTuning)

    def color_for(self, h: float, s: float, v: float) -> ChipColor | None:
        """Nearest configured chip colour, or None when nothing is close."""
        best, best_d = None, float("inf")
        for color in self.chip_colors:
            d = color.distance(h, s, v)
            if d < best_d:
                best, best_d = color, d
        if best is None or best_d > best.max_distance:
            return None
        return best

    def regions_of(self, kind: str) -> list[Region]:
        return [r for r in self.regions if r.kind == kind]

    def to_dict(self) -> dict:
        return {
            "unit": self.unit,
            "chipColors": [c.to_dict() for c in self.chip_colors],
            "regions": [r.to_dict() for r in self.regions],
            "cards": self.cards.to_dict(),
            "chips": self.chips.to_dict(),
        }

    @classmethod
    def from_dict(cls, raw: dict) -> "TableConfig":
        return cls(
            unit=raw.get("unit", "₪"),
            chip_colors=[ChipColor.from_dict(c) for c in raw.get("chipColors", [])],
            regions=[Region.from_dict(r) for r in raw.get("regions", [])],
            cards=CardTuning.from_dict(raw.get("cards", {})),
            chips=ChipTuning.from_dict(raw.get("chips", {})),
        )


def default_config() -> TableConfig:
    """A sane starting point: the usual chip colours, no regions yet.

    The HSV values are rough guesses for typical clay chips under warm light -
    run `calibrate-chips` to replace them with numbers sampled from your own set.
    """
    return TableConfig(
        chip_colors=[
            ChipColor("לבן", to_cents(1), h=20, s=25, v=225),
            ChipColor("אדום", to_cents(5), h=177, s=190, v=170),
            ChipColor("כחול", to_cents(10), h=108, s=180, v=150),
            ChipColor("ירוק", to_cents(25), h=70, s=170, v=130),
            ChipColor("שחור", to_cents(100), h=0, s=30, v=45),
        ]
    )


def load_config(path: str | Path | None = None) -> TableConfig:
    """Load the table config, falling back to the defaults when there is none."""
    path = Path(path or DEFAULT_CONFIG_PATH)
    if not path.exists():
        return default_config()
    with path.open(encoding="utf-8") as fh:
        return TableConfig.from_dict(json.load(fh))


def save_config(config: TableConfig, path: str | Path | None = None) -> Path:
    path = Path(path or DEFAULT_CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(config.to_dict(), fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    return path


def _camel_to_snake(raw: dict) -> dict:
    out = {}
    for key, value in raw.items():
        snake = "".join(f"_{ch.lower()}" if ch.isupper() else ch for ch in key)
        out[snake] = value
    return out


def _snake_to_camel(raw: dict) -> dict:
    out = {}
    for key, value in raw.items():
        head, *rest = key.split("_")
        out[head + "".join(part.title() for part in rest)] = value
    return out
