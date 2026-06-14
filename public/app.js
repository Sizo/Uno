'use strict';

// ── Socket ───────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── State ────────────────────────────────────────────────────────────────
let myName       = null;
let roomId       = null;
let joinRoomId   = new URLSearchParams(location.search).get('room');
let gameState    = null;
let lbData       = null;
let pendingWildIdx  = null;   // card index waiting for color pick
let draftIsWild  = false;

// All 11 rules
const RULES = [
  { id: 'stack',          label: 'Stack',         desc: 'Stack +2/+4 cards',          icon: '📚', group: 'r' },
  { id: 'sevenZero',      label: '0-7',           desc: '7 swaps, 0 rotates hands',   icon: '🔄', group: 'r' },
  { id: 'forcedPlay',     label: 'Forced Play',   desc: 'Must play drawn card if valid', icon: '⚡', group: 'r' },
  { id: 'openDraft',      label: 'Open Draft',    desc: 'Preview drawn card first',   icon: '👁️', group: 'r' },
  { id: 'sideToSide',     label: 'Side 2 Side',   desc: "See opponent's hand",        icon: '👥', group: 'r' },
  { id: 'discardAll',     label: 'Discard All',   desc: 'Auto-discard same value',    icon: '🗑️', group: 's' },
  { id: 'doubleDiscard',  label: 'Dbl Discard',   desc: 'Also discard same color',    icon: '✖️', group: 's' },
  { id: 'wildTrick',      label: 'Wild Trick',    desc: 'Adds Wild +3 cards',         icon: '🎩', group: 's' },
  { id: 'timeBalloon',    label: 'Time Balloon',  desc: '30-sec timer per turn',      icon: '⏱️', group: 's' },
  { id: 'wildPunch',      label: 'Wild Punch',    desc: 'Adds Wild +6 cards',         icon: '👊', group: 's' },
  { id: 'colorChallenge', label: 'Color Challenge', desc: 'Challenge Wild +4 bluffs', icon: '⚔️', group: 's' },
];
const selectedRules = Object.fromEntries(RULES.map(r => [r.id, false]));

// ── Helpers ──────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const show = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
};
const showModal = id => $(id).classList.remove('hidden');
const hideModal = id => $(id).classList.add('hidden');

function cardLabel(card) {
  switch (card.value) {
    case 'skip':    return '⊘';
    case 'reverse': return '↺';
    case 'draw2':   return '+2';
    case 'wild':    return '★';
    case 'wild4':   return '+4';
    case 'wild3':   return '+3';
    case 'wild6':   return '+6';
    default:        return card.value;
  }
}

function canPlayCard(card, state) {
  const top   = state.topCard;
  const pd    = state.pendingDraw;
  const rules = state.rules;
  if (pd > 0) {
    if (!rules.stack) return false;
    return ['draw2', 'wild3', 'wild4', 'wild6'].includes(card.value);
  }
  if (card.color === 'wild') return true;
  const tc = top.chosenColor || top.color;
  return card.color === tc || card.value === top.value;
}

function buildCard(card, isPlayable, isDimmed) {
  const el = document.createElement('div');
  const col = card.color === 'wild' && card.chosenColor ? `wild chosen-${card.chosenColor}` : card.color;
  el.className = `card ${col}`;
  if (isPlayable) el.classList.add('playable');
  if (isDimmed)   el.classList.add('dimmed');

  const lbl = cardLabel(card);
  if (card.color === 'wild') {
    el.innerHTML = `<span class="cn tl">${lbl}</span><span class="cn br">${lbl}</span>`;
  } else {
    el.innerHTML = `
      <span class="cn tl">${lbl}</span>
      <div class="card-oval"><span class="ov-txt">${lbl}</span></div>
      <span class="cn br">${lbl}</span>
    `;
  }
  return el;
}

function buildBack(mini) {
  const el = document.createElement('div');
  el.className = mini ? 'card mini-back card-back' : 'card card-back';
  el.innerHTML = `<span class="card-back-text">UNO</span>`;
  return el;
}

// ── Boot ─────────────────────────────────────────────────────────────────
function init() {
  buildRulesGrids();
  if (joinRoomId) {
    show('screen-join');
    $('join-content').innerHTML = `<div class="spinner"></div><p style="margin-top:14px">Loading room…</p>`;
    socket.emit('getRoomInfo', { roomId: joinRoomId });
  } else {
    show('screen-pick');
  }
}

function buildRulesGrids() {
  const gridR = $('grid-rules');
  const gridS = $('grid-special');
  RULES.forEach(rule => {
    const tile = document.createElement('div');
    tile.className    = 'rule-tile';
    tile.dataset.rule = rule.id;
    tile.title        = rule.desc;
    tile.innerHTML = `<div class="r-icon">${rule.icon}</div><div class="r-name">${rule.label}</div><div class="rtick">✓</div>`;
    tile.onclick      = () => toggleRule(rule.id, tile);
    (rule.group === 'r' ? gridR : gridS).appendChild(tile);
  });
}

