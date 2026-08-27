/**
 * Persistence for the current game and the game history.
 *
 * Everything lives in localStorage so the app keeps working with no network,
 * and so a phone that locks mid-game does not lose the table.
 */

const KEY = 'poker-manager:v1';
export const SCHEMA_VERSION = 1;

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
    players: [],
    adjustment: null,
  };
}

export function newPlayer(name, buyInCents) {
  return {
    id: newId(),
    name: name.trim(),
    buyIns: buyInCents > 0 ? [buyInCents] : [],
    cashOut: null,
  };
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
