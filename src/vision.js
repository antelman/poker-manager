/**
 * Reading playing cards out of a camera frame, on the device.
 *
 * No libraries, no server, no model download: the frame never leaves the
 * phone. The pipeline is deliberately geometric rather than learned, because
 * a card is a rigid white rectangle with its index printed in a fixed corner -
 * which is a shape problem, not a recognition problem:
 *
 *   1. threshold the frame so the bright cards separate from the table
 *   2. flood fill the bright blobs and take the convex hull of each
 *   3. reduce every hull to the four corners of a quadrilateral
 *   4. solve the homography from those corners to an upright card, which is
 *      what lets the phone look at the table from an angle instead of
 *      straight down
 *   5. unwarp only the top-left corner index, split it into rank and suit
 *   6. tell red suits from black ones by the ink colour, then match the shape
 *      against the templates for that colour
 *
 * Everything here is pure: buffers in, plain objects out, no DOM. `deck.js`
 * owns the templates and `app.js` owns the camera.
 */

/** The canonical upright card every detection is flattened onto. */
export const CARD_W = 200;
export const CARD_H = 300;

/**
 * Where to look for the corner index: a generous window, inset enough to keep
 * the printed border out. Nothing is assumed about where inside it the index
 * sits - decks differ far too much for that - so the window is deliberately
 * bigger than any index and `symbolsFromCorner` finds the index inside it.
 */
const CORNER = { x: 2, y: 3, w: 54, h: 94 };
const CORNER_SCALE = 4;
/** An index is never wider than this fraction of the card. */
const INDEX_MAX_W = 26;
/** How much darker than the paper around it a pixel has to be to count as ink. */
const INK_OFFSET = 14;

/** Normalised template sizes. Small enough to keep in localStorage. */
export const RANK_W = 56;
export const RANK_H = 88;
export const SUIT_W = 56;
export const SUIT_H = 72;

export const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const CARD_SUITS = ['s', 'h', 'd', 'c'];
export const RED_SUITS = ['h', 'd'];
export const BLACK_SUITS = ['s', 'c'];

/**
 * How the three views of "the same shape" are weighed against each other:
 * pixels agreeing, ink overlapping, and outlines being near each other.
 */
export const WEIGHTS = {
  // A rank has to survive a deck printing its 8 in a typeface nobody taught the
  // app, so how near the outlines are carries it. A suit only ever has to tell
  // a spade from a club, which are the same shape until you look at exactly
  // where the ink is, so overlap counts for more there.
  //
  // Both settings were picked by sweeping them over three sets at once: the
  // drawn tables in the tests, a frame of printed cards, and a photograph of a
  // real deck on a real table. This is the middle of the region that reads
  // every card in all three and misreads none.
  rank: { agreement: 0, overlap: 0.4, shape: 0.6 },
  suit: { agreement: 0.2, overlap: 0.4, shape: 0.4 },
};

export const DEFAULTS = {
  /** Blob sizes worth looking at, as a fraction of the frame. */
  minAreaFrac: 0.004,
  maxAreaFrac: 0.35,
  /** How square-on a blob has to be to count as a card. */
  minSolidity: 0.86,
  maxHullError: 0.035,
  minAspect: 1.15,
  maxAspect: 2.35,
  /** Tiles used for the local threshold; more tiles survive harder shadows. */
  tilesX: 4,
  tilesY: 3,
  /**
   * How sure a reading has to be, and by how much it has to beat the runner-up.
   * Calibrated over the drawn tables the tests use and a photograph of a real
   * deck on a real table: of the settings tried, this sits in the middle of the
   * range that reads every card in both and misreads none in either.
   */
  minScore: 0.6,
  minMargin: 0.025,
  /** Frames a card must read the same way before it is reported. */
  stableFrames: 3,
  history: 6,
};

/* --------------------------------------------------------------- greyscale */

/** BT.601 luma, which is what the thresholding downstream assumes. */
export function grayscale(rgba, width, height, out) {
  const gray = out || new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 306 + rgba[p + 1] * 601 + rgba[p + 2] * 117) >> 10;
  }
  return gray;
}

/* -------------------------------------------------------------- thresholds */

/** Otsu's threshold for a 256-bin histogram, or -1 when it is not bimodal. */
export function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let weightB = 0;
  let best = -1;
  let bestVariance = 0;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Binarise with a threshold that varies across the frame.
 *
 * A single global cut-off breaks the moment half the table is in shadow, which
 * is the normal state of a phone propped up at an angle. Each tile gets its
 * own Otsu threshold, tiles too flat to split fall back to the global one, and
 * the values are interpolated so no tile edge shows up as a seam.
 */
