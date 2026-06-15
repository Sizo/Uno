'use strict';

// ── Socket ───────────────────────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── State ────────────────────────────────────────────────────────────────
let myName       = null;
let roomId       = null;
let joinRoomId   = new URLSearchParams(location.search).get('room');
let gameState    = null;
let lbData       = null;
let pendingWildIdx = null;
let draftIsWild  = false;
let soundOn      = true;
let timerRAF     = null;
let prevMyCount  = 7;
let revealTimer  = null;

// All rules — Jump-In added; every rule ON by default
const RULES = [
  { id: 'stack',          label: 'Stack',          desc: 'Stack +2/+4 cards',            icon: '📚', group: 'r' },
  { id: 'sevenZero',      label: '0-7',            desc: '7 & 0 swap hands',             icon: '🔄', group: 'r' },
  { id: 'forcedPlay',     label: 'Forced Play',    desc: 'Must play drawn card if valid',icon: '⚡', group: 'r' },
  { id: 'openDraft',      label: 'Open Draft',     desc: 'Preview drawn card first',     icon: '👁️', group: 'r' },
  { id: 'sideToSide',     label: 'Side 2 Side',    desc: "See opponent's hand",          icon: '👥', group: 'r' },
  { id: 'jumpIn',         label: 'Jump In',        desc: 'Play identical card any time', icon: '🏃', group: 'r' },
  { id: 'discardAll',     label: 'Discard All',    desc: 'Auto-discard same value',      icon: '🗑️', group: 's' },
  { id: 'doubleDiscard',  label: 'Dbl Discard',    desc: 'Also discard same color',      icon: '✖️', group: 's' },
  { id: 'wildTrick',      label: 'Wild Trick',     desc: 'Adds Wild +3 cards',           icon: '🎩', group: 's' },
  { id: 'wildPunch',      label: 'Wild Punch',     desc: 'Adds Wild +6 cards',           icon: '👊', group: 's' },
  { id: 'colorChallenge', label: 'Color Challenge',desc: 'Challenge Wild +4 bluffs',     icon: '⚔️', group: 's' },
];
const selectedRules = Object.fromEntries(RULES.map(r => [r.id, true])); // default ALL on

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
  const top = state.topCard;
  const pd  = state.pendingDraw;
  if (pd > 0) {
    if (!state.rules.stack) return false;
    return ['draw2', 'wild3', 'wild4', 'wild6'].includes(card.value);
  }
  if (card.color === 'wild') return true;
  const tc = top.chosenColor || top.color;
  return card.color === tc || card.value === top.value;
}

function cardInnerHTML(card) {
  const lbl = cardLabel(card);
  if (card.color === 'wild') {
    return `<div class="card-inner">
        <span class="cn tl">${lbl}</span>
        <div class="wild-oval"><div class="wild-quad"><span class="wq r"></span><span class="wq b"></span><span class="wq g"></span><span class="wq y"></span></div><span class="wild-label">${lbl}</span></div>
        <span class="cn br">${lbl}</span>
      </div>`;
  }
  return `<div class="card-inner">
      <span class="cn tl">${lbl}</span>
      <div class="card-oval"><span class="ov-txt">${lbl}</span></div>
      <span class="cn br">${lbl}</span>
    </div>`;
}

function buildCard(card, isPlayable, isDimmed) {
  const el = document.createElement('div');
  const col = card.color === 'wild' && card.chosenColor ? `wild chosen-${card.chosenColor}` : card.color;
  el.className = `card ${col}`;
  if (isPlayable) el.classList.add('playable');
  if (isDimmed)   el.classList.add('dimmed');
  el.innerHTML = cardInnerHTML(card);
  return el;
}

function buildBack(mini) {
  const el = document.createElement('div');
  el.className = mini ? 'card mini-back card-back' : 'card card-back';
  el.innerHTML = `<div class="back-inner"><div class="back-oval"><span class="back-uno">UNO</span></div></div>`;
  return el;
}

