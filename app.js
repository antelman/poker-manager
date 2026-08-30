import {
  toCents,
  fromCents,
  computeGame,
  settle,
  distributeDiff,
  leaderboard,
  newHand,
  handPot,
  playerStackChips,
  buyInChips,
  currentBet,
  callAmount,
  blindBets,
  activePlayers,
  sidePots,
  closeHandWithPots,
  STREETS,
} from './src/engine.js';

import {
  load,
  save,
  archive,
  newGame,
  newPlayer,
  exportJSON,
  normalizeSeats,
  firstFreeSeat,
  MAX_SEATS,
} from './src/store.js';
import { createSync, newGameCode } from './src/sync.js';

/* ------------------------------------------------------------------ state */

let state = load();
let activeView = 'game';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** Hebrew counts read badly as "1 שחקנים", so singular gets its own wording. */
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

const money = (cents) => `${state.game.currency}${fromCents(cents)}`;
const signedMoney = (cents) =>
  `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${state.game.currency}${fromCents(Math.abs(cents))}`;

function persist() {
  save(state);
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

/* -------------------------------------------------------------- computing */

/**
 * Current game plus the settlement derived from it. When a balance adjustment
 * is active the nets are recomputed from the adjusted cash-outs, so the
 * transfers always add up to exactly zero.
 */
function currentResults() {
  const computed = computeGame(state.game);

  // Only spread a counting error once the whole table is counted - applying it
  // mid-count would dump everyone else's uncounted chips onto whoever is done.
  const adjusted =
    state.game.adjustment && computed.allCashedOut
      ? distributeDiff(computed, state.game.adjustment)
      : null;

  const players = computed.players.map((p) => {
    const outCents = adjusted ? adjusted[p.id] : p.outCents;
    return { ...p, outCents, netCents: outCents - p.inCents };
  });

  const effective = {
    ...computed,
    players,
    totalOutCents: players.reduce((s, p) => s + p.outCents, 0),
  };
  effective.diffCents = effective.totalOutCents - effective.totalInCents;
  effective.balanced = effective.diffCents === 0;

  return { computed, effective, settlement: settle(players) };
}

/** Total chips that should be on the table, given everything bought in. */
function chipsInPlay() {
  const { totalInCents } = computeGame(state.game);
  if (state.game.mode === 'cash') return totalInCents;
  const perChip = state.game.buyInCents / state.game.chipsPerBuyIn;
  return perChip > 0 ? Math.round(totalInCents / perChip) : 0;
}

/* --------------------------------------------------------------- rendering */

function render() {
  renderTopBar();
  renderSettings();
  renderPlayers();
  renderRound();
  renderTotals();
  renderCount();
  renderSettle();
  renderHistory();
}

function renderTopBar() {
  const { totalInCents } = computeGame(state.game);
  $('potValue').textContent = money(totalInCents);
}

function renderSettings() {
  const g = state.game;
  $('buyInInput').value = fromCents(g.buyInCents);
  $('chipsInput').value = g.chipsPerBuyIn;
  $('currencyInput').value = g.currency;
  $('modeInput').value = g.mode;
  $('chipsField').hidden = g.mode === 'cash';
  $('smallBlindInput').value = g.blinds?.small ?? 1;
  $('bigBlindInput').value = g.blinds?.big ?? 2;

  $('settingsPreview').textContent =
    g.mode === 'chips'
      ? `${money(g.buyInCents)} · ${g.chipsPerBuyIn} ז'יטונים`
      : `${money(g.buyInCents)} · ספירה בכסף`;

  $('chipValueHint').textContent =
    g.mode === 'chips' && g.chipsPerBuyIn > 0
      ? `כל ז'יטון שווה ${money(Math.round((g.buyInCents / g.chipsPerBuyIn) * 100) / 100)}. בסוף המשחק כל שחקן מזין כמה ז'יטונים נשארו לו.`
      : 'בסוף המשחק כל שחקן מזין ישירות את סכום הכסף שנשאר לו.';
}

/** Empty state with one of the sprite icons from index.html. */
function emptyCard(iconId, message) {
  const wrap = el('div', 'panel empty');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'empty-icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${iconId}`);
  svg.append(use);
  wrap.append(svg, el('p', null, message));
  return wrap;
}

function renderPlayers() {
  const list = $('playersList');
  list.textContent = '';

  if (state.game.players.length === 0) {
    list.append(emptyCard('i-chip', 'עוד לא הוספת שחקנים. תוסיף את כולם למעלה ונתחיל.'));
    return;
  }

  const computed = computeGame(state.game);

  for (const player of state.game.players) {
    const stats = computed.players.find((p) => p.id === player.id);
    const row = el('div', 'player');

    const main = el('div', 'player-main');
    main.append(el('div', 'player-name', player.name));
    main.append(
      el(
        'div',
        'player-meta',
        `${plural(stats.buyInCount, 'כניסה אחת', 'כניסות')} · ${money(stats.inCents)}`
      )
    );

    const stepper = el('div', 'stepper');

    const minus = el('button', 'step-btn', '−');
    minus.type = 'button';
    minus.dataset.action = 'buyin-minus';
    minus.dataset.id = player.id;
    minus.disabled = stats.buyInCount === 0;
    minus.setAttribute('aria-label', `הורד כניסה ל${player.name}`);

    const count = el('span', 'step-count', String(stats.buyInCount));

    const plus = el('button', 'step-btn plus', '+');
    plus.type = 'button';
    plus.dataset.action = 'buyin-plus';
    plus.dataset.id = player.id;
    plus.setAttribute('aria-label', `הוסף כניסה ל${player.name}`);

    stepper.append(minus, count, plus);

    const remove = el('button', 'player-remove', '✕');
    remove.type = 'button';
    remove.dataset.action = 'remove-player';
    remove.dataset.id = player.id;
    remove.setAttribute('aria-label', `הסר את ${player.name}`);

    row.append(main, stepper, remove);
    list.append(row);
  }
}

function renderTotals() {
  const box = $('gameTotals');
  box.textContent = '';

  const computed = computeGame(state.game);
  if (state.game.players.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const totalBuyIns = computed.players.reduce((s, p) => s + p.buyInCount, 0);

  box.append(
    line('שחקנים', String(state.game.players.length)),
    line('סה"כ כניסות', String(totalBuyIns)),
    line('בקופה', money(computed.totalInCents), true)
  );

  if (state.game.mode === 'chips') {
    box.append(line("ז'יטונים על השולחן", String(chipsInPlay())));
  }

  function line(label, value, big) {
    const row = el('div', `total-line${big ? ' big' : ''}`);
    row.append(el('span', null, label), el('strong', null, value));
    return row;
  }
}

function renderCount() {
  const list = $('countList');
  const status = $('countStatus');
  list.textContent = '';
  status.textContent = '';

  const g = state.game;
  $('countHint').textContent =
    g.mode === 'chips'
      ? `כל שחקן סופר את הז'יטונים שנשארו לו ומזין את המספר. כל ז'יטון = ${money(Math.round((g.buyInCents / g.chipsPerBuyIn) * 100) / 100)}.`
      : 'כל שחקן מזין את סכום הכסף שנשאר לו על השולחן.';

  if (g.players.length === 0) {
    list.append(emptyCard('i-stack', 'אין שחקנים עדיין. תחזור למסך "משחק" ותוסיף אותם.'));
    status.hidden = true;
    return;
  }
  status.hidden = false;

  const { computed } = currentResults();
  const counted = computed.players.filter((p) => p.cashedOut).length;

  for (const player of g.players) {
    const stats = computed.players.find((p) => p.id === player.id);
    const row = el('div', 'player count-row');

    const main = el('div', 'player-main');
    main.append(el('div', 'player-name', player.name));
    main.append(el('div', 'player-meta', `הכניס ${money(stats.inCents)}`));
    if (stats.cashedOut) main.append(countValueLine(stats));

    const field = el('div', 'count-input');
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = '0';
    input.step = g.mode === 'chips' ? '1' : '0.5';
    input.placeholder = g.mode === 'chips' ? "ז'יטונים" : 'סכום';
    input.value = player.cashOut == null ? '' : formatCashOut(player.cashOut);
    input.dataset.action = 'cash-out';
    input.dataset.id = player.id;
    input.setAttribute('aria-label', `ספירת סיום של ${player.name}`);
    field.append(input);

    const quick = el('div', 'chip-quick');
    quick.append(
      quickBtn('0', 'cash-zero', player.id),
      quickBtn('מה שנשאר', 'cash-rest', player.id)
    );

    row.append(main, field, quick);
    list.append(row);
  }

  const tracked = state.game.players.some((p) => Number(p.chipsWon) !== 0);
  if (tracked && state.game.mode === 'chips') {
    const fill = el('button', 'btn btn-block', 'מלא את הספירה לפי מעקב הסיבובים');
    fill.type = 'button';
    fill.dataset.action = 'fill-from-tracking';
    const wrap = el('div', 'panel');
    wrap.append(fill);
    wrap.append(el('p', 'hint', 'ממלא לכל שחקן את מה שהמעקב אומר שיש לו. אפשר לתקן ידנית אחר כך.'));
    list.prepend(wrap);
  }

  renderCountStatus(status, counted);

  function quickBtn(label, action, id) {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.action = action;
    b.dataset.id = id;
    return b;
  }
}

function formatCashOut(value) {
  return state.game.mode === 'chips' ? String(value) : fromCents(value);
}

/** "שווה ₪20 · −₪80", with the net coloured by whether the player is up or down. */
function countValueLine(stats) {
  const line = el('div', 'count-value');
  line.append(el('span', null, `שווה ${money(stats.outCents)} · `));
  const net = el(
    'span',
    stats.netCents > 0 ? 'net-win' : stats.netCents < 0 ? 'net-lose' : 'net-even'
  );
  net.textContent = signedMoney(stats.netCents);
  line.append(net);
  return line;
}

function renderCountStatus(status, counted) {
  const { computed, effective } = currentResults();
  const total = state.game.players.length;
  status.className = 'card';

  const head = el('div', 'total-line');
  head.append(el('span', null, 'נספרו'), el('strong', null, `${counted} / ${total}`));

  const inLine = el('div', 'total-line');
  inLine.append(el('span', null, 'נכנס לקופה'), el('strong', null, money(effective.totalInCents)));

  const outLine = el('div', 'total-line');
  outLine.append(el('span', null, 'נספר על השולחן'), el('strong', null, money(effective.totalOutCents)));

  status.append(head, inLine, outLine);

  if (counted < total) {
    const note = el('div', 'status warn');
    const left = total - counted;
    note.append(el('div', 'status-title', 'עוד לא סיימתם לספור'));
    note.append(
      el(
        'div',
        null,
        left === 1 ? 'נשאר שחקן אחד בלי ספירה.' : `נשארו ${left} שחקנים בלי ספירה.`
      )
    );
    status.append(note);
    return;
  }

  if (effective.balanced) {
    const note = el('div', 'status ok');
    note.append(el('div', 'status-title', '✓ הקופה מאוזנת'));
    note.append(
      el(
        'div',
        null,
        state.game.adjustment
          ? 'ההפרש חולק בין השחקנים. אפשר לעבור למסך "חשבון".'
          : 'הכל מסתדר בדיוק. אפשר לעבור למסך "חשבון".'
      )
    );
    if (state.game.adjustment) {
      const actions = el('div', 'status-actions');
      const undo = el('button', 'btn btn-ghost', 'בטל את חלוקת ההפרש');
      undo.type = 'button';
      undo.dataset.action = 'clear-adjustment';
      actions.append(undo);
      note.append(actions);
    }
    status.append(note);
    return;
  }

  const diff = computed.diffCents;
  const note = el('div', 'status warn');
  note.append(
    el(
      'div',
      'status-title',
      diff < 0
        ? `חסרים ${money(Math.abs(diff))} בספירה`
        : `יש ${money(diff)} עודף בספירה`
    )
  );
  note.append(
    el(
      'div',
      null,
      diff < 0
        ? 'הסכום שנספר קטן ממה שנכנס לקופה. תבדקו את הספירה, או תחלקו את ההפרש בין השחקנים.'
        : 'נספר יותר כסף ממה שנכנס לקופה. תבדקו את הספירה, או תחלקו את ההפרש בין השחקנים.'
    )
  );

  const actions = el('div', 'status-actions');
  const even = el('button', 'btn', 'חלק שווה בשווה');
  even.type = 'button';
  even.dataset.action = 'adjust-even';
  const prop = el('button', 'btn', 'חלק לפי גודל הערימה');
  prop.type = 'button';
  prop.dataset.action = 'adjust-proportional';
  actions.append(even, prop);
  note.append(actions);
  status.append(note);
}

function renderSettle() {
  const root = $('settleContent');
  root.textContent = '';

  if (state.game.players.length === 0) {
    root.append(emptyCard('i-pay', 'אין עדיין משחק לחשב. תוסיף שחקנים ותתחיל לשחק.'));
    return;
  }

  const { effective, settlement } = currentResults();
  const counted = effective.players.filter((p) => p.cashedOut).length;

  if (counted === 0) {
    root.append(emptyCard('i-stack', 'עוד לא נספרו ז\'יטונים. תעבור למסך "ספירה" כדי להזין כמה נשאר לכל אחד.'));
    return;
  }

  if (counted < state.game.players.length) {
    const warn = el('div', 'panel status warn');
    const left = state.game.players.length - counted;
    warn.append(el('div', 'status-title', 'החישוב חלקי'));
    warn.append(
      el(
        'div',
        null,
        left === 1
          ? 'שחקן אחד עוד לא נספר, אז החשבון עוד ישתנה.'
          : `${left} שחקנים עוד לא נספרו, אז החשבון עוד ישתנה.`
      )
    );
    root.append(warn);
  } else if (!effective.balanced) {
    const warn = el('div', 'panel status warn');
    warn.append(el('div', 'status-title', 'הקופה לא מאוזנת'));
    warn.append(
      el(
        'div',
        null,
        `יש הפרש של ${money(Math.abs(effective.diffCents))}. התשלומים למטה מכסים רק את מה שמסתדר - כדאי לחזור למסך "ספירה".`
      )
    );
    root.append(warn);
  }

  /* ---- results table ---- */
  root.append(sectionHead('סיכום שחקנים', effective.balanced ? 'מאוזן' : 'לא מאוזן'));

  const table = el('div', 'panel list-card');
  leaderboard(effective).forEach((p, index) => {
    const row = el('div', 'result-row');
    row.append(el('span', 'result-rank', `${index + 1}`));

    const nameWrap = el('div', 'result-name');
    nameWrap.append(
      el('div', null, p.name),
      el('div', 'result-detail', `${money(p.inCents)} → ${money(p.outCents)}`)
    );

    const net = el('span', `result-net ${p.netCents > 0 ? 'net-win' : p.netCents < 0 ? 'net-lose' : 'net-even'}`);
    net.textContent = signedMoney(p.netCents);

    row.append(nameWrap, net);
    table.append(row);
  });
  root.append(table);

  /* ---- transfers ---- */
  const { transfers } = settlement;
  root.append(
    sectionHead(
      'מי משלם למי',
      transfers.length === 0 ? 'אין תשלומים' : plural(transfers.length, 'העברה אחת', 'העברות')
    )
  );

  if (transfers.length === 0) {
    root.append(emptyCard('i-pay', 'כולם יצאו בדיוק באפס. אף אחד לא חייב לאף אחד.'));
  } else {
    const paid = state.game.paid || {};
    for (const t of transfers) {
      const key = transferKey(t);
      const row = el('div', `transfer${paid[key] ? ' is-paid' : ''}`);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'transfer-check';
      check.checked = Boolean(paid[key]);
      check.dataset.action = 'toggle-paid';
      check.dataset.key = key;
      check.setAttribute('aria-label', `סמן ש${t.from} שילם ל${t.to}`);

      const text = el('div', 'transfer-text');
      const names = el('div', 'transfer-names');
      names.append(
        el('strong', null, t.from),
        el('span', 'transfer-arrow', ' משלם ל'),
        el('strong', null, t.to)
      );
      text.append(names);

      row.append(check, text, el('span', 'transfer-amount', money(t.amountCents)));
      root.append(row);
    }
  }

  /* ---- actions ---- */
  const actions = el('div', 'panel actions-grid');

  const share = el('button', 'btn btn-primary', 'שתף סיכום');
  share.type = 'button';
  share.dataset.action = 'share';

  const copy = el('button', 'btn', 'העתק');
  copy.type = 'button';
  copy.dataset.action = 'copy';

  actions.append(share, copy);
  root.append(actions);

  const finish = el('div', 'card');
  const finishBtn = el('button', 'btn btn-primary btn-block btn-lg', 'סיים משחק ושמור בהיסטוריה');
  finishBtn.type = 'button';
  finishBtn.dataset.action = 'finish-game';
  finish.append(finishBtn);
  finish.append(
    el('p', 'hint', 'המשחק יישמר בהיסטוריה ויתחיל משחק חדש עם אותן הגדרות.')
  );
  root.append(finish);
}

function sectionHead(title, muted) {
  const head = el('div', 'section-head');
  head.append(el('h2', null, title));
  if (muted) head.append(el('span', 'muted', muted));
  return head;
}

function transferKey(t) {
  return `${t.fromId}>${t.toId}:${t.amountCents}`;
}

function renderHistory() {
  const root = $('historyContent');
  root.textContent = '';

  if (state.history.length === 0) {
    root.append(emptyCard('i-history', 'אין עדיין משחקים שמורים. כשתסיים משחק הוא יופיע כאן.'));
    return;
  }

  root.append(sectionHead('משחקים קודמים', plural(state.history.length, 'משחק אחד', 'משחקים')));

  for (const game of state.history) {
    const card = el('div', 'panel history-item');

    const head = el('div', 'history-head');
    const date = new Date(game.endedAt || game.startedAt);
    head.append(
      el('span', 'history-date', date.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' }))
    );
    head.append(
      el(
        'span',
        'history-meta',
        `${plural(game.summary?.players?.length ?? 0, 'שחקן אחד', 'שחקנים')} · ${game.currency}${fromCents(game.summary?.totalInCents ?? 0)}`
      )
    );
    card.append(head);

    const chips = el('div', 'history-players');
    for (const p of game.summary?.players ?? []) {
      const chip = el('span', 'history-chip');
      const sign = p.netCents > 0 ? '+' : p.netCents < 0 ? '−' : '';
      chip.textContent = `${p.name} ${sign}${game.currency}${fromCents(Math.abs(p.netCents))}`;
      chip.style.color = p.netCents > 0 ? 'var(--win)' : p.netCents < 0 ? 'var(--lose)' : 'var(--text-dim)';
      chips.append(chip);
    }
    card.append(chips);

    const del = el('button', 'btn btn-ghost', 'מחק');
    del.type = 'button';
    del.dataset.action = 'delete-history';
    del.dataset.id = game.id;
    card.append(del);

    root.append(card);
  }

  const tools = el('div', 'panel actions-grid');
  const exportBtn = el('button', 'btn', 'ייצוא נתונים');
  exportBtn.type = 'button';
  exportBtn.dataset.action = 'export';
  tools.append(exportBtn);
  root.append(tools);
}

/* ------------------------------------------------------------- share text */

function summaryText() {
  const { effective, settlement } = currentResults();
  const lines = ['🃏 *סיכום ערב פוקר*', ''];

  lines.push(`קופה: ${money(effective.totalInCents)}`);
  lines.push('');
  lines.push('*תוצאות:*');
  for (const p of leaderboard(effective)) {
    const emoji = p.netCents > 0 ? '🟢' : p.netCents < 0 ? '🔴' : '⚪';
    lines.push(`${emoji} ${p.name}: ${signedMoney(p.netCents)}`);
  }

  if (settlement.transfers.length > 0) {
    lines.push('');
    lines.push('*תשלומים:*');
    for (const t of settlement.transfers) {
      lines.push(`💸 ${t.from} משלם ל${t.to}: ${money(t.amountCents)}`);
    }
  }

  return lines.join('\n');
}

async function shareSummary() {
  const text = summaryText();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'סיכום ערב פוקר', text });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // Sharing is unavailable or was blocked - fall through to WhatsApp.
    }
  }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

