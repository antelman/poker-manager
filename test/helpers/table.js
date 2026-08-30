/**
 * A drawn poker table for the vision tests.
 *
 * There is no canvas in Node, so this rasterises by hand: rectangles, polygons
 * and circles into an RGBA buffer. The cards carry a seven-segment rank and a
 * drawn pip in the same corner a real card keeps them, mirrored at the bottom
 * like a real card too, so an upside-down card is still readable.
 *
 * `place` puts a card onto the table through a homography, which is how the
 * angled-camera tests are built: the same table, seen from off to one side.
 */

import { homography, project, CARD_W, CARD_H } from '../../src/vision.js';

export const FELT = [34, 78, 52, 255];
export const WHITE = [246, 246, 244, 255];
export const BLACK = [24, 24, 28, 255];
export const RED = [188, 32, 40, 255];

export const SCALE = 2; // canonical card pixels per unit, for crisper glyphs

export function createImage(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = 255;
  }
  return { data, width, height };
}

export function fillRect(image, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(image.width, Math.round(x + w));
  const y1 = Math.min(image.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * image.width + px) * 4;
      image.data[i] = color[0];
      image.data[i + 1] = color[1];
      image.data[i + 2] = color[2];
      image.data[i + 3] = 255;
    }
  }
}

export function fillPoly(image, points, color) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...points.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    const crossings = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.y === b.y) continue;
      const [low, high] = a.y < b.y ? [a, b] : [b, a];
      if (y + 0.5 < low.y || y + 0.5 >= high.y) continue;
      crossings.push(low.x + ((y + 0.5 - low.y) / (high.y - low.y)) * (high.x - low.x));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      fillRect(image, crossings[i], y, crossings[i + 1] - crossings[i], 1, color);
    }
  }
}

export function fillCircle(image, cx, cy, r, color) {
  const points = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  fillPoly(image, points, color);
}

/* ------------------------------------------------------------------ glyphs */

// Seven-segment shapes stand in for the printed index: thirteen distinct
// blobs, drawn the same way every time, which is all the matcher needs.
const SEGMENTS = {
  A: 'abcefg', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg',
  7: 'abc', 8: 'abcdefg', 9: 'abcdfg', J: 'bcde', Q: 'abcfg', K: 'bcefg', 0: 'abcdef',
};

function drawSegments(image, code, x, y, w, h, color, thickness) {
  const on = SEGMENTS[code] || '';
  const t = thickness;
  const half = h / 2;
  const put = (segment, rect) => {
    if (on.includes(segment)) fillRect(image, rect[0], rect[1], rect[2], rect[3], color);
  };
  put('a', [x, y, w, t]);
  put('g', [x, y + half - t / 2, w, t]);
  put('d', [x, y + h - t, w, t]);
  put('f', [x, y, t, half]);
  put('b', [x + w - t, y, t, half]);
  put('e', [x, y + half, t, half]);
  put('c', [x + w - t, y + half, t, half]);
}

function drawRank(image, rank, x, y, w, h, color) {
  const thickness = Math.max(2, Math.round(w * 0.22));
  if (rank === '10') {
    fillRect(image, x + w * 0.1, y, thickness, h, color); // the "1"
    drawSegments(image, '0', x + w * 0.45, y, w * 0.55, h, color, thickness);
    return;
  }
  drawSegments(image, rank, x, y, w, h, color, thickness);
}

export function drawSuit(image, suit, cx, cy, size, color) {
  const half = size / 2;
  if (suit === 'd') {
    fillPoly(image, [
      { x: cx, y: cy - half }, { x: cx + half * 0.72, y: cy },
      { x: cx, y: cy + half }, { x: cx - half * 0.72, y: cy },
    ], color);
  } else if (suit === 'h') {
    const r = half / 2;
    fillCircle(image, cx - r, cy - r / 2, r, color);
    fillCircle(image, cx + r, cy - r / 2, r, color);
    fillPoly(image, [
      { x: cx - 2 * r, y: cy - r / 2 }, { x: cx + 2 * r, y: cy - r / 2 }, { x: cx, y: cy + half },
    ], color);
  } else if (suit === 's') {
    const r = half / 2;
    fillCircle(image, cx - r, cy + r / 3, r, color);
    fillCircle(image, cx + r, cy + r / 3, r, color);
    fillPoly(image, [
      { x: cx - 2 * r, y: cy + r / 3 }, { x: cx + 2 * r, y: cy + r / 3 }, { x: cx, y: cy - half },
    ], color);
    fillPoly(image, [
      { x: cx - r, y: cy + half }, { x: cx + r, y: cy + half },
      { x: cx + r / 3, y: cy }, { x: cx - r / 3, y: cy },
    ], color);
  } else {
    const r = Math.max(2, half / 3);
    fillCircle(image, cx, cy - half + r, r, color);
    fillCircle(image, cx - r, cy + r / 2, r, color);
    fillCircle(image, cx + r, cy + r / 2, r, color);
    fillPoly(image, [
      { x: cx - r, y: cy + half }, { x: cx + r, y: cy + half },
      { x: cx + r / 3, y: cy }, { x: cx - r / 3, y: cy },
    ], color);
  }
}

