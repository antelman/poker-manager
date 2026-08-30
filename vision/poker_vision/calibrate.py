"""One-time setup: teaching the script your deck, your chips and your table.

Three jobs, all of them interactive except where a headless flag is offered:

* `learn_cards`   - capture a template image per rank and per suit
* `sample_chip_color` / `calibrate_chips` - what each chip colour looks like and is worth
* `define_regions` - which part of the frame belongs to which seat
"""

from __future__ import annotations

from pathlib import Path

import cv2

from . import synthetic
from .cards import RANKS, SUIT_SYMBOL, SUITS, TemplateLibrary, corner_symbols, find_card_quads, warp_card
from .chips import _sample_hsv
from .config import ChipColor, Region, TableConfig, save_config, to_cents

ESC = 27


def _biggest_card(frame, tuning):
    """The largest card-shaped thing in the frame, flattened, or None."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    quads = find_card_quads(gray, tuning)
    if not quads:
        return None, None
    return warp_card(gray, quads[0]), quads[0]


def learn_cards(source, template_dir: str | Path, config: TableConfig) -> int:
    """Walk through the 13 ranks and 4 suits, capturing a template for each.

    Hold one card at a time in front of the camera, flat and well lit, and press
    SPACE when the green outline sits on it. 's' skips, 'q' stops.
    """
    template_dir = Path(template_dir)
    tasks = [("ranks", r, f"קלף עם הערך {r}") for r in RANKS]
    tasks += [("suits", s, f"קלף בסדרה {SUIT_SYMBOL[s]}") for s in SUITS]

    frames = source.frames()
    saved = 0
    index = 0
    print("\nלמידת קלפים: SPACE לצילום, s לדילוג, q ליציאה\n")
    while index < len(tasks):
        kind, label, hint = tasks[index]
        frame = next(frames, None)
        if frame is None:
            break
        card, quad = _biggest_card(frame, config.cards)
        preview = frame.copy()
        if quad is not None:
            cv2.drawContours(preview, [quad], -1, (120, 220, 140), 2)
        cv2.putText(preview, f"{kind[:-1]} {label}  ({index + 1}/{len(tasks)})", (12, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (120, 220, 140), 2)
        cv2.imshow("learn-cards", preview)
        key = cv2.waitKey(30) & 0xFF

        if key in (ord("q"), ESC):
            break
        if key == ord("s"):
            index += 1
            continue
        if key == ord(" "):
            if card is None:
                print(f"  לא זוהה קלף בפריים - {hint}")
                continue
            rank_img, suit_img = corner_symbols(card)
            image = rank_img if kind == "ranks" else suit_img
            if image is None:
                print("  לא הצלחתי לקרוא את הפינה - נסה תאורה טובה יותר או קרב את הקלף")
                continue
            path = TemplateLibrary.save(template_dir, kind, label, image)
            print(f"  נשמר {label} -> {path}")
            saved += 1
            index += 1
    cv2.destroyAllWindows()
    return saved


def learn_from_demo(template_dir: str | Path, config: TableConfig) -> int:
    """Build templates from the drawn demo deck - no camera, no keystrokes."""
    template_dir = Path(template_dir)
    saved = 0
    for kind, labels, suit_of, rank_of in (
        ("ranks", RANKS, lambda label: "s", lambda label: label),
        ("suits", SUITS, lambda label: label, lambda label: "A"),
    ):
        for label in labels:
            frame = synthetic.render_table([(rank_of(label), suit_of(label))])
            card, _ = _biggest_card(frame, config.cards)
            if card is None:
                continue
            rank_img, suit_img = corner_symbols(card)
            image = rank_img if kind == "ranks" else suit_img
            if image is None:
                continue
            TemplateLibrary.save(template_dir, kind, label, image)
            saved += 1
    return saved


def sample_chip_color(frame, point: tuple[int, int], name: str, value, radius: int = 14) -> ChipColor:
    """Read the colour of the chip under `point` and tag it with a value."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    h, s, v = _sample_hsv(hsv, point, radius * 2)
    return ChipColor(name=name, value_cents=to_cents(value), h=h, s=s, v=v)


def add_chip_color(config: TableConfig, color: ChipColor) -> TableConfig:
    """Add or replace a colour by name, keeping the config tidy."""
    config.chip_colors = [c for c in config.chip_colors if c.name != color.name]
    config.chip_colors.append(color)
    config.chip_colors.sort(key=lambda c: c.value_cents)
    return config