async function copySummary() {
  const text = summaryText();
  try {
    await navigator.clipboard.writeText(text);
    toast('הסיכום הועתק');
  } catch {
    // Clipboard access needs a secure context; show the text so it can be
    // selected and copied by hand.
    window.prompt('העתק את הסיכום:', text);
  }
}

function downloadExport() {
  const blob = new Blob([exportJSON(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `poker-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ----------------------------------------------------------------- actions */

function findPlayer(id) {
  return state.game.players.find((p) => p.id === id);
}

const actions = {
  'buyin-plus'(id) {
    const player = findPlayer(id);
    if (!player) return;
    player.buyIns.push(state.game.buyInCents);
    commit();
  },

  'buyin-minus'(id) {
    const player = findPlayer(id);
    if (!player || player.buyIns.length === 0) return;
    player.buyIns.pop();
    commit();
  },

  'remove-player'(id) {
    const player = findPlayer(id);
    if (!player) return;
    if (!confirm(`להסיר את ${player.name} מהמשחק?`)) return;
    const dealer = dealerPlayer();
    state.game.players = state.game.players.filter((p) => p.id !== id);
    pickedSeat = null;
    // The button stays with whoever was holding it, unless they just left.
    if (dealer && dealer.id !== id) setDealerTo(dealer.id);
    else state.game.dealerIndex = 0;
    commit();
  },

  'cash-zero'(id) {
    const player = findPlayer(id);
    if (!player) return;
    player.cashOut = 0;
    commit();
  },

  'cash-rest'(id) {
    const player = findPlayer(id);
    if (!player) return;
    const others = state.game.players
      .filter((p) => p.id !== id && p.cashOut != null && p.cashOut !== '')
      .reduce((s, p) => s + Number(p.cashOut || 0), 0);
    player.cashOut = Math.max(0, chipsInPlay() - others);
    commit();
  },

  'adjust-even'() {
    state.game.adjustment = 'even';
    commit();
    toast('ההפרש חולק שווה בשווה');
  },

  'adjust-proportional'() {
    state.game.adjustment = 'proportional';
    commit();
    toast('ההפרש חולק לפי גודל הערימה');
  },

  'clear-adjustment'() {
    state.game.adjustment = null;
    commit();
  },


  /* ---- the round ---- */

  'start-hand'() {
    const last = state.game.hand?.n ?? 0;
    const hand = newHand(last + 1);
    // Blinds are the same two entries every single hand, so post them here.
    hand.bets = blindBets(state.game);
    state.game.hand = hand;
    commit();
  },

  fold(id) {
    const hand = state.game.hand;
    if (!hand) return;
    hand.folded = hand.folded || {};
    hand.folded[id] = true;
    commit();
  },

  unfold(id) {
    const hand = state.game.hand;
    if (!hand?.folded) return;
    delete hand.folded[id];
    commit();
  },

  call(id) {
    const hand = state.game.hand;
    const player = findPlayer(id);
    if (!hand || !player) return;
    const owed = callAmount(player, state.game);
    if (owed > 0) hand.bets[id] = (Number(hand.bets[id]) || 0) + owed;
    commit();
  },

  'all-in'(id) {
    const hand = state.game.hand;
    const player = findPlayer(id);
    if (!hand || !player) return;
    const stack = playerStackChips(player, state.game);
    if (stack <= 0) return;
    hand.bets[id] = (Number(hand.bets[id]) || 0) + stack;
    commit();
  },

  'toggle-winner'(id, target) {
    if (!winnerPick) return;
    const index = Number(target.dataset.pot) || 0;
    const chosen = winnerPick[index];
    if (!chosen) return;
    if (chosen.has(id)) chosen.delete(id);
    else chosen.add(id);
    commit();
  },

  'cancel-winner'() {
    winnerPick = null;
    commit();
  },

  'confirm-winner'() {
    const hand = state.game.hand;
    if (!hand || !winnerPick) return;
    const after = closeHandWithPots(state.game, winnerPick.map((set) => [...set]));
    for (const p of state.game.players) p.chipsWon = after[p.id];
    state.game.hand = null;
    winnerPick = null;
    actions['next-dealer']();
    toast('הסיבוב נסגר');
  },

  'cancel-hand'() {
    if (!confirm('לבטל את הסיבוב? ההימורים שהוזנו יימחקו ולא ייזקפו לאף אחד.')) return;
    state.game.hand = null;
    winnerPick = null;
    commit();
  },

  'set-street'(_, target) {
    if (!state.game.hand) return;
    state.game.hand.street = target.dataset.street;
    commit();
  },

  'pick-card'(_, target) {
    cardPickerSlot = Number(target.dataset.slot);
    pickerRank = null;
    pickerSuit = null;
    commit();
  },

  'close-picker'() {
    closePicker();
  },

  'choose-rank'(_, target) {
    pickerRank = target.dataset.rank;
    commitCardIfReady();
  },

  'choose-suit'(_, target) {
    pickerSuit = target.dataset.suit;
    commitCardIfReady();
  },

  'clear-card'() {
    if (!state.game.hand || cardPickerSlot === null) return;
    state.game.hand.board[cardPickerSlot] = undefined;
    closePicker();
  },

  'bet-add'(id, target) {
    const hand = state.game.hand;
    if (!hand) return;
    const amount = Number(target.dataset.amount) || 0;
    hand.bets[id] = (Number(hand.bets[id]) || 0) + amount;
    commit();
  },

  'bet-clear'(id) {
    if (!state.game.hand) return;
    delete state.game.hand.bets[id];
    commit();
  },

  'close-hand'() {
    const hand = state.game.hand;
    if (!hand) return;
    if (handPot(hand) === 0) {
      alert('אין כלום בקופה. תזין הימורים או תבטל את הסיבוב.');
      return;
    }
    // A pot only one player is eligible for has no decision in it, so it is
    // filled in already and the table only answers the real questions.
    winnerPick = sidePots(state.game).map((pot) =>
      pot.eligibleIds.length === 1 ? new Set(pot.eligibleIds) : new Set()
    );
    commit();
  },

  /* ---- seating ---- */

  /**
   * One tap lifts a player off their chair, the next tap sits them down.
   * Tapping an occupied chair swaps the two, which is how people actually
   * rearrange a table - nobody stands up and waits.
   */
  'seat-tap'(_, target) {
    const seat = Number(target.dataset.seat);
    if (!Number.isInteger(seat)) return;

    if (pickedSeat === null) {
      if (playerAtSeat(seat)) pickedSeat = seat;
      commit();
      return;
    }
    if (pickedSeat === seat) {
      pickedSeat = null;
      commit();
      return;
    }

    const moving = playerAtSeat(pickedSeat);
    const sitting = playerAtSeat(seat);
    if (moving) {
      const dealer = dealerPlayer();
      moving.seat = seat;
      if (sitting) sitting.seat = pickedSeat;
      normalizeSeats(state.game);
      if (dealer) setDealerTo(dealer.id);
    }
    pickedSeat = null;
    commit();
  },

  'clear-seat-pick'() {
    pickedSeat = null;
    commit();
  },

  'set-dealer'(id) {
    setDealerTo(id);
    pickedSeat = null;
    commit();
  },

  'next-dealer'() {
    const count = state.game.players.length;
    if (count === 0) return;
    state.game.dealerIndex = ((state.game.dealerIndex ?? 0) + 1) % count;
    commit();
  },

  /* ---- filling the end-of-night count from the tracked stacks ---- */

  'fill-from-tracking'() {
    for (const p of state.game.players) p.cashOut = playerStackChips(p, state.game);
    state.game.adjustment = null;
    commit();
    toast('הספירה מולאה לפי המעקב');
  },

  /* ---- sync ---- */

  'host-game'() {
    startSync(newGameCode());
  },

  'join-game'() {
    const code = $('joinCodeInput').value.trim().toUpperCase();
    if (!code) return;
    startSync(code, { adopt: true });
  },

  'leave-sync'() {
    sync.disconnect();
    state.syncCode = null;
    persist();
    renderSync();
    toast('הסנכרון נותק');
  },

  async 'copy-link'() {
    const url = `${location.origin}${location.pathname}?game=${state.syncCode || ''}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('הקישור הועתק');
    } catch {
      window.prompt('קישור להצטרפות:', url);
    }
  },

  share: shareSummary,
  copy: copySummary,
  export: downloadExport,

  'finish-game'() {
    const { effective, settlement } = currentResults();
    if (!confirm('לסיים את המשחק ולשמור אותו בהיסטוריה?')) return;

    state = archive(state, {
      totalInCents: effective.totalInCents,
      players: effective.players.map((p) => ({
        name: p.name,
        inCents: p.inCents,
        outCents: p.outCents,
        netCents: p.netCents,
      })),
      transfers: settlement.transfers,
    });
    commit();
    switchView('history');
    toast('המשחק נשמר בהיסטוריה');
  },

  'delete-history'(id) {
    if (!confirm('למחוק את המשחק הזה מההיסטוריה?')) return;
    state.history = state.history.filter((g) => g.id !== id);
    commit();
  },
};

function commit() {
  persist();
  scheduleBroadcast();
  render();
}

/* ------------------------------------------------------------------ events */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  if (action === 'toggle-paid') return; // handled on change

  const handler = actions[action];
  if (!handler) return;
  event.preventDefault();
  handler(target.dataset.id, target);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!target.dataset) return;

  if (target.dataset.action === 'toggle-paid') {
    state.game.paid = state.game.paid || {};
    if (target.checked) state.game.paid[target.dataset.key] = true;
    else delete state.game.paid[target.dataset.key];
    commit();
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset?.action !== 'cash-out') return;

  const player = findPlayer(target.dataset.id);
  if (!player) return;

  const raw = target.value.trim();
  if (raw === '') {
    player.cashOut = null;
  } else {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    player.cashOut = state.game.mode === 'chips' ? value : toCents(value);
  }

  // Re-render everything except the field being typed into, so the caret stays put.
  persist();
  renderTopBar();
  renderCountLive();
  renderSettle();
});

