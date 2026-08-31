import test from 'node:test';
import assert from 'node:assert/strict';

import { TableWatch, WATCHING, LIVE, CLEARING } from '../src/table-watch.js';

/** Feed a run of frames 100ms apart and collect everything that came out. */
function play(watch, frames, start = 1000) {
  const events = [];
  let now = start;
  for (const frame of frames) {
    const step = typeof frame.step === 'number' ? frame.step : 100;
    now += step;
    for (const event of watch.update({ now, ...frame })) events.push({ ...event, now });
  }
  return { events, now };
}

const occupied = (n, labels = []) => Array.from({ length: n }, () => ({ occupied: true, labels }));
const empty = (n) => Array.from({ length: n }, () => ({ occupied: false }));
const types = (events) => events.map((event) => event.type);

test('an empty table stays quiet', () => {
  const watch = new TableWatch();
  const { events } = play(watch, empty(40));
  assert.deepEqual(events, []);
  assert.equal(watch.state, WATCHING);
});

test('a deal opens a hand, but only once it holds', () => {
  const watch = new TableWatch({ dealMs: 1000 });
  const early = play(watch, occupied(5)); // half a second
  assert.deepEqual(types(early.events), []);
  const later = play(watch, occupied(6), early.now);
  assert.deepEqual(types(later.events), ['deal']);
  assert.equal(watch.state, LIVE);
});

test('a speck flickering on an empty table does not stop the round closing', () => {
  // The wooden table the app is actually used on: every couple of seconds the
  // grain, a chip edge or a sleeve outlines as something card-shaped for a
  // frame or two. Before, each of those cancelled the countdown and the round
  // stayed open all evening.
  const watch = new TableWatch({ dealMs: 500, clearMs: 3000, graceMs: 300, returnMs: 700 });
  play(watch, occupied(10, ['As']));
  assert.equal(watch.state, LIVE);

  const blips = [];
  for (let i = 0; i < 5; i++) blips.push(...empty(8), ...occupied(2));
  const { events } = play(watch, blips);
  assert.ok(types(events).includes('handEnd'), `never closed: ${types(events).join()}`);
  assert.equal(watch.state, WATCHING);
});

test('a countdown keeps the time it has counted through a blip', () => {
  const watch = new TableWatch({ dealMs: 500, clearMs: 2000, graceMs: 300, returnMs: 700 });
  play(watch, occupied(10, ['As']));
  const run = play(watch, [...empty(15), ...occupied(2), ...empty(4)]);
  // 1.5s empty, a 0.2s blip, 0.4s more: the blip neither cancelled the
  // countdown nor pushed the close out past its two seconds.
  assert.ok(types(run.events).includes('handEnd'));
});

test('cards really coming back call the countdown off at once', () => {
  const watch = new TableWatch({ dealMs: 500, clearMs: 3000, graceMs: 300, returnMs: 700 });
  play(watch, occupied(10, ['As']));
  const gone = play(watch, empty(8));
  assert.deepEqual(types(gone.events), ['clearing']);
  // One frame with a card that was actually read is enough.
  const back = play(watch, occupied(1, ['Kh']), gone.now);
  assert.deepEqual(types(back.events), ['settled', 'cards']);
  assert.equal(watch.state, LIVE);
});

test('a shape that stays also calls it off, once it has stayed', () => {
  const watch = new TableWatch({ dealMs: 500, clearMs: 5000, graceMs: 300, returnMs: 700 });
  play(watch, occupied(10, ['As']));
  const gone = play(watch, empty(8));
  assert.deepEqual(types(gone.events), ['clearing']);
  const brief = play(watch, occupied(3), gone.now); // 0.3s - not yet
  assert.deepEqual(types(brief.events), []);
  assert.equal(watch.state, CLEARING);
  const held = play(watch, occupied(6), brief.now); // now it has stayed
  assert.deepEqual(types(held.events), ['settled']);
  assert.equal(watch.state, LIVE);
});

test('a card passing through the frame is not a deal', () => {
  const watch = new TableWatch({ dealMs: 1000 });
  const { events } = play(watch, [...occupied(6), ...empty(2), ...occupied(6)]);
  // The counter restarts when the table empties, so neither run is long enough.
  assert.deepEqual(types(events), []);
  assert.equal(watch.state, WATCHING);
});