export function binarize(gray, width, height, options = {}, out) {
  const { tilesX, tilesY } = { ...DEFAULTS, ...options };
  const mask = out || new Uint8Array(width * height);

  const global = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) global[gray[i]]++;
  const globalThreshold = otsuThreshold(global, gray.length);

  // One threshold per tile, indexed [ty][tx].
  const thresholds = new Float32Array(tilesX * tilesY);
  const hist = new Uint32Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      hist.fill(0);
      const x0 = Math.floor((tx * width) / tilesX);
      const x1 = Math.floor(((tx + 1) * width) / tilesX);
      const y0 = Math.floor((ty * height) / tilesY);
      const y1 = Math.floor(((ty + 1) * height) / tilesY);
      let count = 0;
      let min = 255;
      let max = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = y * width + x0; x < x1; x++, i++) {
          const value = gray[i];
          hist[value]++;
          count++;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      // A tile holding only felt, or only card, has nothing to separate.
      const local = max - min < 45 ? -1 : otsuThreshold(hist, count);
      thresholds[ty * tilesX + tx] = local < 0 ? globalThreshold : local;
    }
  }

  for (let y = 0; y < height; y++) {
    const fy = (y / height) * tilesY - 0.5;
    const y0 = Math.max(0, Math.min(tilesY - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(tilesY - 1, y0 + 1));
    const wy = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < width; x++) {
      const fx = (x / width) * tilesX - 0.5;
      const x0 = Math.max(0, Math.min(tilesX - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(tilesX - 1, x0 + 1));
      const wx = Math.max(0, Math.min(1, fx - x0));
      const top = thresholds[y0 * tilesX + x0] * (1 - wx) + thresholds[y0 * tilesX + x1] * wx;
      const bottom = thresholds[y1 * tilesX + x0] * (1 - wx) + thresholds[y1 * tilesX + x1] * wx;
      const threshold = top * (1 - wy) + bottom * wy;
      const i = y * width + x;
      mask[i] = gray[i] > threshold ? 1 : 0;
    }
  }
  return mask;
}

/* -------------------------------------------------------------- components */

/**
 * Flood fill every blob in the mask, keeping the leftmost and rightmost pixel
 * of each row. Those row ends are all the convex hull needs, so a blob of
 * 40,000 pixels turns into a couple of hundred points.
 */
export function components(mask, width, height, options = {}, scratch = null) {
  const { minAreaFrac, maxAreaFrac } = { ...DEFAULTS, ...options };
  const minArea = minAreaFrac * width * height;
  const maxArea = maxAreaFrac * width * height;

  // The frame buffers are the big ones - a couple of megabytes a frame if they
  // are allocated fresh, which on a phone is felt as stutter.
  const buffers = reuseScratch(scratch, width, height);
  const { seen, stack, rowMin, rowMax } = buffers;
  const found = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || seen[start]) continue;

    let top = 0;
    stack[top++] = start;
    seen[start] = 1;

    let area = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    while (top > 0) {
      const index = stack[--top];
      const y = (index / width) | 0;
      const x = index - y * width;
      area++;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (mask[next] === 1 && !seen[next]) {
            seen[next] = 1;
            stack[top++] = next;
          }
        }
      }
    }

    // Only a blob worth keeping gets its own copy of the row ends; the rest
    // just hand the shared rows back.
    if (area >= minArea && area <= maxArea) {
      const keepMin = new Int32Array(height).fill(width);
      const keepMax = new Int32Array(height).fill(-1);
      for (let y = minY; y <= maxY; y++) {
        keepMin[y] = rowMin[y];
        keepMax[y] = rowMax[y];
      }
      found.push({ area, minX, maxX, minY, maxY, rowMin: keepMin, rowMax: keepMax });
    }
    for (let y = minY; y <= maxY; y++) {
      rowMin[y] = width;
      rowMax[y] = -1;
    }
  }
  return found;
}

/** Buffers big enough for this frame, cleared and ready, reused when possible. */
export function reuseScratch(scratch, width, height) {
  const size = width * height;
  if (!scratch || scratch.size !== size || scratch.height !== height) {
    return {
      size,
      height,
      seen: new Uint8Array(size),
      stack: new Int32Array(size),
      rowMin: new Int32Array(height).fill(width),
      rowMax: new Int32Array(height).fill(-1),
    };
  }
  scratch.seen.fill(0);
  return scratch;
}