/** Update the derived numbers on the count screen without rebuilding inputs. */
function renderCountLive() {
  const { computed } = currentResults();

  for (const player of state.game.players) {
    const stats = computed.players.find((p) => p.id === player.id);
    const input = document.querySelector(`input[data-action="cash-out"][data-id="${player.id}"]`);
    if (!input) continue;
    const row = input.closest('.player');
    row.querySelector('.count-value')?.remove();
    if (stats.cashedOut) row.querySelector('.player-main').append(countValueLine(stats));
  }

  const counted = computed.players.filter((p) => p.cashedOut).length;
  const status = $('countStatus');
  status.textContent = '';
  renderCountStatus(status, counted);
}

/* ---- settings ---- */

$('buyInInput').addEventListener('change', (e) => {
  const cents = toCents(e.target.value);
  state.game.buyInCents = cents > 0 ? cents : 0;
  commit();
});

$('chipsInput').addEventListener('change', (e) => {
  const chips = Math.max(1, Math.round(Number(e.target.value) || 1));
  state.game.chipsPerBuyIn = chips;
  commit();
});

$('smallBlindInput').addEventListener('change', (e) => {
  state.game.blinds = state.game.blinds || {};
  state.game.blinds.small = Math.max(0, Math.round(Number(e.target.value) || 0));
  commit();
});

