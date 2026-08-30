#!/usr/bin/env python3
"""Live poker table camera: reads the cards on the table and the chips bet.

    python3 vision/table_vision.py live                 # default webcam
    python3 vision/table_vision.py live --source demo   # no camera needed
    python3 vision/table_vision.py learn-cards          # teach it your deck
    python3 vision/table_vision.py calibrate-chips      # colour -> value
    python3 vision/table_vision.py regions              # betting areas
    python3 vision/table_vision.py selftest             # check the install

The live command prints every change to the terminal and can mirror the state
into a JSON file (--json-out) or serve it over HTTP (--serve 8765), which is
how the web app would read it.

Full docs: vision/README.md
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cv2  # noqa: E402

from poker_vision.calibrate import calibrate_chips, define_regions, learn_cards, learn_from_demo  # noqa: E402
from poker_vision.cards import CardReader, CardTracker, TemplateLibrary  # noqa: E402
from poker_vision.chips import ChipTracker, find_chips, summarize  # noqa: E402
from poker_vision.config import (  # noqa: E402
    DEFAULT_CONFIG_PATH,
    DEFAULT_STATE_PATH,
    DEFAULT_TEMPLATE_DIR,
    from_cents,
    load_config,
    save_config,
)
from poker_vision.overlay import draw  # noqa: E402
from poker_vision.source import FrameSource, has_display  # noqa: E402
from poker_vision.stream import StateServer, StateWriter  # noqa: E402

ESC = 27


def build_state(frame_no, size, cards, tracker, chip_summary, config) -> dict:
    """The one JSON shape everything downstream reads."""
    width, height = size
    board_regions = config.regions_of("board")

    def region_of(card):
        for region in config.regions:
            if region.contains(card.center[0], card.center[1], width, height):
                return region.name
        return None

    def on_board(card):
        if not board_regions:
            return True  # no board region configured - the whole table is one
        return any(r.contains(card.center[0], card.center[1], width, height) for r in board_regions)

    return {
        "ts": round(time.time(), 3),
        "frame": frame_no,
        "unit": config.unit,
        "cards": [c.to_dict(region_of(c)) for c in cards],
        "board": [c.label for c in cards if on_board(c)],
        "revealed": list(tracker.revealed),
        "chips": chip_summary,
    }


def state_signature(state: dict) -> str:
    """What counts as a change worth printing."""
    bets = {r["name"]: r["valueCents"] for r in state["chips"]["regions"]}
    return json.dumps([state["board"], bets], ensure_ascii=False, sort_keys=True)


def describe(state: dict) -> str:
    board = " ".join(c["pretty"] for c in state["cards"] if c["label"]) or "-"
    bets = "  ".join(
        f"{r['name']}: {from_cents(r['valueCents'])}{state['unit']}" for r in state["chips"]["regions"] if r["chips"]
    )
    stamp = time.strftime("%H:%M:%S")
    line = f"[{stamp}] קלפים: {board}"
    if bets:
        line += f" | הימורים: {bets} | סה\"כ {state['chips']['total']}{state['unit']}"
    return line


def cmd_live(args) -> int:
    config = load_config(args.config)
    templates = TemplateLibrary.load(args.templates)
    if not templates.ready:
        print(
            "אין תבניות קלפים - הקלפים יזוהו על השולחן אבל לא ייקראו.\n"
            "הרץ:  python3 vision/table_vision.py learn-cards\n",
            file=sys.stderr,
        )
    elif templates.missing:
        print(f"חסרות תבניות: {' '.join(templates.missing)}", file=sys.stderr)

    reader = CardReader(config.cards, templates)
    card_tracker = CardTracker(config.cards)
    chip_tracker = ChipTracker(config.chips)

    writer = StateWriter(args.json_out) if args.json_out else None
    server = StateServer(args.serve).start() if args.serve else None
    if server:
        print(f"מצב חי: {server.url}")

    window = not args.no_window and has_display()
    if not args.no_window and not window:
        print("אין תצוגה גרפית - ממשיך בלי חלון וידאו", file=sys.stderr)

    last_signature = None
    frame_no = 0
    state: dict = {}
    with FrameSource(args.source, width=args.width, height=args.height, fps=args.fps) as source:
        for frame in source.frames(limit=args.max_frames):
            frame_no += 1
            height, width = frame.shape[:2]
            seen = reader.read(frame)
            cards = card_tracker.update(seen)
            chips = find_chips(frame, config, exclude_boxes=[c.box for c in seen])
            chip_summary = chip_tracker.update(summarize(chips, config, (width, height)))
            state = build_state(frame_no, (width, height), cards, card_tracker, chip_summary, config)

            signature = state_signature(state)
            if signature != last_signature:
                last_signature = signature
                if not args.quiet:
                    print(describe(state), flush=True)
                if writer:
                    writer.write(state)
            if server:
                server.publish(state)

            if window:
                hud = [f"frame {frame_no}", "q=exit  r=new hand  s=snapshot"]
                cv2.imshow("poker table", draw(frame, cards, chips, chip_summary, config, hud))
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ESC):
                    break
                if key == ord("r"):
                    card_tracker.reset()
                    print("--- יד חדשה ---")
                if key == ord("s"):
                    path = Path(args.snapshot_dir) / f"snapshot-{int(time.time())}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    cv2.imwrite(str(path), frame)
                    print(f"נשמר צילום מסך: {path}")

    if window:
        cv2.destroyAllWindows()
    if server:
        server.stop()
    if writer and state:
        writer.write(state)
    return 0


def cmd_learn_cards(args) -> int:
    config = load_config(args.config)
    if args.source == "demo":
        saved = learn_from_demo(args.templates, config)
    else:
        with FrameSource(args.source, width=args.width, height=args.height) as source:
            saved = learn_cards(source, args.templates, config)
    print(f"\nנשמרו {saved} תבניות ב-{args.templates}")
    return 0


def cmd_calibrate_chips(args) -> int:
    config = load_config(args.config)
    if args.at:
        # Headless path: sample a point on a still frame, no window needed.
        from poker_vision.calibrate import add_chip_color, sample_chip_color

        if not (args.name and args.value is not None):
            print("צריך גם --name וגם --value יחד עם --at", file=sys.stderr)
            return 2
        x, y = (int(n) for n in args.at.split(","))
        with FrameSource(args.source, width=args.width, height=args.height) as source:
            frame = next(source.frames(limit=1))
        color = sample_chip_color(frame, (x, y), args.name, args.value)
        add_chip_color(config, color)
        save_config(config, args.config)
        print(f"נשמר: {color.name} = {color.value_cents / 100:g} {config.unit}  HSV={color.h:.0f},{color.s:.0f},{color.v:.0f}")
        return 0

    with FrameSource(args.source, width=args.width, height=args.height) as source:
        calibrate_chips(source, config, args.config)
    return 0


def cmd_regions(args) -> int:
    config = load_config(args.config)
    if args.add:
        from poker_vision.config import Region

        for spec in args.add:
            name, kind, box = spec.split(":", 2)
            x, y, w, h = (float(n) for n in box.split(","))
            config.regions = [r for r in config.regions if r.name != name]
            config.regions.append(Region(name=name, kind=kind, x=x, y=y, w=w, h=h))
        save_config(config, args.config)
        print(f"נשמרו {len(config.regions)} אזורים ב-{args.config}")
        return 0
    if args.clear:
        config.regions = []
        save_config(config, args.config)
        print("כל האזורים נמחקו")
        return 0
    with FrameSource(args.source, width=args.width, height=args.height) as source:
        define_regions(source, config, args.config)
    return 0


def cmd_selftest(args) -> int:
    """Run the whole pipeline on the drawn demo table - no camera involved."""
    import tempfile

    config = load_config(args.config)
    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        learned = learn_from_demo(tmp, config)
        if learned != 17:
            problems.append(f"נלמדו {learned} תבניות במקום 17")
        templates = TemplateLibrary.load(tmp)
        reader = CardReader(config.cards, templates)
        tracker = CardTracker(config.cards)

        from poker_vision.synthetic import render_table

        expected = [("A", "s"), ("K", "h"), ("7", "d"), ("10", "c"), ("Q", "s")]
        frame = render_table(expected, [(180, 520, "אדום"), (760, 520, "ירוק")])
        cards = []
        for _ in range(config.cards.stable_frames + 1):
            cards = tracker.update(reader.read(frame))
        labels = [c.label for c in cards]
        wanted = [f"{r}{s}" for r, s in expected]
        print(f"קלפים שזוהו: {' '.join(labels) or '-'}   (ציפייה: {' '.join(wanted)})")
        if labels != wanted:
            problems.append("זיהוי הקלפים בדמו לא תואם")

        height, width = frame.shape[:2]
        chips = find_chips(frame, config, exclude_boxes=[c.box for c in reader.read(frame)])
        summary = summarize(chips, config, (width, height))
        print(f"ז'יטונים שזוהו: {len(chips)}, שווי {summary['total']} {config.unit}, לא מזוהים {summary['unknown']}")
        if len(chips) < 2:
            problems.append("לא זוהו שני הז'יטונים בדמו")

    if problems:
        print("\nבעיות:\n- " + "\n- ".join(problems))
        return 1
    print("\nהכול עובד ✔")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, source_default="0"):
        p.add_argument("--source", default=source_default, help="מספר מצלמה (0), נתיב לתמונה/וידאו, או demo")
        p.add_argument("--config", default=str(DEFAULT_CONFIG_PATH), help="קובץ הגדרות השולחן")
        p.add_argument("--templates", default=str(DEFAULT_TEMPLATE_DIR), help="תיקיית תבניות הקלפים")
        p.add_argument("--width", type=int, default=None, help="רוחב פריים מבוקש")
        p.add_argument("--height", type=int, default=None, help="גובה פריים מבוקש")
        return p

    live = common(sub.add_parser("live", help="קריאה חיה מהמצלמה"))
    live.add_argument("--json-out", nargs="?", const=str(DEFAULT_STATE_PATH), default=None, help="שמירת המצב לקובץ JSON")
    live.add_argument("--serve", type=int, default=None, metavar="PORT", help="הגשת המצב ב-HTTP")
    live.add_argument("--no-window", action="store_true", help="בלי חלון וידאו")
    live.add_argument("--quiet", action="store_true", help="בלי הדפסות לטרמינל")
    live.add_argument("--fps", type=float, default=0.0, help="הגבלת קצב פריימים")
    live.add_argument("--max-frames", type=int, default=None, help="עצירה אחרי N פריימים")
    live.add_argument("--snapshot-dir", default=str(DEFAULT_STATE_PATH.parent), help="לאן לשמור צילומי מסך")
    live.set_defaults(func=cmd_live)

    learn = common(sub.add_parser("learn-cards", help="לימוד הערכים והסדרות מהחפיסה שלך"))
    learn.set_defaults(func=cmd_learn_cards)

    chips = common(sub.add_parser("calibrate-chips", help="הגדרת צבע ושווי לכל ז'יטון"))
    chips.add_argument("--at", default=None, metavar="X,Y", help="דגימה בנקודה מסוימת בלי חלון")
    chips.add_argument("--name", default=None, help="שם הצבע (עם --at)")
    chips.add_argument("--value", default=None, help="שווי ז'יטון (עם --at)")
    chips.set_defaults(func=cmd_calibrate_chips)

    regions = common(sub.add_parser("regions", help="סימון אזורי ההימור של השחקנים"))
    regions.add_argument("--add", action="append", metavar="NAME:KIND:X,Y,W,H", help="הוספת אזור בלי חלון (יחסי 0..1)")
    regions.add_argument("--clear", action="store_true", help="מחיקת כל האזורים")
    regions.set_defaults(func=cmd_regions)

    test = common(sub.add_parser("selftest", help="בדיקה מקצה לקצה בלי מצלמה"), source_default="demo")
    test.set_defaults(func=cmd_selftest)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except RuntimeError as err:
        print(f"שגיאה: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
