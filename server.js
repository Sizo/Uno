'use strict';
const express   = require('express');
const http      = require('http');
const { Server} = require('socket.io');
const path      = require('path');
const fs        = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:       { origin: '*' },
  transports: ['websocket', 'polling'],
  allowEIO3:  true,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Leaderboard ────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');

function loadScores() {
  try {
    if (fs.existsSync(SCORES_FILE))
      return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
  } catch {}
  return { allTime: {}, daily: {}, weekly: {} };
}
function saveScores(s) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCORES_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('score save error', e); }
}
function weekKey() {
  const n = new Date();
  const d = new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function recordWin(name) {
  const s     = loadScores();
  const today = new Date().toISOString().slice(0, 10);
  const week  = weekKey();
  s.allTime[name] = (s.allTime[name] || 0) + 1;
  if (!s.daily[today])  s.daily[today]  = {};
  if (!s.weekly[week])  s.weekly[week]  = {};
  s.daily[today][name]  = (s.daily[today][name]  || 0) + 1;
  s.weekly[week][name]  = (s.weekly[week][name]  || 0) + 1;
  saveScores(s);
}
function getLb() {
  const s     = loadScores();
  const today = new Date().toISOString().slice(0, 10);
  const week  = weekKey();
  return { allTime: s.allTime, daily: s.daily[today] || {}, weekly: s.weekly[week] || {} };
}

// ─── Deck ───────────────────────────────────────────────────────────────────
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];

function createDeck(rules = {}) {
  const d = [];
  COLORS.forEach(c => VALUES.forEach(v => {
    d.push({ color: c, value: v });
    if (v !== '0') d.push({ color: c, value: v });
  }));
  for (let i = 0; i < 4; i++) {
    d.push({ color: 'wild', value: 'wild' });
    d.push({ color: 'wild', value: 'wild4' });
  }
  if (rules.wildTrick)  for (let i = 0; i < 2; i++) d.push({ color: 'wild', value: 'wild3' });
  if (rules.wildPunch)  for (let i = 0; i < 2; i++) d.push({ color: 'wild', value: 'wild6' });
  return d;
}
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ─── Rooms ──────────────────────────────────────────────────────────────────
const rooms = {};
const mkId  = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function initGame(players, rules) {
  const deck = shuffle(createDeck(rules));
  const hands = {};
  players.forEach(p => { hands[p.name] = deck.splice(0, 7); });

  // First discard card must not be a wild
  let topCard; const temp = [];
  while (true) {
    topCard = deck.shift();
    if (topCard.color !== 'wild') break;
    temp.push(topCard);
  }
  deck.push(...shuffle(temp));

  return {
    deck,
    discard:          [topCard],
    hands,
    players:          players.map(p => p.name),
    sockets:          Object.fromEntries(players.map(p => [p.name, p.sid])),
    turn:             0,
    direction:        1,
    pendingDraw:      0,
    winner:           null,
    rules,
    draft:            null,
    challengePending: false,
    challengeData:    null,
    timers:           {},
    rematchVotes:     [],
  };
}

// Helpers
const topCard   = s => s.discard[s.discard.length - 1];
const effColor  = c => c.chosenColor || c.color;
const curPlayer = s => s.players[s.turn];
const nextIdx   = (s, skip = 0) => {
  const n = s.players.length;
  return ((s.turn + s.direction * (1 + skip)) % n + n) % n;
};
const advance   = (s, skip = 0) => { s.turn = nextIdx(s, skip); };

function canPlay(card, top, pendingDraw, rules) {
  if (pendingDraw > 0) {
    if (!rules.stack) return false;
    return ['draw2', 'wild3', 'wild4', 'wild6'].includes(card.value);
  }
  if (card.color === 'wild') return true;
  return card.color === effColor(top) || card.value === top.value;
}

