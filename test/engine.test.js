import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toCents,
  fromCents,
  chipValueCents,
  computeGame,
  settle,
  distributeDiff,
  leaderboard,
} from '../src/engine.js';

const game = (players, overrides = {}) => ({
  mode: 'chips',
  buyInCents: 5000,
  chipsPerBuyIn: 100,
  players,
  ...overrides,
});

const player = (id, name, buyIns, cashOut) => ({ id, name, buyIns, cashOut });

test('toCents handles integers, decimals and junk', () => {
  assert.equal(toCents(50), 5000);
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents('7.35'), 735);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), 0);
});

test('fromCents renders whole amounts without decimals', () => {
  assert.equal(fromCents(5000), '50');
  assert.equal(fromCents(1250), '12.50');
  assert.equal(fromCents(1205), '12.05');
  assert.equal(fromCents(-750), '-7.50');
  assert.equal(fromCents(0), '0');
});

test('chipValueCents divides the buy-in across the stack', () => {
  assert.equal(chipValueCents(5000, 100), 50);
  assert.equal(chipValueCents(5000, 0), 0);
});

test('computeGame totals buy-ins, cash-outs and nets', () => {
  const result = computeGame(
    game([
      player('a', 'Dana', [5000], 150), // 150 chips -> 75
      player('b', 'Roi', [5000, 5000], 50), // 50 chips -> 25
    ])
  );

  assert.equal(result.totalInCents, 15000);
  assert.equal(result.totalOutCents, 10000);
  assert.equal(result.diffCents, -5000);
  assert.equal(result.balanced, false);
  assert.equal(result.allCashedOut, true);

  const [dana, roi] = result.players;
  assert.equal(dana.inCents, 5000);
  assert.equal(dana.outCents, 7500);
  assert.equal(dana.netCents, 2500);
  assert.equal(roi.buyInCount, 2);
  assert.equal(roi.netCents, -7500);
});

test('computeGame in cash mode reads cash-out as money', () => {
  const result = computeGame(
    game([player('a', 'Dana', [5000], 8000)], { mode: 'cash' })
  );
  assert.equal(result.players[0].outCents, 8000);
  assert.equal(result.players[0].netCents, 3000);
});

test('a player who has not cashed out counts as zero but is flagged', () => {
  const result = computeGame(game([player('a', 'Dana', [5000], null)]));
  assert.equal(result.players[0].outCents, 0);
  assert.equal(result.players[0].cashedOut, false);
  assert.equal(result.allCashedOut, false);
});

test('settle clears a balanced table with n-1 transfers at most', () => {
  const players = [
    { id: 'a', name: 'Dana', netCents: 10000 },
    { id: 'b', name: 'Roi', netCents: -6000 },
    { id: 'c', name: 'Tal', netCents: -4000 },
  ];
  const { transfers, unsettledCents } = settle(players);

  assert.equal(unsettledCents, 0);
  assert.ok(transfers.length <= players.length - 1);
  const total = transfers.reduce((s, t) => s + t.amountCents, 0);
  assert.equal(total, 10000);
  assert.ok(transfers.every((t) => t.to === 'Dana'));
});

test('settle nets out every player exactly', () => {
  const players = [
    { id: 'a', name: 'A', netCents: 7000 },
    { id: 'b', name: 'B', netCents: 3000 },
    { id: 'c', name: 'C', netCents: -2500 },
    { id: 'd', name: 'D', netCents: -7500 },
  ];
  const { transfers } = settle(players);

  const balance = new Map(players.map((p) => [p.id, 0]));
  for (const t of transfers) {
    balance.set(t.fromId, balance.get(t.fromId) - t.amountCents);
    balance.set(t.toId, balance.get(t.toId) + t.amountCents);
  }
  for (const p of players) assert.equal(balance.get(p.id), p.netCents);
});

test('settle ignores players who broke even', () => {
  const { transfers } = settle([
    { id: 'a', name: 'A', netCents: 5000 },
    { id: 'b', name: 'B', netCents: 0 },
    { id: 'c', name: 'C', netCents: -5000 },
  ]);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].from, 'C');
  assert.equal(transfers[0].to, 'A');
});

test('settle reports an unbalanced table instead of hiding it', () => {
  const { transfers, unsettledCents } = settle([
    { id: 'a', name: 'A', netCents: 5000 },
    { id: 'b', name: 'B', netCents: -3000 },
  ]);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amountCents, 3000);
  assert.equal(unsettledCents, 2000);
});

test('settle on an empty table does nothing', () => {
  const { transfers, unsettledCents } = settle([]);
  assert.deepEqual(transfers, []);
  assert.equal(unsettledCents, 0);
});

test('distributeDiff evenly absorbs a miscount and lands exactly', () => {
  const computed = computeGame(
    game([
      player('a', 'A', [5000], 120), // 60
      player('b', 'B', [5000], 90), // 45
      player('c', 'C', [5000], 90), // 45
    ])
  );
  assert.equal(computed.diffCents, 0);

  // 5 shekels' worth of chips went missing off the table.
  const short = computeGame(
    game([
      player('a', 'A', [5000], 120), // 60
      player('b', 'B', [5000], 90), // 45
      player('c', 'C', [5000], 80), // 40
    ])
  );
  assert.equal(short.diffCents, -500);

  const adjusted = distributeDiff(short, 'even');
  const total = Object.values(adjusted).reduce((s, v) => s + v, 0);
  assert.equal(total, short.totalInCents);
  // Everyone is credited back their share of the shortfall.
  for (const p of short.players) assert.ok(adjusted[p.id] > p.outCents);
});

test('distributeDiff proportionally lands exactly too', () => {
  const short = computeGame(
    game([
      player('a', 'A', [5000], 130),
      player('b', 'B', [5000], 90),
      player('c', 'C', [5000], 47),
    ])
  );
  const adjusted = distributeDiff(short, 'proportional');
  const total = Object.values(adjusted).reduce((s, v) => s + v, 0);
  assert.equal(total, short.totalInCents);
});

test('distributeDiff is a no-op on a balanced table', () => {
  const computed = computeGame(
    game([player('a', 'A', [5000], 150), player('b', 'B', [5000], 50)])
  );
  const adjusted = distributeDiff(computed, 'even');
  assert.deepEqual(adjusted, { a: 7500, b: 2500 });
});

test('leaderboard ranks winners first', () => {
  const computed = computeGame(
    game([
      player('a', 'A', [5000], 50),
      player('b', 'B', [5000], 200),
      player('c', 'C', [5000], 50),
    ])
  );
  const ranked = leaderboard(computed);
  assert.equal(ranked[0].name, 'B');
  assert.equal(ranked[0].netCents, 5000);
});

test('end to end: three players, rebuys, settles to zero', () => {
  const computed = computeGame(
    game([
      player('a', 'Dana', [5000, 5000], 40), // in 100, out 20
      player('b', 'Roi', [5000], 260), // in 50, out 130
      player('c', 'Tal', [5000], 100), // in 50, out 50
    ])
  );

  assert.equal(computed.totalInCents, 20000);
  assert.equal(computed.totalOutCents, 20000);
  assert.equal(computed.balanced, true);

  const { transfers, unsettledCents } = settle(computed.players);
  assert.equal(unsettledCents, 0);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].from, 'Dana');
  assert.equal(transfers[0].to, 'Roi');
  assert.equal(transfers[0].amountCents, 8000);
});
