/**
 * Poker night settlement engine.
 *
 * All money is handled as integer agorot/cents. Floats only ever appear when
 * converting a chip count into money, and the result is rounded immediately.
 */

/** Convert a user-entered amount (e.g. 50 or 12.5) into integer cents. */
export function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Format integer cents for display: 5000 -> "50", 1250 -> "12.50". */
export function fromCents(cents) {
  const n = Number(cents) || 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const sign = n < 0 ? '-' : '';
  const body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
  return sign + body;
}

/** Money value of a single chip, in cents. May be fractional. */
export function chipValueCents(buyInCents, chipsPerBuyIn) {
  const chips = Number(chipsPerBuyIn);
  if (!chips || chips <= 0) return 0;
  return buyInCents / chips;
}

/**
 * Money a player put on the table, in cents.
 * `buyIns` is a list of individual amounts so rebuys of different sizes work.
 */
export function playerInCents(player) {
  return (player.buyIns || []).reduce((sum, c) => sum + (Number(c) || 0), 0);
}

/**
 * Money a player takes off the table, in cents.
 * In `chips` mode the stored value is a chip count; in `cash` mode it is
 * already an amount in cents.
 */
export function playerOutCents(player, { mode, buyInCents, chipsPerBuyIn }) {
  if (player.cashOut == null || player.cashOut === '') return 0;
  const raw = Number(player.cashOut) || 0;
  if (mode === 'cash') return Math.round(raw);
  return Math.round(raw * chipValueCents(buyInCents, chipsPerBuyIn));
}

/**
 * Full picture of a game: per-player money in/out/net plus the table totals.
 *
 * `diffCents` is what the table is off by: positive means more money was
 * counted out than went in (phantom chips), negative means chips are missing.
 */
export function computeGame(game) {
  const opts = {
    mode: game.mode || 'chips',
    buyInCents: game.buyInCents,
    chipsPerBuyIn: game.chipsPerBuyIn,
  };

  const players = (game.players || []).map((p) => {
    const inCents = playerInCents(p);
    const outCents = playerOutCents(p, opts);
    return {
      id: p.id,
      name: p.name,
      buyInCount: (p.buyIns || []).length,
      inCents,
      outCents,
      netCents: outCents - inCents,
      cashedOut: p.cashOut != null && p.cashOut !== '',
    };
  });

  const totalInCents = players.reduce((s, p) => s + p.inCents, 0);
  const totalOutCents = players.reduce((s, p) => s + p.outCents, 0);
  const allCashedOut = players.length > 0 && players.every((p) => p.cashedOut);

  return {
    players,
    totalInCents,
    totalOutCents,
    diffCents: totalOutCents - totalInCents,
    balanced: totalOutCents === totalInCents,
    allCashedOut,
    chipValueCents: chipValueCents(game.buyInCents, game.chipsPerBuyIn),
  };
}

/**
 * Turn net balances into a short list of "X pays Y" transfers.
 *
 * Greedy largest-debtor/largest-creditor matching. For n players with a
 * non-zero balance this settles in at most n-1 transfers, which is what you
 * want when people are actually handing each other cash at the table.
 *
 * If the nets do not sum to zero the extra is left unmatched and reported as
 * `unsettledCents` rather than being silently pushed onto one player.
 */
export function settle(players) {
  const debtors = players
    .filter((p) => p.netCents < 0)
    .map((p) => ({ id: p.id, name: p.name, amount: -p.netCents }))
    .sort((a, b) => b.amount - a.amount);

  const creditors = players
    .filter((p) => p.netCents > 0)
    .map((p) => ({ id: p.id, name: p.name, amount: p.netCents }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let d = 0;
  let c = 0;

  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].amount, creditors[c].amount);
    if (amount > 0) {
      transfers.push({
        fromId: debtors[d].id,
        from: debtors[d].name,
        toId: creditors[c].id,
        to: creditors[c].name,
        amountCents: amount,
      });
    }
    debtors[d].amount -= amount;
    creditors[c].amount -= amount;
    if (debtors[d].amount === 0) d += 1;
    if (creditors[c].amount === 0) c += 1;
  }

  const leftoverDebt = debtors.slice(d).reduce((s, x) => s + x.amount, 0);
  const leftoverCredit = creditors.slice(c).reduce((s, x) => s + x.amount, 0);

  return { transfers, unsettledCents: leftoverCredit - leftoverDebt };
}