/** The two ends of every row of a blob - the only points a hull can use. */
export function rowPoints(component) {
  const points = [];
  for (let y = component.minY; y <= component.maxY; y++) {
    const left = component.rowMin[y];
    const right = component.rowMax[y];
    if (right < 0) continue;
    points.push({ x: left, y });
    if (right !== left) points.push({ x: right, y });
  }
  return points;
}

/** Andrew's monotone chain. Returns the hull counter-clockwise in screen axes. */
export function convexHull(points) {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Perpendicular distance from `p` to the line through `a` and `b`, signed. */
function sideDistance(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return ((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
}

/**
 * The four corners of a hull, without an epsilon to tune.
 *
 * The two points furthest apart are a diagonal of the card; the points
 * furthest from that diagonal on either side are the remaining two corners.
 */
export function quadFromHull(hull) {
  if (hull.length < 4) return null;

  let a = hull[0];
  let b = hull[1];
  let best = -1;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = distance(hull[i], hull[j]);
      if (d > best) {
        best = d;
        a = hull[i];
        b = hull[j];
      }
    }
  }

  let left = null;
  let right = null;
  let leftBest = 0;
  let rightBest = 0;
  for (const p of hull) {
    const d = sideDistance(a, b, p);
    if (d > leftBest) {
      leftBest = d;
      left = p;
    } else if (-d > rightBest) {
      rightBest = -d;
      right = p;
    }
  }
  if (!left || !right) return null;
  return [a, left, b, right];
}

export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

/** Worst distance from the hull to the fitted quad, relative to its size. */
export function hullError(hull, quad) {
  let worst = 0;
  for (const p of hull) {
    let inside = Infinity;
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % quad.length];
      inside = Math.min(inside, Math.abs(sideDistance(a, b, p)));
    }
    worst = Math.max(worst, inside);
  }
  return worst / Math.sqrt(polygonArea(quad) || 1);
}

/**
 * Put the corners in the order a card expects: top-left, top-right,
 * bottom-right, bottom-left, with the short edge first so the card stands up.
 * Returns both readings of "up", 180 degrees apart - a card lying across the
 * table has no other way to tell which end is its top.
 */
export function orderQuad(quad) {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const cyclic = quad
    .slice()
    .sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));

  const side = (i) => distance(cyclic[i], cyclic[(i + 1) % 4]);
  const first = (side(0) + side(2)) / 2;
  const second = (side(1) + side(3)) / 2;
  const start = first <= second ? 0 : 1; // start on a short edge: the card's top
  const rotate = (offset) => [0, 1, 2, 3].map((i) => cyclic[(start + offset + i) % 4]);

  const width = Math.min(first, second);
  const height = Math.max(first, second);
  return { orientations: [rotate(0), rotate(2)], width, height };
}

/* ------------------------------------------------------------- homography */

/**
 * The 3x3 that maps `src` onto `dst`, as a flat array with h22 fixed at 1.
 * Solved directly: four point pairs give eight equations for eight unknowns.
 */
export function homography(src, dst) {
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    const head = a[col][col];
    for (let row = col + 1; row < 8; row++) {
      const factor = a[row][col] / head;
      if (factor === 0) continue;
      for (let k = col; k < 8; k++) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }

  const h = new Float64Array(9);
  for (let row = 7; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < 8; k++) sum -= a[row][k] * h[k];
    h[row] = sum / a[row][row];
  }
  h[8] = 1;
  return h;
}

export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Unwarp a rectangle of the canonical card straight out of the camera frame,
 * bilinearly, at `scale` times its canonical size. Only the corner index is
 * ever worth unwarping, so this is a few thousand samples per card.
 */
export function warpPatch(rgba, width, height, h, rect, scale) {
  const outW = Math.round(rect.w * scale);
  const outH = Math.round(rect.h * scale);
  const gray = new Uint8ClampedArray(outW * outH);
  const red = new Float32Array(outW * outH); // how red the ink is, for the suit

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const point = project(h, rect.x + (x + 0.5) / scale, rect.y + (y + 0.5) / scale);
      const sx = Math.max(0, Math.min(width - 1.001, point.x - 0.5));
      const sy = Math.max(0, Math.min(height - 1.001, point.y - 0.5));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);

      let r = 0;
      let g = 0;
      let b = 0;
      const corners = [
        [(y0 * width + x0) * 4, (1 - fx) * (1 - fy)],
        [(y0 * width + x1) * 4, fx * (1 - fy)],
        [(y1 * width + x0) * 4, (1 - fx) * fy],
        [(y1 * width + x1) * 4, fx * fy],
      ];
      for (const [p, weight] of corners) {
        r += rgba[p] * weight;
        g += rgba[p + 1] * weight;
        b += rgba[p + 2] * weight;
      }
      const i = y * outW + x;
      gray[i] = (r * 306 + g * 601 + b * 117) / 1024;
      red[i] = r - Math.max(g, b);
    }
  }
  return { gray, red, width: outW, height: outH };
}

