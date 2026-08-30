/**
 * Persistence for the current game and the game history.
 *
 * Everything lives in localStorage so the app keeps working with no network,
 * and so a phone that locks mid-game does not lose the table.
 */

const KEY = 'poker-manager:v1';
export const SCHEMA_VERSION = 1;

/** A real table seats nine, and so does this one. */
export const MAX_SEATS = 9;

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function newGame(previous) {
  return {
    id: newId(),
    startedAt: Date.now(),
    endedAt: null,
    currency: previous?.currency ?? '₪',
    mode: previous?.mode ?? 'chips',
    buyInCents: previous?.buyInCents ?? 5000,
    chipsPerBuyIn: previous?.chipsPerBuyIn ?? 100,
    blinds: previous?.blinds ? { ...previous.blinds } : { small: 1, big: 2 },
    dealerIndex: 0,
    hand: null,
    players: [],
    adjustment: null,
  };
}

export function newPlayer(name, buyInCents, seat = null) {
  return {
    id: newId(),
    name: name.trim(),
    buyIns: buyInCents > 0 ? [buyInCents] : [],
    cashOut: null,
    seat,
  };
}

/** The lowest chair nobody is sitting in, or null when the table is full. */
export function firstFreeSeat(game) {
  const taken = new Set((game?.players || []).map((p) => p.seat));
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    if (!taken.has(seat)) return seat;
  }
  return null;
}

/**
 * Give everyone a chair and keep the list in seat order.
 *
 * Seats are what the table draws and what the betting order follows, so a
 * game that predates them - or one that arrives from a peer with a clash -
 * gets tidied up here rather than at every call site.
 */
export function normalizeSeats(game) {
  const players = game?.players;
  if (!Array.isArray(players)) return game;

  const taken = new Set();
  for (const player of players) {
    const seat = player.seat;
    if (Number.isInteger(seat) && seat >= 0 && seat < MAX_SEATS && !taken.has(seat)) {
      taken.add(seat);
    } else {
      player.seat = null;
    }
  }

  for (const player of players) {
    if (player.seat != null) continue;
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      if (taken.has(seat)) continue;
      player.seat = seat;
      taken.add(seat);
      break;
    }
  }

  // Anyone left over (a game saved before the nine-seat cap) sorts last.
  players.sort((a, b) => (a.seat ?? MAX_SEATS) - (b.seat ?? MAX_SEATS));
  return game;
}

function emptyState() {
  return { version: SCHEMA_VERSION, game: newGame(), history: [] };
}

export function load() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Private browsing or storage disabled - run in memory for this session.
    return emptyState();
  }
  if (!raw) return emptyState();

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION || !parsed.game) {
      return emptyState();
    }
    parsed.game.players = parsed.game.players || [];
    parsed.history = parsed.history || [];
    normalizeSeats(parsed.game);
    return parsed;
  } catch {
    return emptyState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Move the finished game into history and start a fresh one with the same settings. */
export function archive(state, summary) {
  const finished = {
    ...structuredClone(state.game),
    endedAt: Date.now(),
    summary,
  };
  const history = [finished, ...state.history].slice(0, 50);
  return { ...state, game: newGame(state.game), history };
}

export function exportJSON(state) {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}