function ensureDeck(s) {
  if (s.deck.length === 0) {
    const keep = s.discard.pop();
    s.deck     = shuffle(s.discard.map(({ chosenColor, ...r }) => r));
    s.discard  = [keep];
  }
}
function deal(s, name, n) {
  for (let i = 0; i < n; i++) {
    ensureDeck(s);
    if (s.deck.length) s.hands[name].push(s.deck.shift());
  }
}
function discardExtras(s, card, name) {
  if (!s.rules.discardAll && !s.rules.doubleDiscard) return;
  s.hands[name] = s.hands[name].filter(c => {
    if (s.rules.discardAll && c.value === card.value)                         { s.discard.push(c); return false; }
    if (s.rules.doubleDiscard && c.color === card.color && c.color !== 'wild'){ s.discard.push(c); return false; }
    return true;
  });
}

function clientView(s, name) {
  const opp = s.players.find(p => p !== name);
  const view = {
    myName:            name,
    myHand:            s.hands[name] || [],
    opponentName:      opp,
    opponentCardCount: opp ? (s.hands[opp] || []).length : 0,
    topCard:           topCard(s),
    currentPlayer:     curPlayer(s),
    isMyTurn:          curPlayer(s) === name,
    deckCount:         s.deck.length,
    winner:            s.winner,
    pendingDraw:       s.pendingDraw,
    rules:             s.rules,
    draft:             s.draft && curPlayer(s) === name ? s.draft : null,
    challengePending:  s.challengePending && curPlayer(s) === name,
    direction:         s.direction,
  };
  if (s.rules.sideToSide && opp) view.opponentHand = s.hands[opp];
  return view;
}

function broadcast(room) {
  room.state.players.forEach(name => {
    const sock = io.sockets.sockets.get(room.state.sockets[name]);
    if (sock) sock.emit('state', clientView(room.state, name));
  });
}

function clearTimer(s) {
  if (s.timers?.turn) { clearTimeout(s.timers.turn); s.timers.turn = null; }
}
function startTimer(room) {
  const s = room.state;
  if (!s.rules.timeBalloon || s.winner) return;
  clearTimer(s);
  s.timers.turn = setTimeout(() => {
    if (!s || s.winner) return;
    deal(s, curPlayer(s), 2);
    advance(s);
    broadcast(room);
    startTimer(room);
  }, 30000);
}

function checkWin(s, name, room) {
  if (s.hands[name].length === 0) {
    s.winner = name;
    clearTimer(s);
    recordWin(name);
    broadcast(room);
    io.to(room.id).emit('lb', getLb());
    return true;
  }
  return false;
}