/* ----------------------------------------------------------------- symbols */

/** Scale a binary bitmap into a fixed box by averaging, then re-threshold. */
export function resizeBitmap(bits, width, height, outW, outH) {
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += bits[sy * width + sx];
          count++;
        }
      }
      out[y * outW + x] = sum * 2 >= count ? 1 : 0;
    }
  }
  return out;
}

/**
 * Crop a mask to its ink and normalise it into `outW` x `outH`.
 *
 * Exported because a template has to be built exactly the way a reading is,
 * whether it came from the camera or from a drawn glyph.
 */
export function symbolFromInk(mask, width, height, outW, outH) {
  const blobs = components(mask, width, height, { minAreaFrac: 0, maxAreaFrac: 1 });
  if (blobs.length === 0) return null;

  // Ink can break into pieces (the dot of a "J", the two halves of a "10"),
  // so keep every blob close in size to the biggest one and crop them all.
  const biggest = blobs.reduce((best, blob) => (blob.area > best.area ? blob : best), blobs[0]);
  if (biggest.area < 12) return null;
  const keep = blobs.filter((blob) => blob.area >= biggest.area * 0.12);
  const minX = Math.min(...keep.map((b) => b.minX));
  const maxX = Math.max(...keep.map((b) => b.maxX));
  const minY = Math.min(...keep.map((b) => b.minY));
  const maxY = Math.max(...keep.map((b) => b.maxY));

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  if (cropW < 3 || cropH < 5) return null;

  const crop = new Uint8Array(cropW * cropH);
  for (const blob of keep) {
    for (let y = blob.minY; y <= blob.maxY; y++) {
      for (let x = blob.rowMin[y]; x <= blob.rowMax[y]; x++) {
        if (mask[y * width + x]) crop[(y - minY) * cropW + (x - minX)] = 1;
      }
    }
  }
  return {
    bits: resizeBitmap(crop, cropW, cropH, outW, outH),
    width: outW,
    height: outH,
    aspect: cropW / cropH,
  };
}

/**
 * Ink, found against the paper immediately around it rather than against the
 * whole corner at once.
 *
 * A card is never lit evenly: one end catches the lamp, the other sits in the
 * shadow of the phone. Worse, the index is often a thin, light glyph while the
 * artwork beside it is heavy and dark, so one cut-off for the whole corner
 * keeps the artwork and loses the index - which is exactly the wrong half.
 *
 * The price is that a heavy, solid glyph darkens its own surroundings and comes
 * out hollow, which is why `symbolsFromCorner` reads the corner both ways and
 * lets the matcher say which reading it believes.
 */
function localInk(gray, width, height, radius, offset) {

  // Summed-area table, so a box mean is four lookups whatever the radius.
  const sums = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x];
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row;
    }
  }

  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const box =
        sums[(y1 + 1) * (width + 1) + x1 + 1] -
        sums[y0 * (width + 1) + x1 + 1] -
        sums[(y1 + 1) * (width + 1) + x0] +
        sums[y0 * (width + 1) + x0];
      if (gray[y * width + x] < box / area - offset) ink[y * width + x] = 1;
    }
  }
  return ink;
}

/**
 * Clear ink that runs off the card's own edge.
 *
 * Real cards have rounded corners and the detector fits a sharp-cornered quad
 * to their straight edges, so the extreme corner of an unwarped card is always
 * a wedge of whatever the card is lying on - plus, often, the shadow along the
 * edge. Left in, that wedge is the biggest, top-leftmost blob in the window and
 * gets read as the rank: a nine of clubs comes out as a black triangle.
 *
 * Anything connected to the top or left edge of the window is that, and never
 * the index, which always has white card stock around it.
 */
