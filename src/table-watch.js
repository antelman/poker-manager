/**
 * Watching a table for a whole evening.
 *
 * The camera can see two things a dealer would otherwise have to type: cards
 * arriving, and cards being swept away. That is enough to run the round on its
 * own - open a hand when the deal lands, fill the board as it comes, and close
 * the hand when the table is cleared - and it stops exactly where the camera
 * stops knowing anything: who took the pot.
 *
 * The whole job here is refusing to react to a moment. A hand reaching over
 * the cards, a phone knocked sideways, a player squaring up the board: all of
 * them make cards vanish for a fraction of a second. So arrivals and
 * departures both have to hold for a while before they mean anything, and a
 * countdown that has started is cancelled the moment a card comes back.
 *
 * Pure and clock-free: it is fed `now` and what the frame showed, and it
 * answers with events. `app.js` decides what those events do to the game.
 */

export const WATCH_DEFAULTS = {
  /** Cards have to be on the table this long before a hand opens. */
  dealMs: 1200,
  /** And gone this long before it closes. */
  clearMs: 3500,
  /** A blip of emptiness shorter than this is never even shown. */
  graceMs: 700,
};

export const WATCHING = 'waiting';
export const LIVE = 'live';
export const CLEARING = 'clearing';

export class TableWatch {
  constructor(options = {}) {
    this.options = { ...WATCH_DEFAULTS, ...options };
    this.state = WATCHING;
    this.occupiedSince = null;
    this.emptySince = null;
    this.announcedClearing = false;
    this.seen = new Set();
  }

  /**
   * Feed one processed frame.
   *
   * `occupied` is whether any card-shaped thing is on the table - cards face
   * down, blurred or half covered all count, because the question is whether
   * the table is in play, not what the cards are. `labels` are the cards read
   * confidently enough to act on.
   *
   * Returns the events this frame produced, oldest first.
   */
  update({ now, occupied, labels = [] }) {
    const events = [];
    const { dealMs, clearMs, graceMs } = this.options;

    if (this.state === WATCHING) {
      if (!occupied) {
        this.occupiedSince = null;
        return events;
      }
      if (this.occupiedSince === null) this.occupiedSince = now;
      if (now - this.occupiedSince < dealMs) return events;

      this.state = LIVE;
      this.emptySince = null;
      this.announcedClearing = false;
      this.seen.clear();
      events.push({ type: 'deal', at: now });
    }

    if (this.state === LIVE || this.state === CLEARING) {
      if (occupied) {
        if (this.state === CLEARING) {
          this.state = LIVE;
          if (this.announcedClearing) events.push({ type: 'settled', at: now });
          this.announcedClearing = false;
        }
        this.emptySince = null;
      } else {
        if (this.emptySince === null) this.emptySince = now;
        this.state = CLEARING;
        const empty = now - this.emptySince;
        if (empty >= graceMs && !this.announcedClearing) {
          this.announcedClearing = true;
          events.push({ type: 'clearing', at: now, endsAt: this.emptySince + clearMs });
        }
        if (empty >= clearMs) {
          this.state = WATCHING;
          this.occupiedSince = null;
          this.emptySince = null;
          this.announcedClearing = false;
          this.seen.clear();
          events.push({ type: 'handEnd', at: now });
          return events;
        }
      }
    }

    // Cards are only ever announced once per hand: the board keeps what it was
    // given, and a card re-read on the next frame is not a new card.
    if (this.state !== WATCHING) {
      const fresh = labels.filter((label) => label && !this.seen.has(label));
      for (const label of fresh) this.seen.add(label);
      if (fresh.length > 0) events.push({ type: 'cards', at: now, labels: fresh });
    }
    return events;
  }

  /** Milliseconds left before the hand closes, or null when nothing is closing. */
  countdown(now) {
    if (this.state !== CLEARING || !this.announcedClearing) return null;
    return Math.max(0, this.emptySince + this.options.clearMs - now);
  }

  /**
   * Forget the hand without emitting anything - for when the game moves on
   * without the camera (a hand closed by hand, a new game, the camera off).
   */
  reset(state = WATCHING) {
    this.state = state;
    this.occupiedSince = null;
    this.emptySince = null;
    this.announcedClearing = false;
    this.seen.clear();
  }

  /** Adopt the game's truth: a hand is already open, so do not deal another. */
  assumeLive(labels = []) {
    this.reset(LIVE);
    for (const label of labels) if (label) this.seen.add(label);
  }
}
