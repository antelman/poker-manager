import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CardReader,
  CardTracker,
  CARD_RANKS,
  CARD_SUITS,
  homography,
  project,
  otsuThreshold,
  resizeBitmap,
  packBits,
  unpackBits,
  matchSymbol,
} from '../src/vision.js';

import { table, tilt, rect, place, renderCard, createImage, fillCircle, fillRect, FELT, WHITE } from './helpers/table.js';

const BOARD = [
  ['A', 's'],
  ['K', 'h'],
  ['7', 'd'],
  ['10', 'c'],
  ['Q', 's'],
];

/** Teach the reader this deck once, the same way the app's wizard does. */
let learned = null;
function templates() {
  if (learned) return learned;
  const blind = new CardReader({ ranks: {}, suits: {} });
  learned = { ranks: {}, suits: {} };
  for (const rank of CARD_RANKS) {
    const image = table([[rank, 's']], { cardW: 220, y: 120 });
    learned.ranks[rank] = blind.symbols(image.data, image.width, image.height).rank;
  }
  for (const suit of CARD_SUITS) {
    const image = table([['A', suit]], { cardW: 220, y: 120 });
    learned.suits[suit] = blind.symbols(image.data, image.width, image.height).suit;
  }
  return learned;
}

const labels = (cards) => cards.map((card) => card.label);
const read = (image, options) =>
  new CardReader(templates(), options).read(image.data, image.width, image.height);

/* ------------------------------------------------------------- the geometry */

test('a homography maps each corner onto its partner exactly', () => {
  const source = rect(0, 0, 200, 300);
  const target = [
    { x: 40, y: 10 },
    { x: 260, y: 60 },
    { x: 230, y: 400 },
    { x: 10, y: 330 },
  ];
  const h = homography(source, target);
  for (let i = 0; i < 4; i++) {
    const mapped = project(h, source[i].x, source[i].y);
    assert.ok(Math.abs(mapped.x - target[i].x) < 1e-6, `corner ${i} x`);
    assert.ok(Math.abs(mapped.y - target[i].y) < 1e-6, `corner ${i} y`);
  }
});

test('otsu finds the valley between two peaks', () => {
  const hist = new Uint32Array(256);
  hist[30] = 1000;
  hist[200] = 1000;
  const threshold = otsuThreshold(hist, 2000);
  // Everything above the cut is foreground, so the dark peak has to fall on
  // or below it and the bright peak above it.
  assert.ok(threshold >= 30 && threshold < 200, `threshold was ${threshold}`);
});

/* ------------------------------------------------------------ reading cards */

test('reads a board dealt straight in front of the camera', () => {
  assert.deepEqual(labels(read(table(BOARD))), ['As', 'Kh', '7d', '10c', 'Qs']);
});

test('reads the same board with the phone off to one side', () => {
  const angled = table(BOARD, { view: tilt(960, 640) });
  assert.deepEqual(labels(read(angled)), ['As', 'Kh', '7d', '10c', 'Qs']);
});

test('reads a board from a steeper angle still', () => {
  const steep = table(BOARD, { view: tilt(960, 640, { squeeze: 0.6, slide: 0.2 }), cardW: 150, y: 120 });
  assert.deepEqual(labels(read(steep)), ['As', 'Kh', '7d', '10c', 'Qs']);
});

test('reads a card lying upside down', () => {
  const image = createImage(700, 500, FELT);
  const corners = rect(250, 120, 150, 225);
  place(image, renderCard('Q', 'h'), [corners[2], corners[3], corners[0], corners[1]]);
  assert.deepEqual(labels(read(image)), ['Qh']);
});

test('reads a card turned sideways on the table', () => {
  const image = createImage(700, 500, FELT);
  const angle = (28 * Math.PI) / 180;
  const cx = 350;
  const cy = 250;
  const corners = rect(-75, -112, 150, 225).map((p) => ({
    x: cx + p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: cy + p.x * Math.sin(angle) + p.y * Math.cos(angle),
  }));
  place(image, renderCard('9', 'd'), corners);
  assert.deepEqual(labels(read(image)), ['9d']);
});