function clearEdgeInk(ink, width, height) {
  const stack = [];
  for (let x = 0; x < width; x++) if (ink[x]) stack.push(x);
  for (let y = 1; y < height; y++) if (ink[y * width]) stack.push(y * width);

  while (stack.length > 0) {
    const index = stack.pop();
    if (!ink[index]) continue;
    ink[index] = 0;
    const y = (index / width) | 0;
    const x = index - y * width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const next = ny * width + nx;
        if (ink[next]) stack.push(next);
      }
    }
  }
}

/**
 * Runs of consecutive non-empty entries in a profile, merging gaps smaller than
 * `minGap` - blur and low resolution break a single glyph into pieces, and
 * those pieces belong together.
 */
function inkRuns(profile, minGap) {
  const runs = [];
  let start = -1;
  let blank = 0;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] > 0) {
      if (start < 0) start = i;
      blank = 0;
      continue;
    }
    if (start < 0) continue;
    blank++;
    if (blank > minGap) {
      runs.push([start, i - blank]);
      start = -1;
      blank = 0;
    }
  }
  if (start >= 0) runs.push([start, profile.length - 1]);
  return runs;
}

/**
 * Find the rank and the suit in an unwarped corner, and decide whether the ink
 * is red.
 *
 * The index is printed as a narrow column hugging the corner, and the card's
 * own artwork - pips, or a court card's picture - starts further in, with a
 * band of blank card stock between them. So the first column of ink is the
 * index, whatever size the deck prints it at, and inside that column the first
 * two rows of ink are the rank and its suit. Guessing at fixed proportions
 * instead is what makes a nine of clubs read as nothing at all: on many decks
 * a fixed window swallows the first pip and matches that.
 *
 * Colour is taken from the suit alone - it is the one cue a camera reads
 * perfectly, and knowing red from black halves the suits to compare against.
 */
export function symbolsFromCorner(patch, { local = false } = {}) {
  const { gray, red, width, height } = patch;

  let ink;
  if (local) {
    // A window a bit wider than an index glyph: big enough to sit on paper,
    // small enough not to average in the shadow at the far end of the card.
    ink = localInk(gray, width, height, Math.max(3, Math.round(width * 0.22)), INK_OFFSET);
  } else {
    const hist = new Uint32Array(gray.length && 256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const threshold = otsuThreshold(hist, gray.length);
    if (threshold < 0) return null;
    ink = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) ink[i] = gray[i] < threshold ? 1 : 0;
  }
  clearEdgeInk(ink, width, height);

  const columns = new Int32Array(width);
  let inkCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink[y * width + x]) continue;
      columns[x]++;
      inkCount++;
    }
  }
  if (inkCount < 20) return null;

  // Pixels per canonical card unit, so every threshold below is in card
  // proportions rather than in whatever the camera happened to give.
  const unit = width / CORNER.w;
  const gap = Math.max(2, Math.round(unit * 1.2));

  const strips = inkRuns(columns, gap).filter(([a, b]) => b - a >= unit);
  if (strips.length === 0) return null;
  const x0 = strips[0][0];
  const x1 = Math.min(strips[0][1], x0 + Math.round(INDEX_MAX_W * unit));
  if (x1 - x0 < unit) return null;

  const rows = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = x0; x <= x1; x++) count += ink[y * width + x];
    rows[y] = count;
  }
  const bands = inkRuns(rows, gap).filter(([a, b]) => b - a >= unit * 0.8);
  if (bands.length < 2) return null;

  const [rankBand, suitBand] = bands;
  const rankHeight = rankBand[1] - rankBand[0];
  // The suit is printed right under the rank. Anything further down is the
  // card's own artwork, and reading that as a suit is worse than reading none.
  if (suitBand[0] - rankBand[1] > rankHeight * 1.6 + unit * 3) return null;

  const crop = (band) => {
    const w = x1 - x0 + 1;
    const h = band[1] - band[0] + 1;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) mask[y * w + x] = ink[(band[0] + y) * width + x0 + x];
    }
    return { mask, w, h };
  };

  const rankCrop = crop(rankBand);
  const suitCrop = crop(suitBand);

  let redSum = 0;
  let redCount = 0;
  for (let y = suitBand[0]; y <= suitBand[1]; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      if (!ink[i]) continue;
      redSum += red[i];
      redCount++;
    }
  }

  return {
    rank: symbolFromInk(rankCrop.mask, rankCrop.w, rankCrop.h, RANK_W, RANK_H),
    suit: symbolFromInk(suitCrop.mask, suitCrop.w, suitCrop.h, SUIT_W, SUIT_H),
    red: redCount > 0 && redSum / redCount > 28,
  };
}

/* ---------------------------------------------------------------- matching */