function toggleRule(id, tile) {
  selectedRules[id] = !selectedRules[id];
  tile.classList.toggle('on', selectedRules[id]);
}

// ── Player pick ───────────────────────────────────────────────────────────
function pickPlayer(name) {
  myName = name;
  const lbl = $('picked-as-label');
  lbl.textContent = `Playing as ${name}`;
  lbl.style.color = name === 'Sizo' ? 'var(--sizo)' : 'var(--sinalo)';
  show('screen-rules');
}

// ── Create room ───────────────────────────────────────────────────────────
function createRoom() {
  socket.emit('createRoom', { playerName: myName, rules: { ...selectedRules } });
}

socket.on('roomCreated', ({ roomId: id }) => {
  roomId = id;
  const url = `${location.origin}/?room=${id}`;
  $('url-box').textContent = url;
  show('screen-waiting');
});

// ── Join room ─────────────────────────────────────────────────────────────
socket.on('roomInfo', ({ availableName, error }) => {
  if (error) {
    $('join-content').innerHTML = `
      <p style="color:#E53935;font-weight:700;font-size:16px">⚠️ ${error}</p>
      <p class="muted" style="margin-top:8px">Ask for a new link.</p>
    `;
    return;
  }
  myName = availableName;
  const col = availableName === 'Sizo' ? 'var(--sizo)' : 'var(--sinalo)';
  $('join-content').innerHTML = `
    <p style="color:var(--muted);font-size:16px;margin-bottom:4px">You are joining as</p>
    <h2 style="font-family:'Fredoka One',cursive;font-size:46px;color:${col};margin:4px 0 20px">${availableName}</h2>
    <button class="btn-green" onclick="joinRoom()">Join Game 🎮</button>
  `;
});

function joinRoom() {
  socket.emit('joinRoom', { roomId: joinRoomId, playerName: myName });
}

socket.on('joined',    ({ playerName }) => { myName = playerName; });
socket.on('joinError', msg => alert('Cannot join: ' + msg));

socket.on('gameStarted', () => {
  show('screen-game');
  socket.emit('getLb');
});

// ── Game state ────────────────────────────────────────────────────────────
socket.on('state', state => {
  gameState = state;
  render(state);
});

socket.on('swapped', () => {
  showToast('🔄 Hands swapped!');
});

socket.on('rematchVote', ({ player }) => {
  $('rematch-status').textContent = `${player} wants a rematch…`;
});

socket.on('oppLeft', () => {
  showToast('😢 Opponent left the game');
  hideModal('modal-winner');
  setTimeout(() => { location.search = ''; }, 3000);
});

socket.on('lb', data => {
  lbData = data;
  if (!$('lb-panel').classList.contains('hidden')) renderLbPanel(data);
  renderLbMini(data);
});

// ── Render ────────────────────────────────────────────────────────────────
function render(state) {
  // Names + dots
  const opp = state.opponentName || '…';
  $('opp-name').textContent = opp;
  $('my-name').textContent  = myName;
  $('opp-count').textContent = state.opponentCardCount;
  $('my-count').textContent  = state.myHand.length;
  $('deck-count').textContent = state.deckCount;

  const oppDot = $('opp-dot');
  const myDot  = $('my-dot');
  oppDot.className = `pdot ${opp.toLowerCase()}`;
  myDot.className  = `pdot ${myName ? myName.toLowerCase() : ''}`;

  // Direction badge
  $('dir-badge').textContent = state.direction === 1 ? '→' : '←';

  // Status bar
  const bar = $('status-bar');
  if (state.winner) {
    bar.textContent = state.winner === myName ? '🎉 You Win!' : `${state.winner} Wins!`;
    bar.className   = 'status-bar';
    showWinner(state);
  } else if (state.challengePending) {
    bar.textContent = '⚔️ Wild +4 — Challenge or accept?';
    bar.className   = 'status-bar';
    showModal('modal-challenge');
  } else if (state.isMyTurn && state.draft) {
    bar.textContent = 'You drew — play it or keep it?';
    bar.className   = 'status-bar my-turn';
  } else if (state.isMyTurn) {
    bar.textContent = state.pendingDraw > 0
      ? `Stack or draw ${state.pendingDraw}!`
      : '✨ Your turn — play a card';
    bar.className = 'status-bar my-turn';
  } else {
    bar.textContent = `${state.currentPlayer}'s turn…`;
    bar.className   = 'status-bar';
  }

  // Draw pile clickability
  const drawPile = $('draw-pile');
  const canDraw  = state.isMyTurn && !state.winner && !state.challengePending && !state.draft;
  drawPile.style.opacity = canDraw ? '1' : '0.4';

  // Top card
  renderTopCard(state.topCard);

  // Hands
  renderOppHand(state);
  renderMyHand(state);

  // Draft modal
  if (state.draft && state.isMyTurn) {
    renderDraftModal(state.draft, state);
  } else {
    hideModal('modal-draft');
  }

  // Challenge modal — only show if not already showing winner
  if (!state.challengePending || state.winner) hideModal('modal-challenge');

  // UNO button
  const unoBtn = $('uno-btn');
  unoBtn.classList.toggle('hidden', !(state.myHand.length === 1 && state.isMyTurn));
}