test('cards are announced once each, as they turn up', () => {
  const watch = new TableWatch({ dealMs: 200 });
  const flop = play(watch, occupied(4, ['As', 'Kh', '7d']));
  assert.deepEqual(types(flop.events), ['deal', 'cards']);
  assert.deepEqual(flop.events[1].labels, ['As', 'Kh', '7d']);

  const turn = play(watch, occupied(3, ['As', 'Kh', '7d', '10c']), flop.now);
  assert.deepEqual(types(turn.events), ['cards']);
  assert.deepEqual(turn.events[0].labels, ['10c'], 'only the new card');
});

test('clearing the table ends the hand, after a pause and a warning', () => {
  const watch = new TableWatch({ dealMs: 200, graceMs: 500, clearMs: 2000 });
  const live = play(watch, occupied(4, ['As']));
  assert.deepEqual(types(live.events), ['deal', 'cards']);

  const gone = play(watch, empty(25), live.now);
  assert.deepEqual(types(gone.events), ['clearing', 'handEnd']);
  const [clearing, handEnd] = gone.events;
  assert.ok(clearing.now - live.now >= 500, 'the warning waits out the grace');
  assert.ok(handEnd.now - live.now >= 2000, 'and the close waits out the full window');
  assert.equal(watch.state, WATCHING);
});

test('a hand reaching over the cards cancels the countdown', () => {
  const watch = new TableWatch({ dealMs: 200, graceMs: 300, clearMs: 3000 });
  play(watch, occupied(4, ['As']));
  const { events } = play(watch, [...empty(8), ...occupied(4, ['As'])]);
  assert.deepEqual(types(events), ['clearing', 'settled']);
  assert.equal(watch.state, LIVE);
});

test('a blink shorter than the grace is never even mentioned', () => {
  const watch = new TableWatch({ dealMs: 200, graceMs: 700, clearMs: 3000 });
  play(watch, occupied(4, ['As']));
  const { events } = play(watch, [...empty(3), ...occupied(3, ['As'])]);
  assert.deepEqual(types(events), []);
  assert.equal(watch.state, LIVE);
});

test('the countdown reports what is left, and nothing when idle', () => {
  const watch = new TableWatch({ dealMs: 200, graceMs: 300, clearMs: 2000 });
  const live = play(watch, occupied(4, ['As']));
  assert.equal(watch.countdown(live.now), null);
  const gone = play(watch, empty(5), live.now);
  const left = watch.countdown(gone.now);
  assert.ok(left > 0 && left < 2000, `countdown was ${left}`);
  assert.equal(watch.state, CLEARING);
});

test('the next deal is a fresh hand, and repeats all evening', () => {
  const watch = new TableWatch({ dealMs: 300, graceMs: 200, clearMs: 1000 });
  let now = 0;
  const seen = [];
  for (let hand = 0; hand < 3; hand++) {
    const dealt = play(watch, occupied(6, ['As', 'Kh']), now);
    const cleared = play(watch, empty(15), dealt.now);
    now = cleared.now;
    seen.push([...types(dealt.events), ...types(cleared.events)]);
  }
  for (const hand of seen) {
    assert.deepEqual(hand, ['deal', 'cards', 'clearing', 'handEnd']);
  }
});

test('the same cards in the next hand are announced again', () => {
  const watch = new TableWatch({ dealMs: 200, graceMs: 200, clearMs: 800 });
  const first = play(watch, occupied(3, ['As']));
  const cleared = play(watch, empty(12), first.now);
  assert.deepEqual(types(cleared.events), ['clearing', 'handEnd']);
  const second = play(watch, occupied(4, ['As']), cleared.now);
  assert.deepEqual(types(second.events), ['deal', 'cards']);
  assert.deepEqual(second.events[1].labels, ['As']);
});

test('adopting an open hand does not deal a second one', () => {
  const watch = new TableWatch({ dealMs: 200 });
  watch.assumeLive(['As', 'Kh']);
  const { events } = play(watch, occupied(6, ['As', 'Kh', '7d']));
  assert.deepEqual(types(events), ['cards']);
  assert.deepEqual(events[0].labels, ['7d'], 'the board it already had is not re-announced');
});

test('resetting drops everything without a word', () => {
  const watch = new TableWatch({ dealMs: 200, clearMs: 800 });
  play(watch, occupied(4, ['As']));
  watch.reset();
  assert.equal(watch.state, WATCHING);
  const { events } = play(watch, empty(20));
  assert.deepEqual(types(events), []);
});