/**
 * Distance from every pixel to the nearest ink, two passes, chessboard-ish.
 *
 * Comparing two bitmaps pixel by pixel asks them to line up exactly, which two
 * printings of the same rank never do - one deck's 8 is a little rounder, a
 * camera softens the strokes, and a shape that is right but a pixel off scores
 * no better than a shape that is wrong. Measuring how far each mark is from the
 * nearest mark in the other image asks the gentler question: is this roughly
 * the same shape.
 */
export function distanceTransform(bits, width, height) {
  const far = width + height;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = bits[i] ? 0 : far;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) out[i] = Math.min(out[i], out[i - 1] + 1);
      if (y > 0) out[i] = Math.min(out[i], out[i - width] + 1);
      if (x > 0 && y > 0) out[i] = Math.min(out[i], out[i - width - 1] + 1.4);
      if (x < width - 1 && y > 0) out[i] = Math.min(out[i], out[i - width + 1] + 1.4);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) out[i] = Math.min(out[i], out[i + 1] + 1);
      if (y < height - 1) out[i] = Math.min(out[i], out[i + width] + 1);
      if (x < width - 1 && y < height - 1) out[i] = Math.min(out[i], out[i + width + 1] + 1.4);
      if (x > 0 && y < height - 1) out[i] = Math.min(out[i], out[i + width - 1] + 1.4);
    }
  }
  return out;
}

/** How close two bitmaps are in shape, 0..1, forgiving of a pixel or two. */
function shapeAgreement(symbol, symbolDistance, template) {
  if (!template.distance) {
    template.distance = distanceTransform(template.bits, template.width, template.height);
  }
  let fromSymbol = 0;
  let symbolInk = 0;
  let fromTemplate = 0;
  let templateInk = 0;
  for (let i = 0; i < symbol.bits.length; i++) {
    if (symbol.bits[i]) {
      fromSymbol += template.distance[i];
      symbolInk++;
    }
    if (template.bits[i]) {
      fromTemplate += symbolDistance[i];
      templateInk++;
    }
  }
  if (symbolInk === 0 || templateInk === 0) return 0;
  const mean = 0.5 * (fromSymbol / symbolInk + fromTemplate / templateInk);
  const scale = 0.16 * Math.hypot(symbol.width, symbol.height);
  return Math.max(0, 1 - mean / scale);
}

/**
 * Compare a symbol against a set of templates.
 *
 * Alongside the pixel agreement, the runner-up matters: a rank that beats the
 * next best by a hair is a coin toss, and this returns the margin so the
 * caller can refuse to guess.
 */
export function matchSymbol(symbol, templates, allowed, weights = WEIGHTS.rank) {
  if (!symbol) return { label: null, score: 0, margin: 0 };

  let best = { label: null, score: -1 };
  let second = -1;
  const symbolDistance = distanceTransform(symbol.bits, symbol.width, symbol.height);
  for (const [label, template] of Object.entries(templates)) {
    if (allowed && !allowed.includes(label)) continue;
    if (!template || template.bits.length !== symbol.bits.length) continue;

    // Pixel agreement alone counts the empty margins as a match, which makes
    // every big blob look like every other one - a spade and a club differ by
    // a few percent that way. Overlap over union ignores the shared emptiness
    // and looks only at the ink, where the two actually differ.
    let same = 0;
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < symbol.bits.length; i++) {
      const a = symbol.bits[i];
      const b = template.bits[i];
      if (a === b) same++;
      if (a && b) intersection++;
      if (a || b) union++;
    }
    const agreement = same / symbol.bits.length;
    const overlap = union > 0 ? intersection / union : 0;
    const shape = shapeAgreement(symbol, symbolDistance, template);
    // Overlap is strict about where the ink is, shape is forgiving about it.
    // Alone, the first refuses a deck it was not taught and the second cannot
    // tell a spade from a club; together they do both.
    let score = weights.agreement * agreement + weights.overlap * overlap + weights.shape * shape;

    // Normalising into a fixed box throws away how wide the symbol was, and
    // that is the whole difference between a "10" and a "1"-shaped glyph.
    if (template.aspect && symbol.aspect) {
      const ratio = Math.abs(Math.log(symbol.aspect / template.aspect));
      score -= Math.min(0.25, ratio * 0.35);
    }

    if (score > best.score) {
      second = best.score;
      best = { label, score };
    } else if (score > second) {
      second = score;
    }
  }
  return { label: best.label, score: Math.max(0, best.score), margin: Math.max(0, best.score - second) };
}

