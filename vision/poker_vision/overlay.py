"""Drawing the detector's opinion back onto the frame.

OpenCV's built-in font has no Hebrew, so region names are drawn as P1, P2 ...
and the full names appear in the JSON output and in the terminal log.
"""

from __future__ import annotations

import cv2

from .config import Region, TableConfig, from_cents

GREEN = (120, 220, 140)
AMBER = (60, 200, 250)
GREY = (170, 170, 170)
DARK = (25, 30, 25)


def _tag(regions: list[Region], region: Region) -> str:
    kinds = {"board": "BOARD", "pot": "POT"}
    if region.kind in kinds:
        return kinds[region.kind]
    players = [r for r in regions if r.kind == "player"]
    return f"P{players.index(region) + 1}" if region in players else "?"


def draw(frame, cards, chips, summary, config: TableConfig, hud: list[str] | None = None):
    """Annotate a copy of `frame` with regions, cards, chips and a HUD."""
    canvas = frame.copy()
    height, width = canvas.shape[:2]

    for region in config.regions:
        x, y, w, h = region.rect(width, height)
        cv2.rectangle(canvas, (x, y), (x + w, y + h), GREY, 1)
        # Bottom-left of the box, so the HUD bar at the top never covers it.
        cv2.putText(canvas, _tag(config.regions, region), (x + 4, y + h - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, GREY, 1)

    for card in cards:
        x, y, w, h = card.box
        cv2.drawContours(canvas, [card.quad], -1, GREEN, 2)
        label = card.label or "?"
        cv2.putText(canvas, label, (x, max(18, y - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, GREEN, 2)

    for chip in chips:
        color = GREEN if chip.color else AMBER
        cv2.circle(canvas, chip.center, chip.radius, color, 2)
        if chip.color:
            text = from_cents(chip.color.value_cents)
            cv2.putText(canvas, text, (chip.center[0] - 10, chip.center[1] + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)

    lines = list(hud or [])
    board = " ".join(c.label for c in cards if c.label) or "-"
    lines.append(f"cards: {board}")
    lines.append(f"chips: {summary['total']} {config.unit}  ({summary['unknown']} unknown)")

    cv2.rectangle(canvas, (0, 0), (width, 22 * len(lines) + 10), DARK, -1)
    for i, line in enumerate(lines):
        cv2.putText(canvas, line, (10, 20 + i * 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (235, 242, 237), 1)
    return canvas