test('an empty table reads as nothing at all', () => {
  assert.deepEqual(read(createImage(700, 500, FELT)), []);
});

/* ----------------------------------------------------- refusing to guess */

test('round and square bright things are not cards', () => {
  const image = createImage(700, 500, FELT);
  fillCircle(image, 200, 250, 90, WHITE); // a coaster
  fillRect(image, 400, 180, 160, 160, WHITE); // a napkin
  assert.deepEqual(read(image), []);
});

test('an unknown deck still finds the cards, it just does not name them', () => {
  const reader = new CardReader({ ranks: {}, suits: {} });
  const image = table(BOARD);
  const found = reader.read(image.data, image.width, image.height);
  assert.equal(found.length, 5);
  assert.deepEqual(labels(found), [null, null, null, null, null]);
  assert.ok(found.every((card) => card.quad.length === 4));
});

test('a reading that barely beats the runner-up is not reported', () => {
  const strict = read(table(BOARD), { minMargin: 0.9 });
  assert.equal(strict.length, 5);
  assert.deepEqual(labels(strict), [null, null, null, null, null]);
});

test('red ink is never read as a black suit', () => {
  for (const suit of ['h', 'd']) {
    const found = read(table([['8', suit]]));
    assert.equal(found.length, 1);
    assert.ok('hd'.includes(found[0].suit), `${suit} read as ${found[0].suit}`);
    assert.equal(found[0].red, true);
  }
  for (const suit of ['s', 'c']) {
    const found = read(table([['8', suit]]));
    assert.ok('sc'.includes(found[0].suit), `${suit} read as ${found[0].suit}`);
    assert.equal(found[0].red, false);
  }
});

test('matchSymbol reports how far ahead the winner was', () => {
  const bits = new Uint8Array(16).fill(1);
  const symbol = { bits, width: 4, height: 4, aspect: 1 };
  const near = { bits: new Uint8Array(16).fill(1), width: 4, height: 4, aspect: 1 };
  const far = { bits: new Uint8Array(16), width: 4, height: 4, aspect: 1 };
  const result = matchSymbol(symbol, { same: near, other: far });
  assert.equal(result.label, 'same');
  assert.equal(result.score, 1);
  assert.equal(result.margin, 1);
});

/* ------------------------------------------------------------- steadiness */

test('a card is only reported once it reads the same several frames running', () => {
  const tracker = new CardTracker({ stableFrames: 3 });
  const card = { label: 'As', center: { x: 100, y: 100 }, score: 1, margin: 1, quad: [] };
  assert.deepEqual(labels(tracker.update([card])), []);
  assert.deepEqual(labels(tracker.update([card])), []);
  assert.deepEqual(labels(tracker.update([card])), ['As']);
});

test('one stray frame never becomes a card', () => {
  const tracker = new CardTracker({ stableFrames: 3 });
  const good = { label: 'As', center: { x: 100, y: 100 }, score: 1, margin: 1, quad: [] };
  const stray = { ...good, label: 'Kd' };
  tracker.update([good]);
  tracker.update([stray]);
  assert.deepEqual(labels(tracker.update([good])), []);
  assert.deepEqual(labels(tracker.update([good])), ['As']);
});

test('resetting the tracker forgets the hand', () => {
  const tracker = new CardTracker({ stableFrames: 2 });
  const card = { label: 'As', center: { x: 100, y: 100 }, score: 1, margin: 1, quad: [] };
  tracker.update([card]);
  tracker.update([card]);
  tracker.reset();
  assert.deepEqual(labels(tracker.update([card])), []);
});

/* --------------------------------------------------------------- storage */

test('templates survive a trip through storage', () => {
  const bits = new Uint8Array(64);
  for (let i = 0; i < bits.length; i += 3) bits[i] = 1;
  const restored = unpackBits(packBits(bits), bits.length);
  assert.deepEqual([...restored], [...bits]);
});

test('resizing a bitmap keeps its shape', () => {
  const bits = new Uint8Array(16);
  for (let i = 8; i < 16; i++) bits[i] = 1; // bottom half filled
  const small = resizeBitmap(bits, 4, 4, 2, 2);
  assert.deepEqual([...small], [0, 0, 1, 1]);
});
