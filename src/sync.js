/**
 * Multi-device sync with no account and no server of our own.
 *
 * Every game gets a code. The code is a topic on ntfy.sh, a free public
 * pub/sub relay: publishing is an HTTP POST and subscribing is a plain
 * EventSource, so there is no SDK and nothing to sign up for. Each device
 * broadcasts the whole game after it changes something, and adopts an
 * incoming copy when that copy is newer than its own.
 *
 * Conflict resolution is last-writer-wins on a (version, deviceId) pair. Two
 * people editing the very same second can lose one edit - acceptable for a
 * game where everyone is around one table and can see the screen.
 *
 * The relay is public: anyone who knows the code can read the game. Codes are
 * random and long enough not to be stumbled on, but this is a friendly card
 * game, not a bank.
 */

const RELAY = 'https://ntfy.sh';
const TOPIC_PREFIX = 'pokermgr-';

/** ntfy caps a message body; stay well under it and warn rather than truncate. */
const MAX_PAYLOAD = 3800;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 - people read these aloud

export function newGameCode(length = 6) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function newDeviceId() {
  return Math.random().toString(36).slice(2, 10);
}

/** Strip a game down to what peers actually need, to stay under the size cap. */
function packGame(game) {
  return {
    c: game.currency,
    m: game.mode,
    b: game.buyInCents,
    k: game.chipsPerBuyIn,
    a: game.adjustment,
    d: game.dealerIndex ?? 0,
    h: game.hand ?? null,
    x: game.paid ?? null,
    p: game.players.map((p) => ({
      i: p.id,
      n: p.name,
      b: p.buyIns,
      o: p.cashOut,
      s: p.stack ?? null,
    })),
  };
}

function unpackGame(packed, current) {
  return {
    ...current,
    currency: packed.c,
    mode: packed.m,
    buyInCents: packed.b,
    chipsPerBuyIn: packed.k,
    adjustment: packed.a ?? null,
    dealerIndex: packed.d ?? 0,
    hand: packed.h ?? null,
    paid: packed.x ?? {},
    players: (packed.p || []).map((p) => ({
      id: p.i,
      name: p.n,
      buyIns: p.b || [],
      cashOut: p.o ?? null,
      stack: p.s ?? null,
    })),
  };
}

/**
 * Create a sync session.
 *
 * `onState(game, meta)` fires when a peer sends a newer game.
 * `onStatus(status)` reports 'off' | 'connecting' | 'live' | 'error'.
 */
export function createSync({ onState, onStatus, onPeers }) {
  let source = null;
  let code = null;
  let version = 0;
  const deviceId = newDeviceId();
  const peers = new Set();
  let status = 'off';
  let lastSent = '';

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus?.(next);
  }

  function topicUrl(path) {
    return `${RELAY}/${TOPIC_PREFIX}${code}${path}`;
  }

  async function send(message) {
    if (!code) return false;
    const body = JSON.stringify({ ...message, d: deviceId });
    if (body.length > MAX_PAYLOAD) {
      onStatus?.('too-big');
      return false;
    }
    try {
      const response = await fetch(topicUrl(''), { method: 'POST', body });
      if (!response.ok) throw new Error(`relay responded ${response.status}`);
      return true;
    } catch {
      setStatus('error');
      return false;
    }
  }

  function handle(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.event && event.event !== 'message') return;

    let message;
    try {
      message = JSON.parse(event.message);
    } catch {
      return;
    }
    if (!message || message.d === deviceId) return;

    peers.add(message.d);
    onPeers?.(peers.size);

    if (message.t === 'req') {
      // A device just joined and has nothing; hand it the current game.
      onState?.(null, { wantsResend: true });
      return;
    }

    if (message.t === 'state' && message.g) {
      const newer =
        message.v > version || (message.v === version && message.d > deviceId);
      if (!newer) return;
      version = message.v;
      onState?.(message.g, { version: message.v, from: message.d });
    }
  }

  return {
    get code() {
      return code;
    },
    get status() {
      return status;
    },
    get deviceId() {
      return deviceId;
    },

    connect(gameCode) {
      this.disconnect();
      code = String(gameCode || '').trim().toUpperCase();
      if (!code) return;

      setStatus('connecting');
      try {
        source = new EventSource(topicUrl('/sse'));
      } catch {
        setStatus('error');
        return;
      }

      source.onopen = () => setStatus('live');
      source.onmessage = (event) => handle(event.data);
      source.onerror = () => {
        // EventSource retries on its own; report the gap without tearing down.
        setStatus(source && source.readyState === 1 ? 'live' : 'error');
      };

      // Ask whoever is already here for the current game.
      setTimeout(() => send({ t: 'req' }), 400);
    },

    disconnect() {
      if (source) {
        source.close();
        source = null;
      }
      code = null;
      peers.clear();
      setStatus('off');
    },

    /** Broadcast the game. Returns false when nothing needed sending. */
    async broadcast(game, { force = false } = {}) {
      if (!code) return false;
      const packed = packGame(game);
      const body = JSON.stringify(packed);
      if (!force && body === lastSent) return false;
      lastSent = body;
      version += 1;
      return send({ t: 'state', v: version, g: packed });
    },

    /** Adopt a packed game received from a peer. */
    merge(packed, current) {
      return unpackGame(packed, current);
    },
  };
}
