import {
  toCents,
  fromCents,
  computeGame,
  settle,
  distributeDiff,
  leaderboard,
} from './src/engine.js';

import { load, save, archive, newGame, newPlayer, exportJSON } from './src/store.js';

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
  const adjusted = state.game.adjustment
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

  $('settingsPreview').textContent =
    g.mode === 'chips'
      ? `${money(g.buyInCents)} · ${g.chipsPerBuyIn} ז'יטונים`
      : `${money(g.buyInCents)} · ספירה בכסף`;

  $('chipValueHint').textContent =
    g.mode === 'chips' && g.chipsPerBuyIn > 0
      ? `כל ז'יטון שווה ${money(Math.round((g.buyInCents / g.chipsPerBuyIn) * 100) / 100)}. בסוף המשחק כל שחקן מזין כמה ז'יטונים נשארו לו.`
      : 'בסוף המשחק כל שחקן מזין ישירות את סכום הכסף שנשאר לו.';
}

function emptyState(icon, message) {
  const wrap = el('div', 'card empty');
  wrap.append(el('span', 'empty-icon', icon), el('p', null, message));
  return wrap;
}

function renderPlayers() {
  const list = $('playersList');
  list.textContent = '';

  if (state.game.players.length === 0) {
    list.append(emptyState('🪑', 'עוד לא הוספת שחקנים. תוסיף את כולם למעלה ונתחיל.'));
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
        `${stats.buyInCount} כניסות · ${money(stats.inCents)}`
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
    list.append(emptyState('🪙', 'אין שחקנים עדיין. תחזור למסך "משחק" ותוסיף אותם.'));
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
    note.append(el('div', 'status-title', 'עוד לא סיימתם לספור'));
    note.append(el('div', null, `נשארו ${total - counted} שחקנים בלי ספירה.`));
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
    root.append(emptyState('💸', 'אין עדיין משחק לחשב. תוסיף שחקנים ותתחיל לשחק.'));
    return;
  }

  const { effective, settlement } = currentResults();
  const counted = effective.players.filter((p) => p.cashedOut).length;

  if (counted === 0) {
    root.append(emptyState('🪙', 'עוד לא נספרו ז\'יטונים. תעבור למסך "ספירה" כדי להזין כמה נשאר לכל אחד.'));
    return;
  }

  if (counted < state.game.players.length) {
    const warn = el('div', 'card status warn');
    warn.append(el('div', 'status-title', 'החישוב חלקי'));
    warn.append(
      el('div', null, `${state.game.players.length - counted} שחקנים עוד לא נספרו, אז החשבון עוד ישתנה.`)
    );
    root.append(warn);
  } else if (!effective.balanced) {
    const warn = el('div', 'card status warn');
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

  const table = el('div', 'card list-card');
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
      transfers.length === 0 ? 'אין תשלומים' : `${transfers.length} העברות`
    )
  );

  if (transfers.length === 0) {
    root.append(emptyState('🤝', 'כולם יצאו בדיוק באפס. אף אחד לא חייב לאף אחד.'));
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
  const actions = el('div', 'card actions-grid');

  const share = el('button', 'btn btn-primary', '📤 שתף סיכום');
  share.type = 'button';
  share.dataset.action = 'share';

  const copy = el('button', 'btn', '📋 העתק');
  copy.type = 'button';
  copy.dataset.action = 'copy';

  actions.append(share, copy);
  root.append(actions);

  const finish = el('div', 'card');
  const finishBtn = el('button', 'btn btn-primary btn-block btn-lg', '✅ סיים משחק ושמור בהיסטוריה');
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
    root.append(emptyState('📜', 'אין עדיין משחקים שמורים. כשתסיים משחק הוא יופיע כאן.'));
    return;
  }

  root.append(sectionHead('משחקים קודמים', `${state.history.length} משחקים`));

  for (const game of state.history) {
    const card = el('div', 'card history-item');

    const head = el('div', 'history-head');
    const date = new Date(game.endedAt || game.startedAt);
    head.append(
      el('span', 'history-date', date.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' }))
    );
    head.append(
      el('span', 'history-meta', `${game.summary?.players?.length ?? 0} שחקנים · ${game.currency}${fromCents(game.summary?.totalInCents ?? 0)}`)
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

  const tools = el('div', 'card actions-grid');
  const exportBtn = el('button', 'btn', '⬇️ ייצוא נתונים');
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
    state.game.players = state.game.players.filter((p) => p.id !== id);
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
  handler(target.dataset.id);
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

  const withBuyIn = $('autoBuyIn').checked ? state.game.buyInCents : 0;
  state.game.players.push(newPlayer(name, withBuyIn));
  input.value = '';
  input.focus();
  commit();
});

$('resetGameBtn').addEventListener('click', () => {
  if (!confirm('לאפס את המשחק הנוכחי? כל השחקנים והכניסות יימחקו.')) return;
  state.game = newGame(state.game);
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

$('tabbar').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);
});

/* ---- offline support ---- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a bonus; the app works fine without it.
    });
  });
}

/* ---- go ---- */

render();
switchView(activeView);