function renderTopCard(card) {
  const el = $('top-card');
  el.innerHTML = '';
  const col = card.color === 'wild' && card.chosenColor ? `wild chosen-${card.chosenColor}` : card.color;
  el.className = `card ${col}`;
  const lbl = cardLabel(card);
  if (card.color === 'wild') {
    el.innerHTML = `<span class="cn tl">${lbl}</span><span class="cn br">${lbl}</span>`;
  } else {
    el.innerHTML = `
      <span class="cn tl">${lbl}</span>
      <div class="card-oval"><span class="ov-txt">${lbl}</span></div>
      <span class="cn br">${lbl}</span>
    `;
  }
}

function renderOppHand(state) {
  const row = $('opp-hand');
  row.innerHTML = '';
  if (state.opponentHand) {
    // Side 2 Side — show face up
    state.opponentHand.forEach(card => {
      row.appendChild(buildCard(card, false, false));
    });
  } else {
    const n = Math.min(state.opponentCardCount, 16);
    for (let i = 0; i < n; i++) row.appendChild(buildBack(true));
    if (state.opponentCardCount > 16) {
      const more = document.createElement('span');
      more.style.cssText = 'color:var(--muted);font-size:13px;padding:0 8px;align-self:center';
      more.textContent   = `+${state.opponentCardCount - 16}`;
      row.appendChild(more);
    }
  }
}

function renderMyHand(state) {
  const row = $('my-hand');
  row.innerHTML = '';

  const active  = state.isMyTurn && !state.winner && !state.draft && !state.challengePending;
  const topEffColor = state.topCard.chosenColor || state.topCard.color;

  state.myHand.forEach((card, i) => {
    const playable = active && canPlayCard(card, state);
    const dimmed   = active && !playable;
    const el       = buildCard(card, playable, dimmed);

    if (playable) {
      el.onclick = () => onCardClick(card, i, state);
    } else if (state.rules.jumpIn && !state.winner) {
      // Jump-in: anyone can play an identical card out of turn
      const t = state.topCard;
      const tc = t.chosenColor || t.color;
      if (card.color !== 'wild' && card.color === tc && card.value === t.value) {
        el.classList.remove('dimmed');
        el.classList.add('playable');
        el.style.borderColor = '#FDD835';
        el.title = 'Jump In!';
        el.onclick = () => socket.emit('jumpIn', { cardIdx: i });
      }
    }
    row.appendChild(el);
  });
}

// ── Card click ────────────────────────────────────────────────────────────
function onCardClick(card, cardIdx, state) {
  if (card.color === 'wild') {
    pendingWildIdx = cardIdx;
    draftIsWild    = false;
    showModal('modal-color');
  } else {
    socket.emit('playCard', { cardIdx, chosenColor: null });
  }
}

function onDrawClick() {
  if (!gameState?.isMyTurn || gameState?.winner || gameState?.challengePending) return;
  socket.emit('drawCard');
}

// ── Color pick ────────────────────────────────────────────────────────────
function pickColor(color) {
  hideModal('modal-color');
  if (draftIsWild) {
    socket.emit('draftDecide', { play: true, chosenColor: color });
    draftIsWild = false;
  } else if (pendingWildIdx !== null) {
    socket.emit('playCard', { cardIdx: pendingWildIdx, chosenColor: color });
    pendingWildIdx = null;
  }
}

// ── Draft (Open Draft rule) ───────────────────────────────────────────────
function renderDraftModal(card, state) {
  const wrap    = $('draft-card-wrap');
  wrap.innerHTML = '';
  const el = buildCard(card, false, false);
  el.style.width  = '78px';
  el.style.height = '117px';
  el.style.animation = 'none';
  wrap.appendChild(el);

  const playable = canPlayCard(card, { ...state, pendingDraw: 0 });
  const keepBtn  = $('draft-keep-btn');
  const playBtn  = $('draft-play-btn');
  const hint     = $('draft-hint');

  if (state.rules.forcedPlay && playable) {
    keepBtn.classList.add('hidden');
    hint.textContent = 'It\'s playable — you must play it!';
  } else {
    keepBtn.classList.remove('hidden');
    hint.textContent = playable ? 'You can play this card' : 'Not playable — you must keep it';
  }

  playBtn.disabled      = !playable;
  playBtn.style.opacity = playable ? '1' : '0.4';

  showModal('modal-draft');
}