$('bigBlindInput').addEventListener('change', (e) => {
  state.game.blinds = state.game.blinds || {};
  state.game.blinds.big = Math.max(0, Math.round(Number(e.target.value) || 0));
  commit();
});

$('currencyInput').addEventListener('change', (e) => {
  state.game.currency = e.target.value;
  commit();
});

$('modeInput').addEventListener('change', (e) => {
  const next = e.target.value;
  if (next !== state.game.mode) {
    // Cash-out values mean different things in each mode, so clear them
    // rather than silently reinterpreting chips as shekels.
    for (const p of state.game.players) p.cashOut = null;
    state.game.adjustment = null;
    state.game.mode = next;
  }
  commit();
});

/* ---- add player ---- */

$('addPlayerForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('playerNameInput');
  const name = input.value.trim();
  if (!name) return;

  const exists = state.game.players.some((p) => p.name === name);
  if (exists && !confirm(`כבר יש שחקן בשם ${name}. להוסיף בכל זאת?`)) return;

  const seat = firstFreeSeat(state.game);
  if (seat === null) {
    alert(`השולחן מלא - ${MAX_SEATS} שחקנים זה המקסימום.`);
    return;
  }

  const withBuyIn = $('autoBuyIn').checked ? state.game.buyInCents : 0;
  state.game.players.push(newPlayer(name, withBuyIn, seat));
  normalizeSeats(state.game);
  input.value = '';
  input.focus();
  commit();
});

