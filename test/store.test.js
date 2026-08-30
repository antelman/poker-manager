import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_SEATS, newPlayer, firstFreeSeat, normalizeSeats } from '../src/store.js';

const game = (seats) => ({
  players: seats.map((seat, i) => ({ id: `p${i}`, name: `p${i}`, buyIns: [], cashOut: null, seat })),
});

test('a new player carries the chair they were given', () => {
  assert.equal(newPlayer('אמיר', 5000, 4).seat, 4);
  assert.equal(newPlayer('אמיר', 5000).seat, null);
});

test('firstFreeSeat skips the chairs that are taken', () => {
  assert.equal(firstFreeSeat(game([0, 1, 2])), 3);
  assert.equal(firstFreeSeat(game([1, 3])), 0);
  assert.equal(firstFreeSeat(game([])), 0);
});

test('firstFreeSeat returns null once nine are sitting', () => {
  const full = game([...Array(MAX_SEATS).keys()]);
  assert.equal(firstFreeSeat(full), null);
});

test('normalizeSeats sorts the table by chair', () => {
  const g = game([5, 0, 3]);
  normalizeSeats(g);
  assert.deepEqual(g.players.map((p) => p.seat), [0, 3, 5]);
  assert.deepEqual(g.players.map((p) => p.id), ['p1', 'p2', 'p0']);
});

test('normalizeSeats seats a game saved before chairs existed', () => {
  const g = game([undefined, undefined, undefined]);
  normalizeSeats(g);
  assert.deepEqual(g.players.map((p) => p.seat), [0, 1, 2]);
});

test('normalizeSeats moves the second player off a clashing chair', () => {
  const g = game([2, 2, 0]);
  normalizeSeats(g);
  const seats = g.players.map((p) => p.seat);
  assert.equal(new Set(seats).size, 3, 'every chair is used once');
  assert.deepEqual([...seats].sort((a, b) => a - b), seats, 'and the list is in order');
});

test('normalizeSeats rejects a chair that is not at this table', () => {
  const g = game([99, -1]);
  normalizeSeats(g);
  assert.deepEqual(g.players.map((p) => p.seat), [0, 1]);
});
