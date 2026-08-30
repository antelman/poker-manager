"""Tests for the table camera, run against drawn frames instead of hardware.

    python3 -m unittest discover -s vision/tests -t vision
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poker_vision.calibrate import add_chip_color, learn_from_demo, rect_to_region, sample_chip_color
from poker_vision.cards import CardReader, CardTracker, TemplateLibrary
from poker_vision.chips import ChipTracker, find_chips, summarize
from poker_vision.config import Region, TableConfig, default_config, from_cents, to_cents
from poker_vision.synthetic import render_table

BOARD = [("A", "s"), ("K", "h"), ("7", "d"), ("10", "c"), ("Q", "s")]


class MoneyTest(unittest.TestCase):
    def test_round_trip(self):
        self.assertEqual(to_cents(12.5), 1250)
        self.assertEqual(from_cents(1250), "12.50")
        self.assertEqual(from_cents(5000), "50")
        self.assertEqual(from_cents(-250), "-2.50")

    def test_bad_input_is_zero(self):
        self.assertEqual(to_cents("שלום"), 0)
        self.assertEqual(to_cents(None), 0)


class ConfigTest(unittest.TestCase):
    def test_survives_a_json_round_trip(self):
        config = default_config()
        config.regions.append(Region("דני", "player", 0.1, 0.7, 0.3, 0.2))
        clone = TableConfig.from_dict(config.to_dict())
        self.assertEqual([c.name for c in clone.chip_colors], [c.name for c in config.chip_colors])
        self.assertEqual(clone.chip_colors[0].value_cents, config.chip_colors[0].value_cents)
        self.assertEqual(clone.regions[0].name, "דני")
        self.assertEqual(clone.chips.param2, config.chips.param2)

    def test_colour_matching_ignores_hue_for_greys(self):
        config = default_config()
        self.assertEqual(config.color_for(30, 20, 230).name, "לבן")
        self.assertEqual(config.color_for(120, 15, 40).name, "שחור")

    def test_far_off_colour_is_unknown(self):
        self.assertIsNone(default_config().color_for(140, 255, 255))

    def test_region_contains(self):
        region = Region("דני", "player", 0.0, 0.5, 0.5, 0.5)
        self.assertTrue(region.contains(10, 400, 800, 600))
        self.assertFalse(region.contains(700, 400, 800, 600))


class CardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = default_config()
        cls.tmp = tempfile.TemporaryDirectory()
        learn_from_demo(cls.tmp.name, cls.config)
        cls.templates = TemplateLibrary.load(cls.tmp.name)
        cls.reader = CardReader(cls.config.cards, cls.templates)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_every_rank_and_suit_was_learned(self):
        self.assertTrue(self.templates.ready)
        self.assertEqual(self.templates.missing, [])

    def test_reads_a_full_board_left_to_right(self):
        cards = self.reader.read(render_table(BOARD))
        self.assertEqual([c.label for c in cards], ["As", "Kh", "7d", "10c", "Qs"])
        self.assertTrue(all(c.score > 0.9 for c in cards))

    def test_reads_a_tilted_card(self):
        cards = self.reader.read(render_table([("Q", "h")], angle=8))
        self.assertEqual([c.label for c in cards], ["Qh"])

    def test_empty_table_reads_nothing(self):
        self.assertEqual(self.reader.read(render_table([])), [])

    def test_without_templates_cards_are_found_but_unnamed(self):
        blind = CardReader(self.config.cards, TemplateLibrary({}, {}))
        cards = blind.read(render_table(BOARD))
        self.assertEqual(len(cards), 5)
        self.assertTrue(all(c.label is None for c in cards))

    def test_tracker_waits_for_a_stable_reading(self):
        tracker = CardTracker(self.config.cards)
        frame = render_table(BOARD[:3])
        reads = [tracker.update(self.reader.read(frame)) for _ in range(self.config.cards.stable_frames)]
        self.assertEqual(reads[0], [])  # one frame is never enough
        self.assertEqual([c.label for c in reads[-1]], ["As", "Kh", "7d"])
        self.assertEqual(tracker.revealed, ["As", "Kh", "7d"])

    def test_tracker_remembers_the_hand_until_reset(self):
        tracker = CardTracker(self.config.cards)
        for _ in range(self.config.cards.stable_frames):
            tracker.update(self.reader.read(render_table(BOARD[:3])))
        for _ in range(self.config.cards.history + 1):
            tracker.update([])
        self.assertEqual(tracker.revealed, ["As", "Kh", "7d"])
        tracker.reset()
        self.assertEqual(tracker.revealed, [])


class ChipTest(unittest.TestCase):
    def setUp(self):
        self.config = default_config()
        self.config.regions = [
            Region("דני", "player", 0.0, 0.7, 0.45, 0.3),
            Region("יוסי", "player", 0.55, 0.7, 0.45, 0.3),
        ]
        self.chips = [(180, 520, "אדום"), (240, 520, "אדום"), (700, 520, "כחול"), (760, 520, "ירוק")]
        self.frame = render_table(BOARD[:3], self.chips)

    def _summary(self):
        cards = CardReader(self.config.cards, TemplateLibrary({}, {})).read(self.frame)
        found = find_chips(self.frame, self.config, exclude_boxes=[c.box for c in cards])
        height, width = self.frame.shape[:2]
        return found, summarize(found, self.config, (width, height))

    def test_finds_every_chip_and_no_card_pips(self):
        found, summary = self._summary()
        self.assertEqual(len(found), len(self.chips))
        self.assertEqual(summary["unknown"], 0)

    def test_values_add_up_per_player(self):
        _, summary = self._summary()
        by_name = {r["name"]: r for r in summary["regions"]}
        self.assertEqual(by_name["דני"]["valueCents"], to_cents(10))  # 5 + 5
        self.assertEqual(by_name["יוסי"]["valueCents"], to_cents(35))  # 10 + 25
        self.assertEqual(summary["totalCents"], to_cents(45))
        self.assertEqual(summary["total"], "45")
        self.assertEqual(by_name["דני"]["counts"], {"אדום": 2})

    def test_chips_outside_a_region_land_in_the_leftovers(self):
        self.config.regions = [Region("דני", "player", 0.0, 0.7, 0.45, 0.3)]
        _, summary = self._summary()
        kinds = {r["kind"] for r in summary["regions"]}
        self.assertIn("loose", kinds)
        self.assertEqual(summary["totalCents"], to_cents(45))

    def test_tracker_holds_a_bet_until_it_settles(self):
        tracker = ChipTracker(self.config.chips)
        _, summary = self._summary()
        first = tracker.update(summary)
        self.assertEqual(first["totalCents"], 0)  # one frame is not a bet yet
        for _ in range(self.config.chips.stable_frames):
            settled = tracker.update(summary)
        self.assertEqual(settled["totalCents"], to_cents(45))


class CalibrationTest(unittest.TestCase):
    def test_sampling_a_chip_produces_a_matching_colour(self):
        frame = render_table([], [(400, 400, "אדום")])
        color = sample_chip_color(frame, (400, 400), "אדום כהה", 5)
        self.assertEqual(color.value_cents, 500)
        config = add_chip_color(TableConfig(), color)
        self.assertEqual(config.color_for(color.h, color.s, color.v).name, "אדום כהה")

    def test_adding_a_colour_replaces_the_same_name(self):
        config = default_config()
        before = len(config.chip_colors)
        add_chip_color(config, sample_chip_color(render_table([], [(400, 400, "ירוק")]), (400, 400), "ירוק", 50))
        self.assertEqual(len(config.chip_colors), before)
        self.assertEqual([c for c in config.chip_colors if c.name == "ירוק"][0].value_cents, 5000)

    def test_rect_to_region_normalises(self):
        region = rect_to_region("דני", "player", (100, 300, 500, 600), (1000, 600))
        self.assertAlmostEqual(region.x, 0.1)
        self.assertAlmostEqual(region.w, 0.4)
        self.assertAlmostEqual(region.y, 0.5)
        self.assertAlmostEqual(region.h, 0.5)


if __name__ == "__main__":
    unittest.main()