$('resetGameBtn').addEventListener('click', () => {
  if (!confirm('לאפס את המשחק הנוכחי? כל השחקנים והכניסות יימחקו.')) return;
  state.game = newGame(state.game);
  pickedSeat = null;
  commit();
  switchView('game');
  toast('המשחק אופס');
});

/* ---- tabs ---- */

function switchView(name) {
  activeView = name;
  for (const view of document.querySelectorAll('.view')) {
    view.hidden = view.id !== `view-${name}`;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.view === name);
  }
  window.scrollTo({ top: 0 });
}

$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  applyTheme(dark ? 'light' : 'dark');
});

$('syncToggle').addEventListener('click', () => {
  const body = $('syncBody');
  body.hidden = !body.hidden;
});

$('tabbar').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);
});

/* ---- offline support ---- */

/* sw:start - stripped from the single-file build, which has no sw.js beside it */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a bonus; the app works fine without it.
    });
  });
}
/* sw:end */

/* ---- go ---- */



/* ==========================================================================
   The round: community cards, per-player bets, the pot, and the dealer button
   ========================================================================== */

const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = [
  { id: 's', glyph: '♠', name: 'עלה' },
  { id: 'h', glyph: '♥', name: 'לב אדום' },
  { id: 'd', glyph: '♦', name: 'יהלום' },
  { id: 'c', glyph: '♣', name: 'תלתן' },
];

const STREET_LABEL = {
  preflop: 'פרה-פלופ',
  flop: 'פלופ',
  turn: 'טרן',
  river: 'ריבר',
};

/** How many community cards belong on the felt at each street. */
const STREET_CARDS = { preflop: 0, flop: 3, turn: 4, river: 5 };

let cardPickerSlot = null;
let pickerRank = null;
let pickerSuit = null;
let winnerPick = null; // one Set of player ids per pot, while choosing winners
let pickedSeat = null; // the chair a player has been lifted off, while reseating

function closePicker() {
  cardPickerSlot = null;
  pickerRank = null;
  pickerSuit = null;
  commit();
}

/** Write the card once both halves are chosen, in whichever order. */
function commitCardIfReady() {
  if (!pickerRank || !pickerSuit) {
    commit();
    return;
  }
  const hand = state.game.hand;
  if (!hand || cardPickerSlot === null) return;

  const card = pickerRank + pickerSuit;
  const existing = hand.board.indexOf(card);
  if (existing !== -1 && existing !== cardPickerSlot) hand.board[existing] = undefined;
  hand.board[cardPickerSlot] = card;

  const filled = hand.board.filter(Boolean).length;
  // Dealing the flop is three cards in a row, so walk to the next slot instead
  // of making the dealer reopen the picker each time.
  const slot = cardPickerSlot;
  pickerRank = null;
  if (slot < 2 && filled < 3) {
    cardPickerSlot = slot + 1;
  } else {
    cardPickerSlot = null;
    pickerSuit = null;
  }

  // The street follows the felt: three cards is a flop, four a turn, five a river.
  const street = filled >= 5 ? 'river' : filled === 4 ? 'turn' : filled >= 3 ? 'flop' : hand.street;
  if (STREETS.indexOf(street) > STREETS.indexOf(hand.street)) hand.street = street;

  commit();
}

function currentHand() {
  return state.game.hand || null;
}

function dealerPlayer() {
  const players = state.game.players;
  if (players.length === 0) return null;
  const index = ((state.game.dealerIndex ?? 0) % players.length + players.length) % players.length;
  return players[index] ?? null;
}

function dealerName() {
  return dealerPlayer()?.name ?? null;
}

/** The button belongs to a person, not to a slot in the array. */
function setDealerTo(id) {
  const index = state.game.players.findIndex((p) => p.id === id);
  if (index >= 0) state.game.dealerIndex = index;
}

function playerAtSeat(seat) {
  return state.game.players.find((p) => p.seat === seat) ?? null;
}

/**
 * Nine chairs round an oval, in the order the action moves: seat 1 sits at
 * the bottom right and the numbers run clockwise from there. The figures are
 * percentages of the table box, so the whole thing scales from a phone to a
 * television without a single hard-coded pixel.
 */
const SEAT_SPOTS = [
  { x: 63.0, y: 88.0 },
  { x: 37.0, y: 88.0 },
  { x: 16.0, y: 70.0 },
  { x: 11.5, y: 43.0 },
  { x: 25.0, y: 18.5 },
  { x: 50.0, y: 9.5 },
  { x: 75.0, y: 18.5 },
  { x: 88.5, y: 43.0 },
  { x: 84.0, y: 70.0 },
];