// ── Sound (Web Audio, no assets) ───────────────────────────────────────────
let audioCtx = null;
function beep(freq = 440, dur = 0.08, type = 'sine', vol = 0.08) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.stop(audioCtx.currentTime + dur);
  } catch {}
}
const sfx = {
  play:  () => beep(520, 0.09, 'triangle', 0.09),
  draw:  () => beep(300, 0.08, 'sine', 0.07),
  turn:  () => beep(660, 0.06, 'sine', 0.05),
  win:   () => { beep(523,0.12,'triangle',0.1); setTimeout(()=>beep(659,0.12,'triangle',0.1),120); setTimeout(()=>beep(784,0.2,'triangle',0.1),260); },
  lose:  () => { beep(330,0.15,'sine',0.08); setTimeout(()=>beep(247,0.25,'sine',0.08),150); },
  uno:   () => beep(880, 0.15, 'square', 0.08),
};
function toggleSound() {
  soundOn = !soundOn;
  $('sound-btn').textContent = soundOn ? '🔊' : '🔇';
  if (soundOn) sfx.turn();
}

// ── Boot ─────────────────────────────────────────────────────────────────
function init() {
  buildRulesGrids();
  checkOrientation();
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', checkOrientation);
  if (joinRoomId) {
    show('screen-join');
    $('join-content').innerHTML = `<div class="spinner"></div><p style="margin-top:14px">Loading room…</p>`;
    socket.emit('getRoomInfo', { roomId: joinRoomId });
  } else {
    show('screen-pick');
  }
}

let rotateDismissed = false;
function checkOrientation() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const inGame   = !$('screen-game').classList.contains('hidden');
  const narrow   = window.innerWidth < 600;
  if (inGame && portrait && narrow && !rotateDismissed) $('rotate-hint').classList.remove('hidden');
  else $('rotate-hint').classList.add('hidden');
}
function dismissRotate() { rotateDismissed = true; $('rotate-hint').classList.add('hidden'); }