/* ------------------------------------------------------------------- cards */

/** Copy a corner of the card into the opposite corner, turned 180 degrees. */
function rotateInto(card, box) {
  const copy = new Uint8ClampedArray(card.data);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const from = ((box.y + y) * card.width + box.x + x) * 4;
      const to = ((card.height - 1 - box.y - y) * card.width + (card.width - 1 - box.x - x)) * 4;
      for (let c = 0; c < 4; c++) card.data[to + c] = copy[from + c];
    }
  }
}

/** An upright card image, `SCALE` times the canonical 200x300. */
export function renderCard(rank, suit) {
  const width = CARD_W * SCALE;
  const height = CARD_H * SCALE;
  const card = createImage(width, height, WHITE);
  const ink = 'hd'.includes(suit) ? RED : BLACK;
  const s = SCALE;

  drawRank(card, rank, 6 * s, 8 * s, 24 * s, 34 * s, ink);
  drawSuit(card, suit, 18 * s, 62 * s, 22 * s, ink);
  // Real cards repeat the index in the far corner, rotated, so the card reads
  // the same either way up. Copying it keeps the two identical, as printing does.
  rotateInto(card, { x: 0, y: 0, w: 40 * s, h: 90 * s });

  drawSuit(card, suit, width / 2, height / 2, 90 * s, ink);
  return card;
}

/**
 * Paint a card onto the table through the quad `corners`, in
 * top-left, top-right, bottom-right, bottom-left order. Any quad works, which
 * is what makes an angled view testable.
 */
export function place(table, card, corners) {
  const toCard = homography(corners, [
    { x: 0, y: 0 },
    { x: card.width, y: 0 },
    { x: card.width, y: card.height },
    { x: 0, y: card.height },
  ]);
  const minX = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x))));
  const maxX = Math.min(table.width - 1, Math.ceil(Math.max(...corners.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y))));
  const maxY = Math.min(table.height - 1, Math.ceil(Math.max(...corners.map((p) => p.y))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const point = project(toCard, x + 0.5, y + 0.5);
      if (point.x < 0 || point.y < 0 || point.x >= card.width || point.y >= card.height) continue;
      const from = ((point.y | 0) * card.width + (point.x | 0)) * 4;
      const to = (y * table.width + x) * 4;
      table.data[to] = card.data[from];
      table.data[to + 1] = card.data[from + 1];
      table.data[to + 2] = card.data[from + 2];
      table.data[to + 3] = 255;
    }
  }
  return table;
}

export const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/**
 * A camera off to one side, looking at the table plane at an angle: the top
 * edge of the frame shrinks and slides, exactly like a phone propped against a
 * glass instead of held overhead.
 */
export function tilt(width, height, { squeeze = 0.42, slide = 0.12 } = {}) {
  return homography(
    rect(0, 0, width, height),
    [
      { x: width * (squeeze / 2 + slide), y: height * 0.06 },
      { x: width * (1 - squeeze / 2 + slide), y: height * 0.06 },
      { x: width, y: height },
      { x: 0, y: height },
    ]
  );
}

/** Lay out `cards` in a row, optionally seen through a view homography. */
export function table(cards, { width = 960, height = 640, view = null, cardW = 132, gap = 20, y = 150 } = {}) {
  const image = createImage(width, height, FELT);
  const cardH = Math.round(cardW * (CARD_H / CARD_W));
  const total = cards.length * cardW + (cards.length - 1) * gap;
  let x = Math.round((width - total) / 2);
  for (const [rank, suit] of cards) {
    let corners = rect(x, y, cardW, cardH);
    if (view) corners = corners.map((p) => project(view, p.x, p.y));
    place(image, renderCard(rank, suit), corners);
    x += cardW + gap;
  }
  return image;
}