function tableSurface() {
  const box = el('div', 'table-surface');
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = `
<svg viewBox="0 0 200 124" preserveAspectRatio="none" focusable="false">
  <defs>
    <linearGradient id="pt-rail" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5c4526"/>
      <stop offset=".45" stop-color="#3a2a15"/>
      <stop offset="1" stop-color="#22180b"/>
    </linearGradient>
    <radialGradient id="pt-felt" cx="50%" cy="42%" r="72%">
      <stop offset="0" stop-color="#2c8159"/>
      <stop offset=".55" stop-color="#1d6042"/>
      <stop offset="1" stop-color="#0f3c29"/>
    </radialGradient>
    <linearGradient id="pt-sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".17"/>
      <stop offset=".45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="4" y="4" width="192" height="116" rx="58" fill="url(#pt-rail)"/>
  <rect x="4" y="4" width="192" height="116" rx="58" fill="url(#pt-sheen)"/>
  <rect x="4" y="4" width="192" height="116" rx="58" fill="none" stroke="#a87c2e"
        stroke-width="1.2" stroke-opacity=".8" vector-effect="non-scaling-stroke"/>
  <rect x="14.5" y="14.5" width="171" height="95" rx="47" fill="none" stroke="#000000"
        stroke-width="2" stroke-opacity=".3" vector-effect="non-scaling-stroke"/>

  <rect x="15" y="15" width="170" height="94" rx="47" fill="url(#pt-felt)"/>
  <rect x="26" y="25" width="148" height="74" rx="37" fill="none" stroke="#ffffff"
        stroke-width="1" stroke-opacity=".17" stroke-dasharray="4 4.5"
        vector-effect="non-scaling-stroke"/>
</svg>`;
  return box;
}

/** The middle of the felt: the pot and the board when a hand is live. */
function tableCenter(hand) {
  const center = el('div', 'table-center');

  if (!hand) {
    const idle = el('div', 'table-idle');
    const blinds = state.game.blinds || {};
    idle.append(el('span', 'table-idle-label', 'בליינדים'));
    idle.append(el('strong', 'table-idle-blinds', `${blinds.small ?? 0} / ${blinds.big ?? 0}`));
    if (state.game.mode === 'chips') {
      const btn = el('button', 'btn btn-primary table-start', 'פתח סיבוב');
      btn.type = 'button';
      btn.dataset.action = 'start-hand';
      idle.append(btn);
    }
    center.append(idle);
    return center;
  }

  center.append(el('span', 'table-street', `${STREET_LABEL[hand.street] || ''} · יד ${hand.n}`));

  const board = el('div', 'board-cards');
  const visible = STREET_CARDS[hand.street] ?? 0;
  for (let i = 0; i < 5; i++) {
    const card = hand.board[i];
    const slot = el('button', `board-card${card ? ' filled' : ''}${i >= visible ? ' dim' : ''}`);
    slot.type = 'button';
    slot.dataset.action = 'pick-card';
    slot.dataset.slot = String(i);
    if (card) {
      const suit = SUITS.find((x) => x.id === card.slice(-1));
      slot.classList.add(suit && 'hd'.includes(suit.id) ? 'red' : 'black');
      slot.append(el('span', 'card-rank', card.slice(0, -1)));
      slot.append(el('span', 'card-suit', suit ? suit.glyph : ''));
      slot.setAttribute('aria-label', `קלף ${i + 1}: ${card.slice(0, -1)} ${suit ? suit.name : ''}`);
    } else {
      slot.setAttribute('aria-label', `הוסף קלף ${i + 1}`);
    }
    board.append(slot);
  }
  center.append(board);

  const pot = el('div', 'table-pot');
  pot.append(el('span', 'table-pot-label', 'קופה'));
  pot.append(el('strong', 'table-pot-value', String(handPot(hand))));
  center.append(pot);

  return center;
}

/** One chair: the person on it, what they are sitting behind, and their bet. */
function seatNode(seat, hand) {
  const player = playerAtSeat(seat);
  const spot = SEAT_SPOTS[seat];
  const dealer = dealerPlayer();

  const classes = ['table-seat'];
  if (!player) classes.push('is-empty');
  if (pickedSeat === seat) classes.push('is-picked');
  if (player && dealer && dealer.id === player.id) classes.push('is-dealer');

  const bet = player && hand ? Number(hand.bets?.[player.id]) || 0 : 0;
  const folded = Boolean(player && hand && hand.folded?.[player.id]);
  if (folded) classes.push('is-folded');

  const node = el('button', classes.join(' '));
  node.type = 'button';
  node.style.left = `${spot.x}%`;
  node.style.top = `${spot.y}%`;
  node.dataset.action = 'seat-tap';
  node.dataset.seat = String(seat);

  if (player) {
    node.append(el('span', 'seat-avatar', player.name.trim().slice(0, 1)));
    const body = el('span', 'seat-body');
    body.append(el('span', 'seat-name', player.name));
    body.append(
      el(
        'span',
        'seat-stack',
        state.game.mode === 'chips'
          ? String(playerStackChips(player, state.game))
          : plural(player.buyIns.length, 'כניסה אחת', 'כניסות')
      )
    );
    node.append(body);
    if (folded) node.append(el('span', 'seat-flag', 'פרש'));
    node.setAttribute(
      'aria-label',
      pickedSeat === seat
        ? `${player.name}, כיסא ${seat + 1}, מורם - בחר כיסא`
        : `${player.name}, כיסא ${seat + 1}`
    );
  } else {
    node.append(el('span', 'seat-avatar', pickedSeat === null ? String(seat + 1) : '+'));
    // The same body as an occupied chair, so every avatar lines up on the rail.
    const body = el('span', 'seat-body');
    body.append(el('span', 'seat-name', 'פנוי'));
    node.append(body);
    node.setAttribute(
      'aria-label',
      pickedSeat === null ? `כיסא ${seat + 1}, פנוי` : `הושב בכיסא ${seat + 1}`
    );
  }

  if (bet > 0) {
    const chip = el('span', 'seat-bet', String(bet));
    chip.style.left = `${50 + (spot.x - 50) * 0.76}%`;
    chip.style.top = `${50 + (spot.y - 50) * 0.69}%`;
    return [node, chip];
  }
  return [node];
}

/** The table itself: felt, nine chairs, and the line about moving people around. */
function renderTable(hand) {
  const panel = el('div', 'panel table-panel');

  const table = el('div', 'poker-table');
  table.append(tableSurface());
  table.append(tableCenter(hand));

  const dealer = dealerPlayer();
  if (dealer && Number.isInteger(dealer.seat)) {
    const spot = SEAT_SPOTS[dealer.seat];
    const puck = el('span', 'dealer-puck', 'D');
    puck.setAttribute('aria-hidden', 'true');
    puck.style.left = `${50 + (spot.x - 50) * 0.87}%`;
    puck.style.top = `${50 + (spot.y - 50) * 0.86}%`;
    table.append(puck);
  }

  for (let seat = 0; seat < MAX_SEATS; seat++) {
    for (const node of seatNode(seat, hand)) table.append(node);
  }
  panel.append(table);

  const bar = el('div', 'table-bar');
  const picked = pickedSeat === null ? null : playerAtSeat(pickedSeat);
  if (picked) {
    bar.append(el('p', 'hint', `${picked.name} מורם - לחץ על כיסא כדי להושיב או להחליף.`));
    const actions = el('div', 'table-bar-actions');
    actions.append(actionBtn('הפוך לדילר', 'set-dealer', picked.id, 'btn'));
    actions.append(actionBtn('בטל', 'clear-seat-pick', '', 'btn btn-ghost'));
    bar.append(actions);
  } else {
    bar.append(el('p', 'hint', 'לחיצה על שחקן מרימה אותו מהכיסא, ולחיצה על כיסא אחר מושיבה או מחליפה.'));
    const actions = el('div', 'table-bar-actions');
    const next = el('button', 'btn btn-ghost', 'העבר דילר לשחקן הבא');
    next.type = 'button';
    next.dataset.action = 'next-dealer';
    actions.append(next);
    bar.append(actions);
  }
  panel.append(bar);

  return panel;
}

