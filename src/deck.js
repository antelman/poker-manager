/**
 * The deck the camera is looking at: one template image per rank and per suit.
 *
 * Two sources, in that order of trust:
 *
 *   1. glyphs drawn on a canvas, so scanning works the moment you open the
 *      app - close enough for the printed index on a standard deck
 *   2. templates captured from your own cards, which replace the drawn ones
 *      label by label and live in localStorage
 *
 * Templates are stored as packed bits: seventeen of them come to about 15KB,
 * which localStorage will not notice.
 */

import { KNOWN_DECK } from './known-deck.js';
import {
  CARD_RANKS,
  CARD_SUITS,
  RANK_W,
  RANK_H,
  SUIT_W,
  SUIT_H,
  symbolFromInk,
  packBits,
  unpackBits,
} from './vision.js';

const DECK_KEY = 'poker-manager:deck:v1';

const SUIT_GLYPH = { s: '♠︎', h: '♥︎', d: '♦︎', c: '♣︎' };
const SYMBOL_SIZE = { ranks: [RANK_W, RANK_H], suits: [SUIT_W, SUIT_H] };

/**
 * The face the drawn glyphs are rendered in. Drawing each glyph in several
 * faces was tried against a real deck and a printed one and changed nothing
 * that could be measured: a blurred serif K still loses to a digit. What
 * actually fixes a stubborn deck is teaching it.
 */
const INDEX_FONT = 'bold 150px "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Rasterise one glyph and normalise it exactly like a symbol read off a card.
 * The text is drawn as large as its box allows, since only the shape survives
 * the crop-and-scale that follows.
 */
export function renderGlyph(text, outW, outH, font = INDEX_FONT) {
  if (typeof document === 'undefined') return null;
  const width = 160;
  const height = 220;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = font;
  context.fillText(text, width / 2, height / 2, width * 0.9);

  const { data } = context.getImageData(0, 0, width, height);
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    ink[i] = data[p] < 128 ? 1 : 0;
  }
  return symbolFromInk(ink, width, height, outW, outH);
}

/** The templates for the deck that ships with the app, unpacked once. */
let known = null;
function knownTemplates() {
  if (known) return known;
  known = { ranks: {}, suits: {} };
  for (const kind of ['ranks', 'suits']) {
    const [w, h] = SYMBOL_SIZE[kind];
    for (const [label, entry] of Object.entries(KNOWN_DECK[kind])) {
      if (entry.width !== w || entry.height !== h) continue;
      known[kind][label] = {
        bits: unpackBits(entry.bits, w * h),
        width: w,
        height: h,
        aspect: entry.aspect,
        // Lifted from photographs of a real deck, so the reader can insist on
        // a close match instead of settling for the nearest rank.
        proven: true,
      };
    }
  }
  return known;
}

let drawn = null;

/** The out-of-the-box templates, built once per session. */
export function drawnTemplates() {
  if (drawn) return drawn;
  drawn = { ranks: {}, suits: {} };
  for (const rank of CARD_RANKS) {
    const symbol = renderGlyph(rank, RANK_W, RANK_H);
    if (symbol) drawn.ranks[rank] = symbol;
  }
  for (const suit of CARD_SUITS) {
    const symbol = renderGlyph(SUIT_GLYPH[suit], SUIT_W, SUIT_H);
    if (symbol) drawn.suits[suit] = symbol;
  }
  return drawn;
}

/* ---------------------------------------------------------------- storage */

function readStore() {
  try {
    const raw = localStorage.getItem(DECK_KEY);
    return raw ? JSON.parse(raw) : { ranks: {}, suits: {} };
  } catch {
    return { ranks: {}, suits: {} };
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(DECK_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false; // a full or blocked store just means the drawn glyphs stay
  }
}

function encodeSymbol(symbol) {
  return { bits: packBits(symbol.bits), w: symbol.width, h: symbol.height, aspect: symbol.aspect };
}

function decodeSymbol(entry, outW, outH) {
  if (!entry || entry.w !== outW || entry.h !== outH) return null;
  return {
    bits: unpackBits(entry.bits, outW * outH),
    width: outW,
    height: outH,
    aspect: entry.aspect,
    proven: true, // captured from the cards on this table
  };
}

/** Every template the reader should use: drawn glyphs, overridden by captures. */
export function loadDeck() {
  const store = readStore();
  const deck = { ranks: { ...drawnTemplates().ranks }, suits: { ...drawnTemplates().suits } };
  // The real deck's own corners, offered next to the drawn guesses under the
  // same names - the matcher takes whichever fits, and reports the card either
  // way.
  for (const kind of ['ranks', 'suits']) {
    for (const [label, symbol] of Object.entries(knownTemplates()[kind])) {
      deck[kind][`${label}#deck`] = symbol;
    }
  }
  for (const kind of ['ranks', 'suits']) {
    const [w, h] = SYMBOL_SIZE[kind];
    for (const [label, entry] of Object.entries(store[kind] || {})) {
      const symbol = decodeSymbol(entry, w, h);
      if (!symbol) continue;
      // A card taught from the real deck replaces every guess at it: the drawn
      // faces are only there for a deck nobody has shown the app.
      for (const key of Object.keys(deck[kind])) {
        if (key === label || key.startsWith(`${label}#`)) delete deck[kind][key];
      }
      deck[kind][label] = symbol;
    }
  }
  return deck;
}

/** Remember one symbol captured from the real deck. */
export function saveSymbol(kind, label, symbol) {
  if (!symbol) return false;
  const store = readStore();
  store[kind] = store[kind] || {};
  store[kind][label] = encodeSymbol(symbol);
  return writeStore(store);
}

/** Which labels have been captured, so the wizard can show its progress. */
export function learnedLabels() {
  const store = readStore();
  return {
    ranks: Object.keys(store.ranks || {}),
    suits: Object.keys(store.suits || {}),
  };
}

/**
 * Where each label's template comes from: a card taught on this phone, a
 * corner that ships with the app, or nothing but a drawn glyph. The wizard
 * shows this so the two ranks nobody has ever photographed are easy to find.
 */
export function templateSources() {
  const learned = learnedLabels();
  const sources = { ranks: {}, suits: {} };
  for (const kind of ['ranks', 'suits']) {
    for (const label of Object.keys(knownTemplates()[kind])) sources[kind][label] = 'deck';
    for (const label of learned[kind]) sources[kind][label] = 'learned';
  }
  return sources;
}

export function learnedCount() {
  const { ranks, suits } = learnedLabels();
  return ranks.length + suits.length;
}

/** Back to the drawn glyphs - for a new deck, or a session that went wrong. */
export function forgetDeck() {
  try {
    localStorage.removeItem(DECK_KEY);
  } catch {
    // Nothing to forget if the store is unavailable.
  }
}