function buildRulesGrids() {
  const gridR = $('grid-rules');
  const gridS = $('grid-special');
  RULES.forEach(rule => {
    const tile = document.createElement('div');
    tile.className    = 'rule-tile on';          // ON by default
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
function setAllRules(on) {
  document.querySelectorAll('.rule-tile').forEach(t => {
    selectedRules[t.dataset.rule] = on;
    t.classList.toggle('on', on);
  });
}

// ── Player pick ───────────────────────────────────────────────────────────
function pickPlayer(name) {
  myName = name;
  const lbl = $('picked-as-label');
  lbl.textContent = `Playing as ${name}`;
  lbl.style.color = name === 'Sizo' ? '#64B5F6' : '#F48FB1';
  show('screen-rules');
}

// ── Create room ───────────────────────────────────────────────────────────
function createRoom() {
  socket.emit('createRoom', { playerName: myName, rules: { ...selectedRules } });
}
socket.on('roomCreated', ({ roomId: id }) => {
  roomId = id;
  $('url-box').textContent = `${location.origin}/?room=${id}`;
  show('screen-waiting');
});

// ── Join room ─────────────────────────────────────────────────────────────
socket.on('roomInfo', ({ availableName, error }) => {
  if (error) {
    $('join-content').innerHTML = `<p style="color:#EF5350;font-weight:700;font-size:16px">⚠️ ${error}</p><p class="muted" style="margin-top:8px">Ask for a new link.</p>`;
    return;
  }
  myName = availableName;
  const col = availableName === 'Sizo' ? '#64B5F6' : '#F48FB1';
  $('join-content').innerHTML = `
    <p style="color:var(--muted);font-size:16px;margin-bottom:4px">You are joining as</p>
    <h2 style="font-family:'Fredoka One',cursive;font-size:44px;color:${col};margin:4px 0 20px">${availableName}</h2>
    <button class="btn-green" onclick="joinRoom()">Join Game 🎮</button>`;
});
function joinRoom() { socket.emit('joinRoom', { roomId: joinRoomId, playerName: myName }); }
socket.on('joined',    ({ playerName }) => { myName = playerName; });
socket.on('joinError', msg => alert('Cannot join: ' + msg));

socket.on('gameStarted', () => {
  show('screen-game');
  hideModal('modal-winner');
  $('reveal-overlay').classList.add('hidden');
  prevMyCount = 7;
  checkOrientation();
  socket.emit('getLb');
  sfx.turn();
});

// ── Game state ────────────────────────────────────────────────────────────
socket.on('state', state => {
  const prev = gameState;
  gameState = state;
  render(state, prev);
});
socket.on('swapped', () => showToast('🔄 Hands swapped!'));
socket.on('rematchVote', ({ player }) => { $('rematch-status').textContent = `${player} wants a rematch…`; });
socket.on('oppLeft', () => {
  showToast('😢 Opponent left the game');
  hideModal('modal-winner');
  setTimeout(() => { location.search = ''; }, 2500);
});
socket.on('lb', data => {
  lbData = data;
  if (!$('lb-panel').classList.contains('hidden')) renderLbPanel(data);
  renderLbMini(data);
});
socket.on('reaction', ({ emoji }) => floatEmoji(emoji));

// ── Render ────────────────────────────────────────────────────────────────
function render(state, prev) {
  const opp = state.opponentName || '…';
  $('opp-name').textContent  = opp;
  $('my-name').textContent   = myName;
  $('opp-count').textContent = state.opponentCardCount;
  $('my-count').textContent  = state.myHand.length;
  $('deck-count').textContent = state.deckCount;

  $('opp-dot').className = `pdot ${opp.toLowerCase()}`;
  $('my-dot').className  = `pdot ${myName ? myName.toLowerCase() : ''}`;

  // Direction
  const dir = $('dir-badge');
  dir.textContent = state.direction === 1 ? '↻' : '↺';
  dir.classList.toggle('rev', state.direction !== 1);

  // Active-player glow on strips
  const oppStrip = $('opp-strip'), myStrip = $('my-strip');
  oppStrip.className = 'player-strip opp-strip';
  myStrip.className  = 'player-strip my-strip';
  if (!state.winner) {
    if (state.isMyTurn) { myStrip.classList.add('active-turn', `${myName.toLowerCase()}-turn`); }
    else                { oppStrip.classList.add('active-turn', `${opp.toLowerCase()}-turn`); }
  }

  // Turn change sound
  if (prev && prev.currentPlayer !== state.currentPlayer && !state.winner) sfx.turn();

  // Status bar
  const bar = $('status-bar');
  if (state.winner) {
    bar.textContent = state.winner === myName ? '🎉 You Win!' : `${state.winner} Wins!`;
    bar.className = 'status-bar';
  } else if (state.challengePending) {
    bar.textContent = '⚔️ Wild +4 — Challenge or accept?';
    bar.className = 'status-bar';
    showModal('modal-challenge');
  } else if (state.isMyTurn && state.draft) {
    bar.textContent = 'You drew — play it or keep it?';
    bar.className = 'status-bar my-turn';
  } else if (state.isMyTurn) {
    bar.textContent = state.pendingDraw > 0 ? `⚠️ Stack or draw ${state.pendingDraw}!` : '✨ Your turn — play a card';
    bar.className = state.pendingDraw > 0 ? 'status-bar danger' : 'status-bar my-turn';
  } else {
    bar.textContent = `${state.currentPlayer}'s turn…`;
    bar.className = 'status-bar';
  }

  // Draw pile clickability
  const canDraw = state.isMyTurn && !state.winner && !state.challengePending && !state.draft;
  $('draw-pile').style.opacity = canDraw ? '1' : '0.45';

  renderTopCard(state.topCard, prev);
  renderOppHand(state);
  renderMyHand(state, prev);

  // Draft modal
  if (state.draft && state.isMyTurn) renderDraftModal(state.draft, state);
  else hideModal('modal-draft');

  if (!state.challengePending || state.winner) hideModal('modal-challenge');

  // UNO button
  $('uno-btn').classList.toggle('hidden', !(state.myHand.length === 1 && state.isMyTurn));
  if (state.myHand.length === 1 && state.isMyTurn && prev && prev.myHand.length !== 1) sfx.uno();

  // Turn timer ring
  updateTimerRing(state);

  // Win flow — reveal then modal
  if (state.winner && (!prev || !prev.winner)) handleWin(state);
}

function renderTopCard(card, prev) {
  const el = $('top-card');
  const col = card.color === 'wild' && card.chosenColor ? `wild chosen-${card.chosenColor}` : card.color;
  el.className = `card ${col}`;
  el.innerHTML = cardInnerHTML(card);
  // replay placement animation when top changes
  if (prev && JSON.stringify(prev.topCard) !== JSON.stringify(card)) {
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    sfx.play();
  }
}

function renderOppHand(state) {
  const row = $('opp-hand');
  row.innerHTML = '';
  if (state.opponentHand) {
    state.opponentHand.forEach(card => row.appendChild(buildCard(card, false, false)));
  } else {
    const n = Math.min(state.opponentCardCount, 14);
    for (let i = 0; i < n; i++) row.appendChild(buildBack(true));
    if (state.opponentCardCount > 14) {
      const more = document.createElement('span');
      more.style.cssText = 'color:var(--muted);font-size:13px;padding:0 8px;align-self:center';
      more.textContent = `+${state.opponentCardCount - 14}`;
      row.appendChild(more);
    }
  }
}

function renderMyHand(state, prev) {
  const row = $('my-hand');
  row.innerHTML = '';
  const active = state.isMyTurn && !state.winner && !state.draft && !state.challengePending;
  const drew   = state.myHand.length > prevMyCount;

  state.myHand.forEach((card, i) => {
    const playable = active && canPlayCard(card, state);
    const dimmed   = active && !playable;
    const el       = buildCard(card, playable, dimmed);

    // flash newly drawn cards (the tail of the hand)
    if (drew && i >= prevMyCount) el.classList.add('just-drawn');

    if (playable) {
      el.onclick = () => onCardClick(card, i, state);
    } else if (state.rules.jumpIn && !state.winner && !state.isMyTurn) {
      const t = state.topCard;
      const tc = t.chosenColor || t.color;
      if (card.color !== 'wild' && card.color === tc && card.value === t.value) {
        el.classList.remove('dimmed');
        el.classList.add('playable');
        el.title = 'Jump In!';
        el.onclick = () => { socket.emit('jumpIn', { cardIdx: i }); sfx.play(); };
      }
    }
    row.appendChild(el);
  });
  if (drew) sfx.draw();
  prevMyCount = state.myHand.length;
}

// ── Timer ring ──────────────────────────────────────────────────────────────
function updateTimerRing(state) {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  const myRing  = $('my-ring');
  const oppRing = $('opp-ring');
  myRing.classList.add('hidden');
  oppRing.classList.add('hidden');

  if (state.winner || !state.turnEndsAt) return;

  const ring   = state.isMyTurn ? myRing : oppRing;
  const fg     = state.isMyTurn ? $('my-ring-fg') : $('opp-ring-fg');
  const num    = state.isMyTurn ? $('my-ring-num') : $('opp-ring-num');
  const circ   = 2 * Math.PI * 17; // 106.8
  ring.classList.remove('hidden');

  let warned = false;
  const tick = () => {
    const remain = Math.max(0, state.turnEndsAt - Date.now());
    const frac   = remain / (state.turnMs || 20000);
    fg.style.strokeDashoffset = (circ * (1 - frac)).toFixed(1);
    const secs = Math.ceil(remain / 1000);
    num.textContent = secs;
    ring.classList.toggle('warn', frac <= 0.5 && frac > 0.25);
    ring.classList.toggle('danger', frac <= 0.25);
    if (state.isMyTurn && secs <= 5 && secs > 0 && !warned) { warned = true; }
    if (state.isMyTurn && remain > 0 && secs <= 5) {
      // soft ticking in last 5s
    }
    if (remain > 0 && gameState && gameState.turnEndsAt === state.turnEndsAt) {
      timerRAF = requestAnimationFrame(tick);
    }
  };
  tick();
}

// ── Card click ────────────────────────────────────────────────────────────
function onCardClick(card, cardIdx, state) {
  if (card.color === 'wild') {
    pendingWildIdx = cardIdx;
    draftIsWild = false;
    showModal('modal-color');
  } else {
    socket.emit('playCard', { cardIdx, chosenColor: null });
    sfx.play();
  }
}
function onDrawClick() {
  if (!gameState?.isMyTurn || gameState?.winner || gameState?.challengePending || gameState?.draft) return;
  socket.emit('drawCard');
}

// ── Color pick ────────────────────────────────────────────────────────────
function pickColor(color) {
  hideModal('modal-color');
  if (draftIsWild) { socket.emit('draftDecide', { play: true, chosenColor: color }); draftIsWild = false; }
  else if (pendingWildIdx !== null) { socket.emit('playCard', { cardIdx: pendingWildIdx, chosenColor: color }); pendingWildIdx = null; }
  sfx.play();
}

// ── Draft ───────────────────────────────────────────────────────────────────
function renderDraftModal(card, state) {
  const wrap = $('draft-card-wrap');
  wrap.innerHTML = '';
  const el = buildCard(card, false, false);
  el.style.width = '78px'; el.style.height = '117px'; el.style.animation = 'none';
  wrap.appendChild(el);
  const playable = canPlayCard(card, { ...state, pendingDraw: 0 });
  const keepBtn = $('draft-keep-btn'), playBtn = $('draft-play-btn'), hint = $('draft-hint');
  if (state.rules.forcedPlay && playable) {
    keepBtn.classList.add('hidden');
    hint.textContent = "It's playable — you must play it!";
  } else {
    keepBtn.classList.remove('hidden');
    hint.textContent = playable ? 'You can play this card' : 'Not playable — you must keep it';
  }
  playBtn.disabled = !playable;
  playBtn.style.opacity = playable ? '1' : '0.4';
  showModal('modal-draft');
}
function draftDecide(play) {
  if (!gameState) return;
  const draft = gameState.draft;
  if (play && draft?.color === 'wild') {
    draftIsWild = true; pendingWildIdx = null;
    hideModal('modal-draft'); showModal('modal-color'); return;
  }
  hideModal('modal-draft');
  socket.emit('draftDecide', { play, chosenColor: null });
}

// ── Challenge ─────────────────────────────────────────────────────────────
function sendChallenge()    { hideModal('modal-challenge'); socket.emit('challenge'); }
function declineChallenge() { hideModal('modal-challenge'); socket.emit('declineChallenge'); }

// ── Rematch ───────────────────────────────────────────────────────────────
function voteRematch() {
  $('rematch-status').textContent = 'Waiting for opponent…';
  socket.emit('rematch');
}

// ── Win flow (3s reveal → winner modal) ─────────────────────────────────────
function handleWin(state) {
  const won = state.winner === myName;
  won ? sfx.win() : sfx.lose();

  // Reveal the loser's hand for 3 seconds.
  // Server sends opponentHand (= loser's cards) to the winner; the loser sees their own hand.
  const loser      = state.winner === 'Sizo' ? 'Sinalo' : 'Sizo';
  const handToShow = won ? (state.opponentHand || []) : state.myHand;

  $('reveal-title').textContent = `${loser}'s hand (${handToShow.length})`;
  const rc = $('reveal-cards');
  rc.innerHTML = '';
  handToShow.forEach((card, i) => {
    const el = buildCard(card, false, false);
    el.style.setProperty('--i', i);
    rc.appendChild(el);
  });
  $('reveal-overlay').classList.remove('hidden');

  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    $('reveal-overlay').classList.add('hidden');
    showWinnerModal(state);
  }, 3000);
}

function showWinnerModal(state) {
  const won = state.winner === myName;
  const titleEl = $('winner-title');
  titleEl.textContent = won ? '🎉 You Win!' : `${state.winner} Wins! 😔`;
  titleEl.style.color = won ? '#FDD835' : (state.winner === 'Sizo' ? '#64B5F6' : '#F48FB1');
  $('reveal-hand').innerHTML = '';
  showModal('modal-winner');
  if (won) confetti();
  socket.emit('getLb');
}

// ── Reactions ───────────────────────────────────────────────────────────────
function toggleReactBar() { $('react-bar').classList.toggle('hidden'); }
function sendReaction(emoji) {
  socket.emit('react', { emoji });
  floatEmoji(emoji);
  $('react-bar').classList.add('hidden');
}
function floatEmoji(emoji) {
  const stage = $('reaction-stage');
  const e = document.createElement('div');
  e.className = 'float-emoji';
  e.textContent = emoji;
  e.style.left = (20 + Math.random() * 55) + '%';
  e.style.bottom = '30%';
  stage.appendChild(e);
  setTimeout(() => e.remove(), 2300);
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  clearTimeout(toastTimer);
  const bar = $('status-bar');
  bar.textContent = msg;
  toastTimer = setTimeout(() => { if (gameState) render(gameState, null); }, 2500);
}

// ── Leaderboard ───────────────────────────────────────────────────────────
function toggleLb() {
  const p = $('lb-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) socket.emit('getLb');
}
function renderLbPanel(data) {
  $('lb-content').innerHTML =
    lbSec('🏆 All Time', data.allTime) + lbSec('📅 Today', data.daily) + lbSec('📆 This Week', data.weekly);
}
function lbSec(title, data) {
  const sz = data['Sizo'] || 0, sn = data['Sinalo'] || 0;
  return `<div class="lb-section"><div class="lb-section-title">${title}</div>
      <div class="lb-row"><span class="lb-name sizo">Sizo</span><span class="lb-wins">${sz}</span></div>
      <div class="lb-row"><span class="lb-name sinalo">Sinalo</span><span class="lb-wins">${sn}</span></div></div>`;
}
function renderLbMini(data) {
  const el = $('lb-mini-wrap');
  if (!el) return;
  const at = data.allTime || {}, dy = data.daily || {}, wk = data.weekly || {};
  el.innerHTML = `
    <div class="lbm-row"><span>All Time</span><span class="lbm-scores">Sizo ${at['Sizo']||0} · Sinalo ${at['Sinalo']||0}</span></div>
    <div class="lbm-row"><span>Today</span><span class="lbm-scores">Sizo ${dy['Sizo']||0} · Sinalo ${dy['Sinalo']||0}</span></div>
    <div class="lbm-row"><span>This Week</span><span class="lbm-scores">Sizo ${wk['Sizo']||0} · Sinalo ${wk['Sinalo']||0}</span></div>`;
}

// ── Confetti ──────────────────────────────────────────────────────────────
function confetti() {
  const stage = $('confetti-stage');
  stage.innerHTML = '';
  const colors = ['#E53935','#1E88E5','#43A047','#FDD835','#D81B60','#FF9800'];
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('div');
    const sz = 5 + Math.random() * 9;
    p.style.cssText = `position:absolute;width:${sz}px;height:${sz}px;background:${colors[Math.floor(Math.random()*colors.length)]};left:${Math.random()*100}%;top:-10px;border-radius:${Math.random()>.5?'50%':'2px'};animation:cf-fall ${1.2+Math.random()*1.4}s ease-out forwards;animation-delay:${Math.random()*.6}s;`;
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
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  });
}

// ── Keep-alive ────────────────────────────────────────────────────────────
setInterval(() => socket.emit('ping'), 13 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────────────────
init();