function renderRound() {
  const root = $('roundContent');
  root.textContent = '';

  if (state.game.players.length === 0) {
    root.append(emptyCard('i-cards', 'תוסיף שחקנים במסך "משחק" ואז אפשר לפתוח סיבוב.'));
    return;
  }

  const hand = state.game.mode === 'chips' ? currentHand() : null;
  root.append(renderTable(hand));

  if (state.game.mode === 'cash') {
    root.append(emptyCard('i-cards', 'מעקב סיבובים עובד בשיטת ז\'יטונים. אפשר לשנות בהגדרות המשחק.'));
    return;
  }
  if (!hand) return;

  root.append(renderHandControls(hand));
  root.append(renderBets(hand));
}

/** Everything about the live hand that will not fit on the felt itself. */
function renderHandControls(hand) {
  const wrap = el('div', 'panel felt');

  const streets = el('div', 'street-row');
  for (const key of ['preflop', 'flop', 'turn', 'river']) {
    const b = el('button', `street-btn${hand.street === key ? ' is-active' : ''}`, STREET_LABEL[key]);
    b.type = 'button';
    b.dataset.action = 'set-street';
    b.dataset.street = key;
    streets.append(b);
  }
  wrap.append(streets);

  if (cardPickerSlot !== null) wrap.append(renderCardPicker());

  // Show the pots splitting as they form, rather than springing it on people
  // at showdown.
  const pots = sidePots(state.game);
  if (pots.length > 1) {
    const breakdown = el('div', 'pot-breakdown');
    pots.forEach((pot, index) => {
      const row = el('div', 'pot-slice');
      row.append(el('span', 'pot-slice-name', pot.isMain ? 'קופה ראשית' : `קופת צד ${index}`));
      row.append(el('span', 'pot-slice-amount', String(pot.amount)));
      row.append(
        el(
          'span',
          'pot-slice-who',
          pot.eligibleIds.map((id) => findPlayer(id)?.name).filter(Boolean).join(' · ')
        )
      );
      breakdown.append(row);
    });
    wrap.append(breakdown);
  }

  return wrap;
}

/**
 * Two steps instead of a 52-cell grid: pick the rank, pick the suit. Either
 * order works, and the card commits as soon as both are chosen - which keeps
 * every target big enough to hit on a phone.
 */
function renderCardPicker() {
  const picker = el('div', 'card-picker');

  const head = el('div', 'card-picker-head');
  head.append(el('span', null, `קלף ${cardPickerSlot + 1}`));
  const close = el('button', 'btn btn-ghost', 'סגור');
  close.type = 'button';
  close.dataset.action = 'close-picker';
  head.append(close);
  picker.append(head);

  // Suit comes first so the ranks below can be drawn in it - once you have
  // picked hearts, every rank button is a red heart and there is nothing left
  // to read.
  picker.append(el('span', 'field-label', 'סימן'));
  const suits = el('div', 'suit-grid');
  for (const suit of SUITS) {
    const red = 'hd'.includes(suit.id);
    const b = el('button', `suit-btn ${red ? 'red' : 'black'}${pickerSuit === suit.id ? ' is-chosen' : ''}`);
    b.type = 'button';
    b.dataset.action = 'choose-suit';
    b.dataset.suit = suit.id;
    b.append(el('span', 'suit-glyph', suit.glyph));
    b.setAttribute('aria-label', suit.name);
    suits.append(b);
  }
  picker.append(suits);

  const chosen = SUITS.find((x) => x.id === pickerSuit);
  picker.append(el('span', 'field-label', chosen ? `ערך · ${chosen.name}` : 'ערך'));

  const ranks = el('div', `rank-grid${chosen ? ' has-suit' : ''}`);
  for (const rank of RANKS) {
    const red = chosen && 'hd'.includes(chosen.id);
    const b = el('button', `rank-btn${chosen ? (red ? ' red' : ' black') : ''}`);
    b.type = 'button';
    b.dataset.action = 'choose-rank';
    b.dataset.rank = rank;
    b.append(el('span', 'rank-btn-rank', rank));
    if (chosen) b.append(el('span', 'rank-btn-suit', chosen.glyph));
    b.setAttribute('aria-label', chosen ? `${rank} ${chosen.name}` : rank);
    ranks.append(b);
  }
  picker.append(ranks);

  const clear = el('button', 'btn btn-ghost btn-block', 'נקה את הקלף');
  clear.type = 'button';
  clear.dataset.action = 'clear-card';
  picker.append(clear);
  return picker;
}

/** One row per player: what they are sitting behind and what they have bet. */
function renderBets(hand) {
  if (winnerPick) return renderWinnerPick(hand);

  const wrap = el('div', 'players bets');
  const toMatch = currentBet(hand);
  const folded = hand.folded || {};

  for (const player of state.game.players) {
    const stack = playerStackChips(player, state.game);
    const bet = Number(hand.bets?.[player.id]) || 0;
    const isFolded = Boolean(folded[player.id]);
    const owed = callAmount(player, state.game);

    const row = el('div', `player bet-row${isFolded ? ' is-folded' : ''}`);

    const main = el('div', 'player-main');
    const nameLine = el('div', 'player-name');
    nameLine.append(document.createTextNode(player.name));
    if (dealerName() === player.name) nameLine.append(el('span', 'dealer-badge', 'D'));
    if (isFolded) nameLine.append(el('span', 'fold-badge', 'פרש'));
    main.append(nameLine);
    main.append(el('div', 'player-meta', `נשאר ${stack} · בקופה ${bet}`));

    const field = el('div', 'count-input');
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.value = bet ? String(bet) : '';
    input.placeholder = '0';
    input.disabled = isFolded;
    input.dataset.action = 'bet-set';
    input.dataset.id = player.id;
    input.setAttribute('aria-label', `הימור של ${player.name}`);
    field.append(input);

    const quick = el('div', 'bet-quick');

    if (isFolded) {
      quick.append(actionBtn('החזר למשחק', 'unfold', player.id, 'wide'));
    } else {
      quick.append(actionBtn('פרש', 'fold', player.id, 'fold'));

      // The one action taken most often: match the table in a single tap.
      if (owed > 0) {
        quick.append(actionBtn(`השווה ${owed}`, 'call', player.id, 'call'));
      } else {
        quick.append(actionBtn("צ'ק", 'call', player.id, 'call'));
      }

      for (const amount of raiseSteps(toMatch)) {
        quick.append(actionBtn(`+${amount}`, 'bet-add', player.id, '', { amount }));
      }

      if (stack > 0) quick.append(actionBtn('אול-אין', 'all-in', player.id, 'allin'));
    }

    row.append(main, field, quick);
    wrap.append(row);
  }

  const actions = el('div', 'panel actions-grid');
  const win = el('button', 'btn btn-primary btn-block btn-lg', 'סגור סיבוב ובחר זוכה');
  win.type = 'button';
  win.dataset.action = 'close-hand';
  actions.append(win);
  const cancel = el('button', 'btn btn-ghost', 'בטל את הסיבוב');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel-hand';
  actions.append(cancel);
  wrap.append(actions);

  return wrap;
}

/** Raise steps scaled to the blinds, so the buttons stay useful all night. */
function raiseSteps(toMatch) {
  const big = Number(state.game.blinds?.big) || 0;
  if (big > 0) return [big, big * 2, big * 5];
  const base = toMatch > 0 ? toMatch : 5;
  return [base, base * 2];
}

function actionBtn(label, action, id, extraClass = '', data = {}) {
  const b = el('button', extraClass, label);
  b.type = 'button';
  b.dataset.action = action;
  b.dataset.id = id;
  for (const [key, value] of Object.entries(data)) b.dataset[key] = String(value);
  return b;
}