// ─── Socket ──────────────────────────────────────────────────────────────────
io.on('connection', sock => {
  console.log('[+]', sock.id);

  sock.on('ping', () => sock.emit('pong'));

  // ── Room creation & joining ──────────────────────────────────────────────
  sock.on('getRoomInfo', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room)                    return sock.emit('roomInfo', { error: 'Room not found' });
    if (room.players.length >= 2) return sock.emit('roomInfo', { error: 'Room is full' });
    const taken = room.players.map(p => p.name);
    const avail = ['Sizo', 'Sinalo'].find(n => !taken.includes(n));
    sock.emit('roomInfo', { availableName: avail });
  });

  sock.on('createRoom', ({ playerName, rules }) => {
    const roomId = mkId();
    rooms[roomId] = {
      id:      roomId,
      players: [{ name: playerName, sid: sock.id }],
      rules:   rules || {},
      state:   null,
    };
    sock.join(roomId);
    sock.data.roomId     = roomId;
    sock.data.playerName = playerName;
    sock.emit('roomCreated', { roomId });
    console.log(`Room ${roomId} created by ${playerName}`);
  });

  sock.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room)                    return sock.emit('joinError', 'Room not found');
    if (room.players.length >= 2) return sock.emit('joinError', 'Room is full');
    if (room.players.find(p => p.name === playerName))
      return sock.emit('joinError', 'Name already taken');

    room.players.push({ name: playerName, sid: sock.id });
    sock.join(roomId);
    sock.data.roomId     = roomId;
    sock.data.playerName = playerName;
    sock.emit('joined', { playerName });

    room.state = initGame(room.players, room.rules);
    room.players.forEach(p => {
      const s = io.sockets.sockets.get(p.sid);
      if (s) s.emit('gameStarted');
    });
    broadcast(room);
    startTimer(room);
    console.log(`${room.id} → ${room.players.map(p => p.name).join(' vs ')}`);
  });

  // ── Gameplay ─────────────────────────────────────────────────────────────
  sock.on('playCard', ({ cardIdx, chosenColor }) => {
    const room = rooms[sock.data.roomId];
    if (!room?.state) return;
    const s = room.state;
    if (curPlayer(s) !== sock.data.playerName) return;
    if (s.draft !== null) return;

    const hand = s.hands[sock.data.playerName];
    const card = hand[cardIdx];
    if (!card) return;
    if (!canPlay(card, topCard(s), s.pendingDraw, s.rules)) return;

    hand.splice(cardIdx, 1);
    if (card.color === 'wild') card.chosenColor = chosenColor || 'red';

    // Snapshot for colorChallenge
    if (card.value === 'wild4' && s.rules.colorChallenge) {
      s.challengeData = { prevColor: effColor(topCard(s)), snap: [...hand] };
    }

    s.discard.push(card);
    discardExtras(s, card, sock.data.playerName);
    if (checkWin(s, sock.data.playerName, room)) return;

    let skip = 0;
    s.challengePending = false;

    switch (card.value) {
      case 'skip':
        skip = 1; break;
      case 'reverse':
        s.players.length === 2 ? (skip = 1) : (s.direction *= -1); break;
      case 'draw2':
        s.pendingDraw += 2; skip = 1; break;
      case 'wild3':
        s.pendingDraw += 3; skip = 1; break;
      case 'wild4':
        s.pendingDraw += 4; skip = 1;
        if (s.rules.colorChallenge) {
          advance(s, skip);
          s.challengePending = true;
          broadcast(room);
          startTimer(room);
          return;
        }
        break;
      case 'wild6':
        s.pendingDraw += 6; skip = 1; break;
      case '7':
        if (s.rules.sevenZero) {
          const opp = s.players.find(p => p !== sock.data.playerName);
          if (opp) {
            [s.hands[sock.data.playerName], s.hands[opp]] =
              [s.hands[opp], s.hands[sock.data.playerName]];
            io.to(room.id).emit('swapped');
          }
        }
        break;
      case '0':
        if (s.rules.sevenZero) {
          const opp = s.players.find(p => p !== sock.data.playerName);
          if (opp) {
            [s.hands[sock.data.playerName], s.hands[opp]] =
              [s.hands[opp], s.hands[sock.data.playerName]];
            io.to(room.id).emit('swapped');
          }
        }
        break;
    }

    advance(s, skip);
    broadcast(room);
    clearTimer(s);
    startTimer(room);
  });

  sock.on('drawCard', () => {
    const room = rooms[sock.data.roomId];
    if (!room?.state) return;
    const s = room.state;
    if (curPlayer(s) !== sock.data.playerName) return;
    if (s.challengePending) return;

    const n = s.pendingDraw > 0 ? s.pendingDraw : 1;
    s.pendingDraw = 0;

    if (s.rules.openDraft && n === 1 && !s.draft) {
      ensureDeck(s);
      if (s.deck.length) { s.draft = s.deck.shift(); broadcast(room); }
      return;
    }

    deal(s, sock.data.playerName, n);
    advance(s);
    broadcast(room);
    clearTimer(s);
    startTimer(room);
  });

  sock.on('draftDecide', ({ play, chosenColor }) => {
    const room = rooms[sock.data.roomId];
    if (!room?.state) return;
    const s = room.state;
    if (curPlayer(s) !== sock.data.playerName || !s.draft) return;

    const card     = s.draft;
    s.draft        = null;
    const playable = canPlay(card, topCard(s), 0, s.rules);
    const mustPlay = s.rules.forcedPlay && playable;

    if ((play && playable) || mustPlay) {
      if (card.color === 'wild') card.chosenColor = chosenColor || 'red';
      s.discard.push(card);
      discardExtras(s, card, sock.data.playerName);
      if (checkWin(s, sock.data.playerName, room)) return;
      let skip = 0;
      if      (card.value === 'skip')    skip = 1;
      else if (card.value === 'reverse') s.players.length === 2 ? (skip = 1) : (s.direction *= -1);
      else if (card.value === 'draw2')  { s.pendingDraw += 2; skip = 1; }
      else if (card.value === 'wild4')  { s.pendingDraw += 4; skip = 1; }
      advance(s, skip);
    } else {
      s.hands[sock.data.playerName].push(card);
      advance(s);
    }

    broadcast(room);
    clearTimer(s);
    startTimer(room);
  });

  sock.on('jumpIn', ({ cardIdx }) => {
    const room = rooms[sock.data.roomId];
    if (!room?.state || !room.state.rules.jumpIn) return;
    const s    = room.state;
    const hand = s.hands[sock.data.playerName];
    const card = hand[cardIdx];
    if (!card) return;
    const t = topCard(s);
    if (card.color === 'wild' || card.color !== effColor(t) || card.value !== t.value) return;

    hand.splice(cardIdx, 1);
    s.discard.push(card);
    discardExtras(s, card, sock.data.playerName);
    if (checkWin(s, sock.data.playerName, room)) return;

    s.turn = s.players.indexOf(sock.data.playerName);
    advance(s);
    broadcast(room);
    clearTimer(s);
    startTimer(room);
  });

  sock.on('challenge', () => {
    const room = rooms[sock.data.roomId];
    if (!room?.state || !room.state.challengePending) return;
    const s = room.state;
    if (curPlayer(s) !== sock.data.playerName) return;

    const { prevColor, snap } = s.challengeData;
    const wild4Player = s.players.find(p => p !== sock.data.playerName);
    const bluff       = snap.some(c => c.color === prevColor);

    s.challengePending = false;
    s.challengeData    = null;
    s.pendingDraw      = 0;

    if (bluff) {
      deal(s, wild4Player, 4);
      // challenger keeps their turn — already advanced
    } else {
      deal(s, sock.data.playerName, 6);
      advance(s);
    }

    broadcast(room);
    startTimer(room);
  });

  sock.on('declineChallenge', () => {
    const room = rooms[sock.data.roomId];
    if (!room?.state || !room.state.challengePending) return;
    const s = room.state;
    if (curPlayer(s) !== sock.data.playerName) return;

    deal(s, sock.data.playerName, s.pendingDraw);
    s.pendingDraw      = 0;
    s.challengePending = false;
    s.challengeData    = null;
    advance(s);
    broadcast(room);
    startTimer(room);
  });

  sock.on('rematch', () => {
    const room = rooms[sock.data.roomId];
    if (!room?.state) return;
    if (!room.state.rematchVotes) room.state.rematchVotes = [];
    if (room.state.rematchVotes.includes(sock.data.playerName)) return;
    room.state.rematchVotes.push(sock.data.playerName);

    if (room.state.rematchVotes.length >= room.players.length) {
      clearTimer(room.state);
      room.state = initGame(room.players, room.rules);
      room.players.forEach(p => {
        const s = io.sockets.sockets.get(p.sid);
        if (s) s.emit('gameStarted');
      });
      broadcast(room);
      startTimer(room);
    } else {
      // Notify other player someone voted for rematch
      io.to(room.id).emit('rematchVote', { player: sock.data.playerName });
    }
  });

  sock.on('getLb', () => sock.emit('lb', getLb()));

  sock.on('disconnect', () => {
    console.log('[-]', sock.id);
    const room = rooms[sock.data?.roomId];
    if (!room) return;
    if (room.state) clearTimer(room.state);
    const other = room.players.find(p => p.name !== sock.data.playerName);
    if (other) {
      const os = io.sockets.sockets.get(other.sid);
      if (os) os.emit('oppLeft');
    }
    delete rooms[sock.data.roomId];
  });
});

// Keep-alive for Render.com free tier (set APP_URL env var to your app URL)
if (process.env.APP_URL) {
  setInterval(() => {
    require('https').get(process.env.APP_URL, () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO ready → http://localhost:${PORT}`));