function draftDecide(play) {
  if (!gameState) return;
  const draft = gameState.draft;
  if (play && draft?.color === 'wild') {
    draftIsWild    = true;
    pendingWildIdx = null;
    hideModal('modal-draft');
    showModal('modal-color');
    return;
  }
  hideModal('modal-draft');
  socket.emit('draftDecide', { play, chosenColor: null });
}

// ── Challenge ─────────────────────────────────────────────────────────────
function sendChallenge() {
  hideModal('modal-challenge');
  socket.emit('challenge');
}
function declineChallenge() {
  hideModal('modal-challenge');
  socket.emit('declineChallenge');
}

// ── Rematch ───────────────────────────────────────────────────────────────
function voteRematch() {
  $('rematch-status').textContent = 'Waiting for opponent…';
  socket.emit('rematch');
  socket.once('gameStarted', () => {
    hideModal('modal-winner');
    $('rematch-status').textContent = '';
  });
}

// ── Winner ────────────────────────────────────────────────────────────────
function showWinner(state) {
  const won = state.winner === myName;
  const titleEl = $('winner-title');
  titleEl.textContent = won ? '🎉 You Win!' : `${state.winner} Wins! 😔`;
  titleEl.style.color = won ? '#FDD835' : (state.winner === 'Sizo' ? 'var(--sizo)' : 'var(--sinalo)');
  showModal('modal-winner');
  if (won) confetti();
  socket.emit('getLb');
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  clearTimeout(toastTimer);
  const bar = $('status-bar');
  const prev = bar.textContent;
  bar.textContent = msg;
  toastTimer = setTimeout(() => {
    if (gameState) render(gameState);
    else bar.textContent = prev;
  }, 3000);
}

// ── Leaderboard ───────────────────────────────────────────────────────────
function toggleLb() {
  const p = $('lb-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    socket.emit('getLb');
  }
}

function renderLbPanel(data) {
  $('lb-content').innerHTML =
    lbSec('🏆 All Time',  data.allTime) +
    lbSec('📅 Today',     data.daily)   +
    lbSec('📆 This Week', data.weekly);
}

function lbSec(title, data) {
  const sz = data['Sizo']   || 0;
  const sn = data['Sinalo'] || 0;
  return `
    <div class="lb-section">
      <div class="lb-section-title">${title}</div>
      <div class="lb-row"><span class="lb-name sizo">Sizo</span><span class="lb-wins">${sz}</span></div>
      <div class="lb-row"><span class="lb-name sinalo">Sinalo</span><span class="lb-wins">${sn}</span></div>
    </div>`;
}

function renderLbMini(data) {
  const el = $('lb-mini-wrap');
  if (!el) return;
  const at = data.allTime || {};
  const dy = data.daily   || {};
  const wk = data.weekly  || {};
  el.innerHTML = `
    <div class="lbm-row"><span>All Time</span><span class="lbm-scores">Sizo ${at['Sizo']||0} · Sinalo ${at['Sinalo']||0}</span></div>
    <div class="lbm-row"><span>Today</span><span class="lbm-scores">Sizo ${dy['Sizo']||0} · Sinalo ${dy['Sinalo']||0}</span></div>
    <div class="lbm-row"><span>This Week</span><span class="lbm-scores">Sizo ${wk['Sizo']||0} · Sinalo ${wk['Sinalo']||0}</span></div>
  `;
}

// ── Confetti ──────────────────────────────────────────────────────────────
function confetti() {
  const stage  = $('confetti-stage');
  stage.innerHTML = '';
  const colors = ['#E53935','#1E88E5','#43A047','#FDD835','#D81B60','#FF9800'];
  for (let i = 0; i < 48; i++) {
    const p = document.createElement('div');
    const sz = 5 + Math.random() * 9;
    p.style.cssText = `
      position:absolute;
      width:${sz}px; height:${sz}px;
      background:${colors[Math.floor(Math.random() * colors.length)]};
      left:${Math.random() * 100}%;
      top:-10px;
      border-radius:${Math.random() > .5 ? '50%' : '2px'};
      animation: cf-fall ${1.2 + Math.random() * 1.4}s ease-out forwards;
      animation-delay:${Math.random() * .6}s;
      opacity:1;
    `;
    stage.appendChild(p);
  }
  setTimeout(() => { stage.innerHTML = ''; }, 3500);
}

// ── Copy URL ──────────────────────────────────────────────────────────────
function copyUrl() {
  const url = $('url-box').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const t = $('copy-toast');
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 2200);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

// ── Keep-alive ────────────────────────────────────────────────────────────
setInterval(() => socket.emit('ping'), 13 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────
init();