/* ------------------------------------------------------------------ reader */

/**
 * One card the camera can see: where it is, and what it reads as.
 * `label` stays null until both halves are read confidently.
 */
function detection(quad, rank, suit, red) {
  const label = rank.label && suit.label ? rank.label + suit.label : null;
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  return {
    label,
    rank: rank.label,
    suit: suit.label,
    red,
    score: Math.min(rank.score, suit.score),
    margin: Math.min(rank.margin, suit.margin),
    quad,
    center: { x: cx, y: cy },
  };
}

export class CardReader {
  /** `templates` is `{ ranks: {...}, suits: {...} }` from `deck.js`. */
  constructor(templates, options = {}) {
    this.templates = templates;
    this.options = { ...DEFAULTS, ...options };
    this.weights = {
      rank: { ...WEIGHTS.rank, ...(options.weights?.rank || {}) },
      suit: { ...WEIGHTS.suit, ...(options.weights?.suit || {}) },
    };
    this.buffers = {};
  }

  setTemplates(templates) {
    this.templates = templates;
  }

  /** Every card-shaped quad in the frame, before any reading. */
  quads(rgba, width, height) {
    const size = width * height;
    if (!this.buffers.gray || this.buffers.gray.length !== size) {
      this.buffers.gray = new Uint8ClampedArray(size);
      this.buffers.mask = new Uint8Array(size);
    }
    const gray = grayscale(rgba, width, height, this.buffers.gray);
    const mask = binarize(gray, width, height, this.options, this.buffers.mask);
    this.buffers.scratch = reuseScratch(this.buffers.scratch, width, height);

    const found = [];
    for (const blob of components(mask, width, height, this.options, this.buffers.scratch)) {
      const hull = convexHull(rowPoints(blob));
      const quad = quadFromHull(hull);
      if (!quad) continue;

      const area = polygonArea(quad);
      if (area <= 0) continue;
      if (blob.area / area < this.options.minSolidity) continue;
      if (hullError(hull, quad) > this.options.maxHullError) continue;

      const ordered = orderQuad(quad);
      const aspect = ordered.height / Math.max(1, ordered.width);
      if (aspect < this.options.minAspect || aspect > this.options.maxAspect) continue;
      found.push({ ...ordered, area });
    }
    return found;
  }

  /**
   * The rank and suit images of the biggest card in the frame, for teaching
   * the app a new deck. The card is expected to be held upright, so of the two
   * possible readings of "up" this takes the one whose index sits nearest the
   * top-left of the picture.
   */
  symbols(rgba, width, height) {
    const candidates = this.quads(rgba, width, height);
    if (candidates.length === 0) return null;
    const biggest = candidates.reduce((best, c) => (c.area > best.area ? c : best), candidates[0]);
    const upright = biggest.orientations
      .slice()
      .sort((a, b) => a[0].x + a[0].y - (b[0].x + b[0].y))[0];
    const h = homography(
      [
        { x: 0, y: 0 },
        { x: CARD_W, y: 0 },
        { x: CARD_W, y: CARD_H },
        { x: 0, y: CARD_H },
      ],
      upright
    );
    if (!h) return null;
    const patch = warpPatch(rgba, width, height, h, CORNER, CORNER_SCALE);
    const crisp = symbolsFromCorner(patch);
    if (crisp?.rank && crisp?.suit) return crisp;
    return symbolsFromCorner(patch, { local: true }) || crisp;
  }