/**
 * Spread a counting error across the players, so a table that is a few chips
 * off can still be settled.
 *
 * `even` splits it equally between everyone who cashed out; `proportional`
 * splits it in proportion to how much each player is taking off the table.
 * Returns adjusted cash-out amounts in cents, keyed by player id, with the
 * rounding remainder pushed onto the largest stack so the total lands exactly.
 */
export function distributeDiff(computed, mode = 'even') {
  const diff = computed.diffCents;
  const targets = computed.players.filter((p) => p.cashedOut);
  const result = {};
  for (const p of computed.players) result[p.id] = p.outCents;
  if (diff === 0 || targets.length === 0) return result;

  const totalOut = targets.reduce((s, p) => s + p.outCents, 0);
  const useProportional = mode === 'proportional' && totalOut > 0;

  let applied = 0;
  for (const p of targets) {
    const share = useProportional
      ? Math.round((diff * p.outCents) / totalOut)
      : Math.round(diff / targets.length);
    result[p.id] = p.outCents - share;
    applied += share;
  }

  // Rounding remainder goes to the biggest stack, which absorbs it best.
  const remainder = diff - applied;
  if (remainder !== 0) {
    const biggest = targets.reduce((a, b) => (b.outCents > a.outCents ? b : a));
    result[biggest.id] -= remainder;
  }

  return result;
}

/** Rank players by net result, best first. */
export function leaderboard(computed) {
  return [...computed.players].sort((a, b) => b.netCents - a.netCents);
}

/* ==========================================================================
   Live hand tracking
   Chips are tracked so the table always knows what each player is sitting
   behind, and so the end-of-night count can be filled in from the running
   total instead of counting every stack by hand.
   ========================================================================== */

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

export function newHand(number = 1) {
  return { n: number, street: 'preflop', board: [], bets: {}, open: true };
}

/** Chips a player received for the money they bought in with. */
export function buyInChips(player, game) {
  const count = (player.buyIns || []).length;
  if (game.mode === 'cash') return 0;
  return count * (Number(game.chipsPerBuyIn) || 0);
}

/** Everything wagered so far in the open hand. */
export function handPot(hand) {
  if (!hand) return 0;
  return Object.values(hand.bets || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * What a player is sitting behind right now, in chips: the chips they bought,
 * plus everything they have won or lost in completed hands, minus whatever
 * they have already pushed into the pot of the hand in progress.
 */
export function playerStackChips(player, game) {
  const settled = Number(player.chipsWon) || 0;
  const inPot = Number(game.hand?.bets?.[player.id]) || 0;
  return buyInChips(player, game) + settled - inPot;
}

/**
 * Close the open hand, awarding the pot to the winners (split evenly, with the
 * odd chip going to the first winner - the usual house rule).
 *
 * Returns the updated `chipsWon` per player; the caller writes them back.
 */
export function closeHand(game, winnerIds) {
  const hand = game.hand;
  const result = {};
  for (const p of game.players) result[p.id] = Number(p.chipsWon) || 0;
  if (!hand) return result;

  for (const p of game.players) {
    result[p.id] -= Number(hand.bets?.[p.id]) || 0;
  }

  const winners = (winnerIds || []).filter((id) => result[id] !== undefined);
  const pot = handPot(hand);
  if (winners.length === 0 || pot === 0) return result;

  const share = Math.floor(pot / winners.length);
  for (const id of winners) result[id] += share;
  result[winners[0]] += pot - share * winners.length;

  return result;
}