def calibrate_chips(source, config: TableConfig, config_path) -> TableConfig:
    """Click a chip, type its name and value in the terminal, repeat.

    Existing colours are replaced by name, so re-clicking "אדום" under new
    lighting just updates it.
    """
    clicked: list[tuple[int, int]] = []

    def on_mouse(event, x, y, flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            clicked.append((x, y))

    cv2.namedWindow("calibrate-chips")
    cv2.setMouseCallback("calibrate-chips", on_mouse)
    print("\nכיול ז'יטונים: לחץ על ז'יטון בתמונה והזן שם וערך. q ליציאה\n")

    for frame in source.frames():
        preview = frame.copy()
        for i, color in enumerate(config.chip_colors):
            cv2.putText(preview, f"{i + 1}. {color.value_cents / 100:g}", (12, 30 + i * 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (235, 242, 237), 1)
        cv2.imshow("calibrate-chips", preview)
        key = cv2.waitKey(30) & 0xFF
        if key in (ord("q"), ESC):
            break
        while clicked:
            point = clicked.pop()
            name = input(f"שם הצבע בנקודה {point}: ").strip()
            if not name:
                continue
            value = input(f"כמה שווה ז'יטון {name}? ").strip()
            color = sample_chip_color(frame, point, name, value)
            add_chip_color(config, color)
            save_config(config, config_path)
            print(f"  נשמר: {name} = {color.value_cents / 100:g} {config.unit}  HSV={color.h:.0f},{color.s:.0f},{color.v:.0f}")
    cv2.destroyAllWindows()
    return config


def define_regions(source, config: TableConfig, config_path) -> TableConfig:
    """Drag a rectangle per seat, name it in the terminal. 'c' clears them all."""
    drag: dict = {"start": None, "end": None, "done": None}

    def on_mouse(event, x, y, flags, _param):
        if event == cv2.EVENT_LBUTTONDOWN:
            drag["start"], drag["end"] = (x, y), (x, y)
        elif event == cv2.EVENT_MOUSEMOVE and drag["start"]:
            drag["end"] = (x, y)
        elif event == cv2.EVENT_LBUTTONUP and drag["start"]:
            drag["done"] = (drag["start"], (x, y))
            drag["start"] = drag["end"] = None

    cv2.namedWindow("regions")
    cv2.setMouseCallback("regions", on_mouse)
    print("\nהגדרת אזורים: גרור מלבן, הזן שם וסוג (player/board/pot). c לניקוי, q ליציאה\n")

    for frame in source.frames():
        height, width = frame.shape[:2]
        preview = frame.copy()
        for region in config.regions:
            x, y, w, h = region.rect(width, height)
            cv2.rectangle(preview, (x, y), (x + w, y + h), (120, 220, 140), 2)
        if drag["start"] and drag["end"]:
            cv2.rectangle(preview, drag["start"], drag["end"], (60, 200, 250), 1)
        cv2.imshow("regions", preview)
        key = cv2.waitKey(30) & 0xFF
        if key in (ord("q"), ESC):
            break
        if key == ord("c"):
            config.regions = []
            save_config(config, config_path)
            print("  כל האזורים נמחקו")
        if drag["done"]:
            (x0, y0), (x1, y1) = drag["done"]
            drag["done"] = None
            if abs(x1 - x0) < 10 or abs(y1 - y0) < 10:
                continue
            name = input("שם האזור (שם שחקן / board / pot): ").strip()
            if not name:
                continue
            kind = input("סוג [player]: ").strip() or "player"
            config.regions.append(rect_to_region(name, kind, (x0, y0, x1, y1), (width, height)))
            save_config(config, config_path)
            print(f"  נשמר אזור {name} ({kind})")
    cv2.destroyAllWindows()
    return config


def rect_to_region(name: str, kind: str, rect: tuple[int, int, int, int], size: tuple[int, int]) -> Region:
    """Turn a pixel rectangle into a normalised region."""
    x0, y0, x1, y1 = rect
    width, height = size
    x0, x1 = sorted((max(0, x0), min(width, x1)))
    y0, y1 = sorted((max(0, y0), min(height, y1)))
    return Region(name=name, kind=kind, x=x0 / width, y=y0 / height, w=(x1 - x0) / width, h=(y1 - y0) / height)