  /**
   * Read the frame: card outlines, plus a name for the ones it is sure of.
   *
   * `options.detail` may hand back a sharper crop around a card than the frame
   * the quads were found in - finding a white rectangle needs far fewer pixels
   * than reading the little index printed in its corner, and downscaling the
   * whole frame to the size detection needs throws away exactly the detail the
   * reading depends on. It is given the card's corners and returns
   * `{ data, width, height, map }`, where `map` puts a point from the frame
   * into the crop.
   */
  read(rgba, width, height, options = {}) {
    const cards = [];
    for (const candidate of this.quads(rgba, width, height)) {
      const detail = options.detail ? options.detail(candidate) : null;
      const source = detail
        ? { data: detail.data, width: detail.width, height: detail.height, map: detail.map }
        : { data: rgba, width, height, map: (point) => point };
      let best = null;
      // A card lying on the table can be the right way up or upside down; the
      // index reads as noise in the wrong one, so try both and keep the winner.
      for (const corners of candidate.orientations) {
        const canonical = [
          { x: 0, y: 0 },
          { x: CARD_W, y: 0 },
          { x: CARD_W, y: CARD_H },
          { x: 0, y: CARD_H },
        ];
        const h = homography(canonical, corners.map(source.map));
        if (!h) continue;
        const patch = warpPatch(source.data, source.width, source.height, h, CORNER, CORNER_SCALE);
        // Two ways of telling ink from paper, and the matcher arbitrates: one
        // suits crisp print under even light, the other a light index next to
        // heavy artwork. Neither wins everywhere, and guessing wrong costs a
        // card, so both are tried.
        for (const local of [false, true]) {
          const symbols = symbolsFromCorner(patch, { local });
          if (!symbols) continue;

          const rank = matchSymbol(symbols.rank, this.templates.ranks, null, this.weights.rank);
          const suit = matchSymbol(
            symbols.suit,
            this.templates.suits,
            symbols.red ? RED_SUITS : BLACK_SUITS,
            this.weights.suit
          );
          const reading = detection(corners, rank, suit, symbols.red);
          if (!best || reading.score > best.score) best = reading;
        }
      }
      if (!best) {
        best = detection(candidate.orientations[0], { label: null, score: 0, margin: 0 }, { label: null, score: 0, margin: 0 }, false);
      }
      // Refuse to name a card that is only just ahead of the runner-up: a
      // silent misread is worse than an outline the dealer taps in himself.
      if (best.score < this.options.minScore || best.margin < this.options.minMargin) {
        best = { ...best, label: null, rank: null, suit: null };
      }
      cards.push(best);
    }

    cards.sort((a, b) => a.center.x - b.center.x);
    return dedupe(cards);
  }
}

/** Two quads reading as the same card: keep the more confident one. */
function dedupe(cards) {
  const bestByLabel = new Map();
  const out = [];
  for (const card of cards) {
    if (!card.label) {
      out.push(card);
      continue;
    }
    const existing = bestByLabel.get(card.label);
    if (!existing) {
      bestByLabel.set(card.label, card);
      out.push(card);
    } else if (card.score > existing.score) {
      out[out.indexOf(existing)] = card;
      bestByLabel.set(card.label, card);
    }
  }
  return out;
}

/**
 * Frame-to-frame smoothing.
 *
 * A single frame is never enough: a hand moving over the table, a flash of
 * glare or a blurred shutter all produce one bad reading. A card is only
 * reported once the same name wins several frames in the same spot.
 */
export class CardTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.cell = options.cell || 60;
    this.history = new Map();
  }

  key(card) {
    return `${Math.round(card.center.x / this.cell)},${Math.round(card.center.y / this.cell)}`;
  }

  /** Feed one frame's detections in; get the cards worth trusting out. */
  update(cards) {
    const seen = new Set();
    for (const card of cards) {
      const key = this.key(card);
      seen.add(key);
      const bucket = this.history.get(key) || [];
      bucket.push(card.label);
      while (bucket.length > this.options.history) bucket.shift();
      this.history.set(key, bucket);
    }
    for (const [key, bucket] of this.history) {
      if (seen.has(key)) continue;
      bucket.push(null);
      while (bucket.length > this.options.history) bucket.shift();
      if (bucket.every((label) => label === null)) this.history.delete(key);
    }

    const stable = [];
    for (const card of cards) {
      const bucket = this.history.get(this.key(card)) || [];
      const votes = new Map();
      for (const label of bucket) {
        if (label) votes.set(label, (votes.get(label) || 0) + 1);
      }
      let winner = null;
      let count = 0;
      for (const [label, n] of votes) {
        if (n > count) {
          winner = label;
          count = n;
        }
      }
      if (winner && count >= this.options.stableFrames) {
        stable.push({ ...card, label: winner, rank: winner.slice(0, -1), suit: winner.slice(-1) });
      }
    }
    return dedupe(stable);
  }

  reset() {
    this.history.clear();
  }
}

/* ------------------------------------------------------------ frame change */

/**
 * How much two greyscale thumbnails differ, in average levels of grey.
 *
 * A camera left running over a table spends most of the evening looking at
 * nothing happening. Comparing two postage stamps costs microseconds and says
 * whether the expensive read is worth doing at all.
 */
export function sceneDifference(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/* ----------------------------------------------------------------- storage */

/** Pack a 0/1 bitmap into base64, small enough to keep in localStorage. */
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 128 >> (i & 7);
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function unpackBits(text, length) {
  const binary = atob(text);
  const bits = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bits[i] = (binary.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  }
  return bits;
}