/**
 * One selector per pot. With no all-ins there is a single pot and this looks
 * like a plain list of players; when someone was all-in for less, each pot
 * lists only the players who can actually win it.
 */
function renderWinnerPick(hand) {
  const wrap = el('div', 'players bets');
  const pots = sidePots(state.game);

  pots.forEach((pot, index) => {
    const panel = el('div', 'panel winner-pick');

    const title = el('div', 'winner-title');
    title.append(
      document.createTextNode(
        pots.length === 1 ? 'מי לקח את הקופה?' : pot.isMain ? 'קופה ראשית' : `קופת צד ${index}`
      )
    );
    title.append(el('span', 'winner-amount', String(pot.amount)));
    panel.append(title);

    if (pots.length > 1) {
      panel.append(
        el(
          'p',
          'hint',
          pot.isMain
            ? 'כל מי שנשאר ביד יכול לזכות בקופה הזאת.'
            : 'רק מי שכיסה את הסכום הזה יכול לזכות בקופה הזאת.'
        )
      );
    }

    const options = el('div', 'winner-options');
    for (const id of pot.eligibleIds) {
      const player = findPlayer(id);
      if (!player) continue;
      const chosen = winnerPick[index]?.has(id);
      const b = el('button', `winner-option${chosen ? ' is-chosen' : ''}`);
      b.type = 'button';
      b.dataset.action = 'toggle-winner';
      b.dataset.id = id;
      b.dataset.pot = String(index);
      b.append(el('span', 'winner-name', player.name));
      b.append(el('span', 'winner-bet', `שם ${Number(hand.bets?.[id]) || 0}`));
      options.append(b);
    }
    panel.append(options);
    wrap.append(panel);
  });

  const unresolved = pots.filter((_, i) => !winnerPick[i] || winnerPick[i].size === 0).length;

  const buttons = el('div', 'panel actions-grid');
  const confirm = el('button', 'btn btn-primary btn-lg', 'אשר וסגור');
  confirm.type = 'button';
  confirm.dataset.action = 'confirm-winner';
  confirm.disabled = unresolved > 0;
  const back = el('button', 'btn btn-ghost', 'חזור');
  back.type = 'button';
  back.dataset.action = 'cancel-winner';
  buttons.append(confirm, back);
  if (unresolved > 0) {
    buttons.append(
      el('p', 'hint', `צריך לבחור זוכה לכל קופה - נשארו ${unresolved}.`)
    );
  }
  wrap.append(buttons);

  return wrap;
}

/* ==========================================================================
   Theme
   Light by default because a lit room needs a light page; the toggle is
   remembered per device, so the TV can sit on dark while phones stay light.
   ========================================================================== */

const THEME_KEY = 'poker-manager:theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not being able to remember the choice is not worth failing over.
  }
  const btn = $('themeToggle');
  if (btn) {
    const dark = theme === 'dark';
    btn.setAttribute('aria-label', dark ? 'עבור למצב בהיר' : 'עבור למצב כהה');
    btn.textContent = dark ? '☀' : '☾';
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  applyTheme(stored || 'light');
}

/* ==========================================================================
   Sync
   ========================================================================== */

const sync = createSync({
  onStatus: (status) => {
    renderSync(status);
    if (status === 'too-big') toast('המשחק גדול מדי לשידור');
  },

  onState: (packed, meta) => {
    if (meta?.wantsResend) {
      // Someone just joined with nothing; hand them what we have.
      sync.broadcast(state.game, { force: true });
      return;
    }
    if (!packed) return;
    state.game = normalizeSeats(sync.merge(packed, state.game));
    persist();
    render();
    toast('עודכן ממכשיר אחר');
  },

  onPeers: () => renderSync(),
});

function startSync(code, { adopt = false } = {}) {
  state.syncCode = code;
  persist();
  sync.connect(code);
  renderSync('connecting');

  // A host publishes what it already has; a joiner waits to be caught up.
  if (!adopt) setTimeout(() => sync.broadcast(state.game, { force: true }), 900);
  toast(adopt ? `מצטרף למשחק ${code}` : `המשחק פתוח: ${code}`);
}

function renderSync(status) {
  const statusEl = $('syncStatus');
  const textEl = $('syncStatusText');
  if (!statusEl || !textEl) return;

  const current = status || sync.status;
  statusEl.classList.toggle('is-live', current === 'live');
  statusEl.classList.toggle('is-error', current === 'error');
  statusEl.classList.toggle('is-connecting', current === 'connecting');

  textEl.textContent =
    current === 'live'
      ? `מסונכרן · ${state.syncCode || ''}`
      : current === 'connecting'
        ? 'מתחבר...'
        : current === 'error'
          ? 'אין חיבור לסנכרון'
          : 'לא מסונכרן';

  const hosting = Boolean(state.syncCode);
  $('codeDisplay').hidden = !hosting;
  $('codeJoin').hidden = hosting;
  if (hosting) $('codeValue').textContent = state.syncCode;
}

/** Push the game to peers after a local change, batching rapid taps. */
let broadcastTimer = null;
function scheduleBroadcast() {
  if (!state.syncCode) return;
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => sync.broadcast(state.game), 350);
}

/* ---- bet entry, typed rather than tapped ---- */

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset?.action !== 'bet-set') return;
  const hand = currentHand();
  if (!hand) return;

  const raw = target.value.trim();
  const value = raw === '' ? 0 : Number(raw);
  if (!Number.isFinite(value) || value < 0) return;

  if (value === 0) delete hand.bets[target.dataset.id];
  else hand.bets[target.dataset.id] = value;

  persist();
  scheduleBroadcast();
  renderRoundLive();
});

/** Refresh the derived numbers on the round screen without rebuilding inputs. */
function renderRoundLive() {
  const hand = currentHand();
  if (!hand) return;

  // The felt panel carries the side-pot split and the table carries the pot
  // and the bets in front of each chair. Neither holds an input, so they can
  // be redrawn on every keystroke without moving the caret.
  const felt = document.querySelector('.felt');
  if (felt) felt.replaceWith(renderHandControls(hand));

  const potValue = document.querySelector('.table-pot-value');
  if (potValue) potValue.textContent = String(handPot(hand));

  const table = document.querySelector('.poker-table');
  if (table) {
    for (const chip of table.querySelectorAll('.seat-bet')) chip.remove();
    for (const player of state.game.players) {
      const bet = Number(hand.bets?.[player.id]) || 0;
      const spot = SEAT_SPOTS[player.seat];
      if (bet <= 0 || !spot) continue;
      const chip = el('span', 'seat-bet', String(bet));
      chip.style.left = `${50 + (spot.x - 50) * 0.76}%`;
      chip.style.top = `${50 + (spot.y - 50) * 0.69}%`;
      table.append(chip);
    }
  }

  for (const player of state.game.players) {
    const input = document.querySelector(`input[data-action="bet-set"][data-id="${player.id}"]`);
    if (!input) continue;
    const meta = input.closest('.player')?.querySelector('.player-meta');
    if (meta) {
      const bet = Number(hand.bets?.[player.id]) || 0;
      meta.textContent = `נשאר ${playerStackChips(player, state.game)} · הימר ${bet}`;
    }
  }
}

/* ==========================================================================
   Start
   Last in the file: the bootstrap touches the sync session and the theme,
   both of which are declared above, so it has to run after them.
   ========================================================================== */

initTheme();
render();
switchView(activeView);

const urlCode = new URLSearchParams(location.search).get('game');
if (urlCode) startSync(urlCode.toUpperCase(), { adopt: true });
else if (state.syncCode) startSync(state.syncCode, { adopt: true });
else renderSync();
