import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { nanoid } from 'nanoid';
import type { ServerRoom, ServerPlayer, WinResult } from '../src/types/index.js';
import {
  validateName, validateRole, validateCoordinates, validateVelocity,
  validateRoomId, validateTeamCode, validateAbility, validatePowerUpStates,
  checkRateLimit, cleanupRateLimits,
} from './validation.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const MATCH_DURATION_S = 90;
const DEFAULT_TEAM_SIZE = 2;

// ── Bot name pool ─────────────────────────────────────────────────────────────

const BOT_NAMES = [
  'GHOST','WRAITH','CIPHER','NEXUS','VOLT','ECHO','FLUX','NOVA',
  'ROGUE','SPECTER','DRIFT','VIPER','AXON','BOLT','HAZE','KITE',
];

const BOT_COLORS = [
  '#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c77dff',
  '#ff9f1c','#2ec4b6','#e71d36',
];

function makeBotPlayer(role: 'ESCAPER' | 'ATTACKER', idx: number): ServerPlayer {
  return {
    id: `bot-${nanoid(6)}`,
    name: BOT_NAMES[idx % BOT_NAMES.length] ?? `BOT${idx}`,
    role,
    x: 400,
    y: 800,
    vx: 0,
    isBot: true,
    isMuted: true,
    isSpeaking: false,
    color: BOT_COLORS[idx % BOT_COLORS.length] ?? '#ffffff',
    isDefeated: false,
    isSpectating: false,
    isShielded: false,
    isFiring: false,
    isHidden: false,
  };
}

// ── Matchmaking queue ─────────────────────────────────────────────────────────

interface QueueEntry {
  socketId: string;
  name: string;
  role: 'ESCAPER' | 'ATTACKER';
  teamSize: number;
  joinedAt: number;
}

const escaperQueue: QueueEntry[] = [];
const attackerQueue: QueueEntry[] = [];

// ── Room store ────────────────────────────────────────────────────────────────

const rooms = new Map<string, ServerRoom>();
const playerEnergy = new Map<string, number>();

// ── Player→room index ─────────────────────────────────────────────────────────

const playerRoom = new Map<string, string>();

// ── Score anti-cheat ──────────────────────────────────────────────────────────
const playerScoreHistory = new Map<string, { lastScore: number; lastTime: number }>();

// ── Bot movement validation ───────────────────────────────────────────────────
const botLastPos = new Map<string, { x: number; y: number }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRoomPlayers(room: ServerRoom): ServerPlayer[] {
  return Array.from(room.players.values());
}

function broadcastRoomUpdate(io: Server, room: ServerRoom) {
  io.to(room.id).emit('room-update', {
    players: getRoomPlayers(room),
    gamePhase: room.gamePhase,
  });
}

// Only escapers who are ACTIVELY PLAYING count for win/lose
// Spectating = eliminated, just watching — do NOT count
function getActiveEscapers(room: ServerRoom): ServerPlayer[] {
  return getRoomPlayers(room).filter(p => p.role === 'ESCAPER' && !p.isDefeated && !p.isSpectating);
}

function getHostId(room: ServerRoom): string | null {
  const realPlayers = [...room.players.values()].filter(p => !p.isBot).sort((a, b) => a.id.localeCompare(b.id));
  return realPlayers[0]?.id ?? null;
}

function endRoom(io: Server, room: ServerRoom, result: WinResult) {
  if (room.gamePhase === 'GAMEOVER') return;
  room.gamePhase = 'GAMEOVER';
  if (room.gameTimer) clearInterval(room.gameTimer);
  const scores: Record<string, number> = {};
  room.scores.forEach((v, k) => { scores[k] = v; });
  io.to(room.id).emit('game-end', { result, scores });
}

// Pure luck — no formulas, no patterns, no guarantees.
// Every elimination rolls the dice fresh. Sometimes generous, sometimes cruel.
function spawnRecallAsset(io: Server, room: ServerRoom, eliminatedId: string) {
  // Roll how many tokens to drop: pure random
  // ~30% chance = 0 tokens (nothing, tough luck)
  // ~35% chance = 1 token
  // ~20% chance = 2 tokens
  // ~10% chance = 3 tokens
  // ~5%  chance = 4+ tokens (rare jackpot)
  const roll = Math.random();
  let tokenCount: number;
  if (roll < 0.30)      tokenCount = 0;  // no recall — sometimes life is unfair
  else if (roll < 0.65) tokenCount = 1;
  else if (roll < 0.85) tokenCount = 2;
  else if (roll < 0.95) tokenCount = 3;
  else                  tokenCount = 3 + Math.floor(Math.random() * 3); // 3-5 tokens

  if (tokenCount === 0) return; // nothing drops. pure luck.

  // Drop each token at a random delay — unpredictable timing
  for (let i = 0; i < tokenCount; i++) {
    const delay = Math.random() * 15000; // anywhere from instant to 15 seconds later
    setTimeout(() => {
      if (room.gamePhase === 'GAMEOVER') return; // game already ended
      const id = 'recall-' + eliminatedId.slice(0, 6) + '-' + i + '-' + Math.floor(Math.random() * 9999);
      const x = 0.08 + Math.random() * 0.84;
      room.pendingRecalls.set(id, eliminatedId);
      io.to(room.id).emit('recall-asset-spawned', { id, x, recallTargetId: eliminatedId });
    }, delay);
  }
}

function tryMatchmaking(io: Server) {
  // Fill with bots if needed — allow match with just 1 real player per side
  // but wait up to 15 seconds for more
  const now = Date.now();

  const readyEscapers = escaperQueue.filter(e => (now - e.joinedAt) >= 0);
  const readyAttackers = attackerQueue.filter(e => (now - e.joinedAt) >= 0);

  // Determine how many real players we have
  const realEscapers = readyEscapers.length;
  const realAttackers = readyAttackers.length;

  // Need at least 1 real player from each side, or 1 total if they've waited 15s
  const anyWaited15s = [...readyEscapers, ...readyAttackers].some(e => (now - e.joinedAt) >= 15000);
  const canFill = (realEscapers >= 1 && realAttackers >= 1) || anyWaited15s;

  if (!canFill) return;

  // Use the most-requested team size (mode of the queue entries, default 2)
  const allSizes = [...readyEscapers, ...readyAttackers].map(e => e.teamSize);
  const sizeCount = allSizes.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {} as Record<number, number>);
  const teamSize = parseInt(Object.entries(sizeCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '2', 10);

  const roomId = 'match-' + nanoid(6);
  const seed = Math.floor(Math.random() * 999999);

  const room: ServerRoom = {
    id: roomId,
    mode: 'ONLINE',
    teamSize,
    players: new Map(),
    gamePhase: 'WAITING',
    seed,
    startTime: 0,
    remainingSeconds: MATCH_DURATION_S,
    scores: new Map(),
    eliminatedEscapers: new Set(),
    pendingRecalls: new Map(),
  };

  // Take up to teamSize real players per role
  const takenEscapers = escaperQueue.splice(0, Math.min(teamSize, escaperQueue.length));
  const takenAttackers = attackerQueue.splice(0, Math.min(teamSize, attackerQueue.length));

  let botEscIdx = 0;
  let botAtkIdx = 0;

  // Add real escapers
  takenEscapers.forEach(entry => {
    const pSocket = io.sockets.sockets.get(entry.socketId);
    if (!pSocket) return;
    const p: ServerPlayer = {
      id: entry.socketId, name: entry.name, role: 'ESCAPER',
      x: 400, y: 800, vx: 0,
      isBot: false, isMuted: false, isSpeaking: false,
      color: BOT_COLORS[botEscIdx % BOT_COLORS.length],
      isDefeated: false, isSpectating: false, isShielded: false, isFiring: false, isHidden: false,
    };
    room.players.set(entry.socketId, p);
    room.scores.set(entry.socketId, 0);
    playerRoom.set(entry.socketId, roomId);
    pSocket.join(roomId);
    botEscIdx++;
  });

  // Fill escaper slots with bots
  while ([...room.players.values()].filter(p => p.role === 'ESCAPER').length < teamSize) {
    const bot = makeBotPlayer('ESCAPER', botEscIdx++);
    room.players.set(bot.id, bot);
  }

  // Add real attackers
  takenAttackers.forEach(entry => {
    const pSocket = io.sockets.sockets.get(entry.socketId);
    if (!pSocket) return;
    const p: ServerPlayer = {
      id: entry.socketId, name: entry.name, role: 'ATTACKER',
      x: 400, y: 50, vx: 0,
      isBot: false, isMuted: false, isSpeaking: false,
      color: BOT_COLORS[botAtkIdx % BOT_COLORS.length],
      isDefeated: false, isSpectating: false, isShielded: false, isFiring: false, isHidden: false,
    };
    room.players.set(entry.socketId, p);
    room.scores.set(entry.socketId, 0);
    playerRoom.set(entry.socketId, roomId);
    pSocket.join(roomId);
    botAtkIdx++;
  });

  // Fill attacker slots with bots
  while ([...room.players.values()].filter(p => p.role === 'ATTACKER').length < teamSize) {
    const bot = makeBotPlayer('ATTACKER', botAtkIdx++);
    room.players.set(bot.id, bot);
  }

  rooms.set(roomId, room);

  // Notify each real player
  takenEscapers.forEach(entry => {
    const s = io.sockets.sockets.get(entry.socketId);
    s?.emit('match-found', { roomId, role: 'ESCAPER', teamSize });
  });
  takenAttackers.forEach(entry => {
    const s = io.sockets.sockets.get(entry.socketId);
    s?.emit('match-found', { roomId, role: 'ATTACKER', teamSize });
  });

  broadcastRoomUpdate(io, room);
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

async function main() {
  const app = express();
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [
        'http://localhost:3000',
        'http://localhost:5173',
        'https://velocity1-1.onrender.com',
        'https://neon-velocity.vercel.app',
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 10000,
  });

  // ── Static files in production ─────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    const dist = path.join(process.cwd(), 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // In dev, Vite handles the frontend
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  // ── Socket.IO events ───────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    console.log('[+]', socket.id);

    // ── Offline room ────────────────────────────────────────────────────────
    socket.on('join-offline', (data: { name: string; role: 'ESCAPER' | 'ATTACKER' }) => {
      if (!checkRateLimit(socket.id, 'join-offline', 2)) return;
      const name = validateName(data?.name);
      const role = validateRole(data?.role);
      const roomId = 'offline-' + socket.id;
      const room: ServerRoom = {
        id: roomId, mode: 'OFFLINE', teamSize: 1,
        players: new Map(), gamePhase: 'PLAYING',
        seed: Math.floor(Math.random() * 999999), startTime: Date.now(),
        remainingSeconds: role === 'ATTACKER' ? 60 : 0,
        scores: new Map(), eliminatedEscapers: new Set(), pendingRecalls: new Map(),
      };
      const p: ServerPlayer = {
        id: socket.id, name, role,
        x: 400, y: 800, vx: 0,
        isBot: false, isMuted: false, isSpeaking: false,
        color: '#00ff88', isDefeated: false, isSpectating: false,
        isShielded: false, isFiring: false, isHidden: false,
      };
      room.players.set(socket.id, p);
      room.scores.set(socket.id, 0);
      rooms.set(roomId, room);
      playerRoom.set(socket.id, roomId);
      socket.join(roomId);
      socket.emit('room-joined', { roomId, role, players: getRoomPlayers(room) });
      socket.emit('game-start', { roomId, seed: room.seed });
    });

    // ── Matchmaking ─────────────────────────────────────────────────────────
    socket.on('join-matchmaking', (data: { name: string; role: 'ESCAPER' | 'ATTACKER'; teamSize?: number }) => {
      if (!checkRateLimit(socket.id, 'join-matchmaking', 2)) return;
      const name = validateName(data?.name);
      const role = validateRole(data?.role);
      const teamSize = [1, 2, 3, 4].includes(data?.teamSize ?? 0) ? (data.teamSize as number) : DEFAULT_TEAM_SIZE;
      // Remove any existing entry for this socket
      const escIdx = escaperQueue.findIndex(e => e.socketId === socket.id);
      if (escIdx !== -1) escaperQueue.splice(escIdx, 1);
      const atkIdx = attackerQueue.findIndex(e => e.socketId === socket.id);
      if (atkIdx !== -1) attackerQueue.splice(atkIdx, 1);

      const entry: QueueEntry = { socketId: socket.id, name, role, teamSize, joinedAt: Date.now() };
      if (role === 'ESCAPER') escaperQueue.push(entry);
      else attackerQueue.push(entry);

      tryMatchmaking(io);
    });

    socket.on('cancel-matchmaking', () => {
      const escIdx = escaperQueue.findIndex(e => e.socketId === socket.id);
      if (escIdx !== -1) escaperQueue.splice(escIdx, 1);
      const atkIdx = attackerQueue.findIndex(e => e.socketId === socket.id);
      if (atkIdx !== -1) attackerQueue.splice(atkIdx, 1);
    });

    // ── Local room creation ─────────────────────────────────────────────────
    socket.on('create-local-room', (data: { name: string; role: 'ESCAPER' | 'ATTACKER'; teamSize?: number }) => {
      if (!checkRateLimit(socket.id, 'create-local-room', 2)) return;
      const name = validateName(data?.name);
      const role = validateRole(data?.role);
      const teamSize = [1, 2, 3, 4].includes(data?.teamSize ?? 0) ? (data.teamSize as number) : DEFAULT_TEAM_SIZE;
      const roomId = 'local-' + nanoid(5);
      const escaperCode = 'ESC-' + nanoid(4).toUpperCase();
      const attackerCode = 'ATK-' + nanoid(4).toUpperCase();

      const room: ServerRoom = {
        id: roomId, mode: 'LOCAL', teamSize,
        players: new Map(), gamePhase: 'WAITING',
        seed: Math.floor(Math.random() * 999999), startTime: 0,
        escaperCode, attackerCode,
        remainingSeconds: MATCH_DURATION_S,
        scores: new Map(), eliminatedEscapers: new Set(), pendingRecalls: new Map(),
      };

      const creator: ServerPlayer = {
        id: socket.id, name, role,
        x: 400, y: role === 'ESCAPER' ? 800 : 50, vx: 0,
        isBot: false, isMuted: false, isSpeaking: false,
        color: role === 'ESCAPER' ? '#00ff88' : '#ff0055',
        isDefeated: false, isSpectating: false, isShielded: false, isFiring: false, isHidden: false,
      };
      room.players.set(socket.id, creator);
      room.scores.set(socket.id, 0);

      // LOCAL mode: NO bots — players invite friends via codes
      // Slots stay open for real players to join

      rooms.set(roomId, room);
      playerRoom.set(socket.id, roomId);
      socket.join(roomId);

      socket.emit('local-room-created', { roomId, escaperCode, attackerCode });
      socket.emit('room-joined', { roomId, role, players: getRoomPlayers(room), teamSize });
      broadcastRoomUpdate(io, room);
    });

    // ── Join local room via code ─────────────────────────────────────────────
    socket.on('join-local-room', (data: { teamCode: string; name: string }) => {
      if (!checkRateLimit(socket.id, 'join-local-room', 3)) return;
      const name = validateName(data?.name);
      const teamCode = validateTeamCode(data?.teamCode);
      if (!teamCode) {
        socket.emit('error', { message: 'Invalid team code format.' });
        return;
      }

      let foundRoom: ServerRoom | null = null;
      let role: 'ESCAPER' | 'ATTACKER' = 'ESCAPER';

      for (const [, room] of rooms) {
        if (room.mode !== 'LOCAL') continue;
        if (room.escaperCode === teamCode) { foundRoom = room; role = 'ESCAPER'; break; }
        if (room.attackerCode === teamCode) { foundRoom = room; role = 'ATTACKER'; break; }
      }

      if (!foundRoom) {
        socket.emit('error', { message: 'Invalid team code. Check with your room host.' });
        return;
      }

      if (foundRoom.gamePhase !== 'WAITING') {
        socket.emit('error', { message: 'That match has already started.' });
        return;
      }

      // Enforce max players per team using the room's actual teamSize
      const teamCount = getRoomPlayers(foundRoom).filter(p => p.role === role && !p.isBot).length;
      if (teamCount >= foundRoom.teamSize) {
        socket.emit('error', { message: `Team ${role} is full.` });
        return;
      }

      const p: ServerPlayer = {
        id: socket.id, name, role,
        x: 400, y: role === 'ESCAPER' ? 800 : 50, vx: 0,
        isBot: false, isMuted: false, isSpeaking: false,
        color: BOT_COLORS[foundRoom.players.size % BOT_COLORS.length],
        isDefeated: false, isSpectating: false, isShielded: false, isFiring: false, isHidden: false,
      };

      // LOCAL mode has no bots — just add the real player directly

      foundRoom.players.set(socket.id, p);
      foundRoom.scores.set(socket.id, 0);
      playerRoom.set(socket.id, foundRoom.id);
      socket.join(foundRoom.id);

      socket.emit('room-joined', { roomId: foundRoom.id, role, players: getRoomPlayers(foundRoom), teamSize: foundRoom.teamSize });
      broadcastRoomUpdate(io, foundRoom);
    });

    // ── Player ready / start ────────────────────────────────────────────────
    socket.on('player-ready', (data: { roomId: string }) => {
      if (!checkRateLimit(socket.id, 'player-ready', 2)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'WAITING') return;

      // For local/online rooms, host can start whenever
      const p = room.players.get(socket.id);
      if (!p) return;

      room.gamePhase = 'PLAYING';
      room.startTime = Date.now();

      // Start server-side game timer (online/local only)
      if (room.mode !== 'OFFLINE') {
        room.gameTimer = setInterval(() => {
          room.remainingSeconds--;
          io.to(room.id).emit('timer-tick', { seconds: room.remainingSeconds });

          // Regen attacker energy server-side
          for (const [pid, pl] of room.players) {
            if (pl.role === 'ATTACKER' && !pl.isBot) {
              const cur = playerEnergy.get(pid) ?? 20;
              playerEnergy.set(pid, Math.min(100, cur + 0.12 * 60)); // ~7.2 per tick (1s)
            }
          }

          if (room.remainingSeconds <= 0) {
            clearInterval(room.gameTimer!);
            // ESCAPERS WIN if at least one is actively playing when timer ends
            // Spectating players are NOT counted — they are eliminated, just watching
            const active = getActiveEscapers(room);
            endRoom(io, room, active.length >= 1 ? 'ESCAPERS_WIN' : 'ATTACKERS_WIN');
          }
        }, 1000);
      }

      io.to(roomId).emit('game-start', { roomId, seed: room.seed });
    });

    // ── Player movement ─────────────────────────────────────────────────────
    socket.on('player-move', (data: {
      roomId: string;
      x: number; y: number; vx: number; vy: number;
      powerUpStates: { isShielded: boolean; isFiring: boolean; isHidden: boolean };
    }) => {
      // Rate limit: ~20 updates/second max
      if (!checkRateLimit(socket.id, 'player-move', 25)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room
      const p = room.players.get(socket.id);
      if (!p) return;

      // Validate normalized coordinates (0-1 range)
      const coords = validateCoordinates(data?.x, data?.y, 1.1, 1.1);
      if (!coords) return;
      const vel = validateVelocity(data?.vx, data?.vy);
      if (!vel) return;
      const powerUpStates = validatePowerUpStates(data?.powerUpStates);

      p.x = coords.x; p.y = coords.y; p.vx = vel.vx;
      p.isShielded = powerUpStates.isShielded;
      p.isFiring   = powerUpStates.isFiring;
      p.isHidden   = powerUpStates.isHidden;

      // Broadcast normalized coords to everyone else — each client denormalizes locally
      socket.to(roomId).emit('player-moved', {
        id: socket.id, nx: coords.x, ny: coords.y, vx: vel.vx, vy: vel.vy,
        isShielded: p.isShielded, isFiring: p.isFiring, isHidden: p.isHidden,
      });
    });

    // ── Bot movement (handled by host client) ───────────────────────────────
    socket.on('bot-move', (data: {
      roomId: string; botId: string;
      x: number; y: number; vx: number; vy: number;
    }) => {
      // Light rate limit since host sends for multiple bots
      if (!checkRateLimit(socket.id, 'bot-move', 100)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      // Only the host client can control bots
      const hostIdBotMove = getHostId(room);
      if (socket.id !== hostIdBotMove) return;

      const bot = room.players.get(data.botId);
      if (!bot || !bot.isBot) return;

      const coords = validateCoordinates(data?.x, data?.y, 1.1, 1.1);
      if (!coords) return;
      const vel = validateVelocity(data?.vx, data?.vy);
      if (!vel) return;

      // Bot movement speed validation — cap at 0.1 normalized per update
      const lastPos = botLastPos.get(data.botId);
      let finalX = coords.x;
      let finalY = coords.y;
      if (lastPos) {
        const dx = coords.x - lastPos.x;
        const dy = coords.y - lastPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.1) {
          // Teleport detected — use last known position instead
          finalX = lastPos.x;
          finalY = lastPos.y;
        }
      }
      botLastPos.set(data.botId, { x: finalX, y: finalY });

      bot.x = finalX; bot.y = finalY; bot.vx = vel.vx;
      // Broadcast normalized bot coords
      socket.to(roomId).emit('player-moved', {
        id: bot.id, nx: finalX, ny: finalY, vx: vel.vx, vy: vel.vy,
        isShielded: bot.isShielded, isFiring: bot.isFiring, isHidden: bot.isHidden,
      });
    });

    // ── Attacker drops obstacle ─────────────────────────────────────────────
    socket.on('drop-attack', (data: { roomId: string; x: number }) => {
      // Rate limit: max 10 drops per second
      if (!checkRateLimit(socket.id, 'drop-attack', 10)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room
      const p = room.players.get(socket.id);
      if (!p || p.role !== 'ATTACKER') return;
      // Server-side energy check
      const dropEnergy = playerEnergy.get(socket.id) ?? 20;
      if (dropEnergy < 5) return; // Not enough energy
      playerEnergy.set(socket.id, dropEnergy - 5);

      // Normalize the drop X position (0-1 range)
      const rawX = typeof data?.x === 'number' && isFinite(data.x)
        ? Math.max(0, Math.min(data.x, 1)) : 0.5;

      // Broadcast normalized obstacle — each client scales to local size
      const obs = {
        id: nanoid(8),
        x: rawX - 0.025,   // normalized width offset
        y: -0.05,           // start above screen
        width: 0.05,        // 5% of screen width
        height: 0.036,      // proportional height
        color: '#ff0055',
        type: 'BLOCK' as const,
        vx: 0,
        nearMissTriggered: false,
        spawnedBy: socket.id,
      };
      io.to(roomId).emit('attack-dropped', { obstacle: obs });
    });

    // ── Bot drops obstacle (handled by host client) ─────────────────────────
    socket.on('bot-drop', (data: { roomId: string; botId: string; x: number }) => {
      if (!checkRateLimit(socket.id, 'bot-drop', 40)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      // Only the host client can control bots
      const hostIdBotDrop = getHostId(room);
      if (socket.id !== hostIdBotDrop) return;
      
      const bot = room.players.get(data.botId);
      if (!bot || !bot.isBot || bot.role !== 'ATTACKER') return;

      // Normalized x — clamped to [0.02, 0.98] for bot drops
      const rawX = typeof data?.x === 'number' && isFinite(data.x)
        ? Math.max(0.02, Math.min(data.x, 0.98)) : 0.5;

      const obs = {
        id: nanoid(8),
        x: rawX - 0.025,
        y: -0.05,
        width: 0.05,
        height: 0.036,
        color: '#ff0055',
        type: 'BLOCK' as const,
        vx: 0,
        nearMissTriggered: false,
        spawnedBy: bot.id,
      };
      io.to(roomId).emit('attack-dropped', { obstacle: obs });
    });

    // ── Attacker uses ability ───────────────────────────────────────────────
    socket.on('use-ability', (data: { roomId: string; ability: 'SWARM' | 'EMP' | 'FIREWALL' }) => {
      if (!checkRateLimit(socket.id, 'use-ability', 3)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const ability = validateAbility(data?.ability);
      if (!ability) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room
      const p = room.players.get(socket.id);
      if (!p || p.role !== 'ATTACKER') return;
      // Server-side energy check for abilities
      const ABILITY_ENERGY_COST: Record<string, number> = { SWARM: 22, EMP: 40, FIREWALL: 65 };
      const abilityCost = ABILITY_ENERGY_COST[ability] ?? 100;
      const abilityEnergy = playerEnergy.get(socket.id) ?? 20;
      if (abilityEnergy < abilityCost) return;
      playerEnergy.set(socket.id, abilityEnergy - abilityCost);

      io.to(roomId).emit('ability-used', { ability, fromId: socket.id });
    });

    // ── Escaper eliminated ──────────────────────────────────────────────────
    socket.on('game-over-report', (data: { roomId: string; escaperId: string }) => {
      if (!checkRateLimit(socket.id, 'game-over-report', 5)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room

      const escaperId = typeof data?.escaperId === 'string' ? data.escaperId : null;
      if (!escaperId) return;

      const p = room.players.get(escaperId);
      if (p && p.role === 'ESCAPER' && !p.isDefeated) {
        p.isDefeated = true;
        p.isSpectating = true; // enter spectate — watch only, not counted for win
        room.eliminatedEscapers.add(escaperId);

        // Recall asset — spawn only when team has teammates to pick it up (not 1v1)
        if (room.teamSize > 1) {
          spawnRecallAsset(io, room, escaperId);
        }

        const active = getActiveEscapers(room);
        io.to(roomId).emit('escaper-eliminated', { escaperId, remaining: active.length });

        // Award attacker score — find which attacker(s) are in the room
        for (const [pid, pl] of room.players) {
          if (pl.role === 'ATTACKER' && !pl.isBot) {
            io.to(pid).emit('attacker-scored', { points: 1200 });
          }
        }

        // Attackers win only when ZERO active escapers remain
        if (active.length === 0) {
          endRoom(io, room, 'ATTACKERS_WIN');
        }
      }
    });

    socket.on('recall-teammate', (data: { roomId: string; recallTargetId: string }) => {
      if (!checkRateLimit(socket.id, 'recall-teammate', 5)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || room.gamePhase !== 'PLAYING') return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room

      const recallTargetId = typeof data?.recallTargetId === 'string' ? data.recallTargetId : null;
      if (!recallTargetId) return;

      const target = room.players.get(recallTargetId);
      // Recall any spectating escaper — real or bot
      if (target && target.role === 'ESCAPER' && target.isSpectating) {
        target.isDefeated = false;
        target.isSpectating = false; // back to active play — counts again for win
        room.eliminatedEscapers.delete(recallTargetId);
        for (const [assetId, tid] of room.pendingRecalls) {
          if (tid === recallTargetId) { room.pendingRecalls.delete(assetId); break; }
        }
        io.to(roomId).emit('escaper-recalled', { escaperId: recallTargetId });
      }
    });

    // ── Score update ────────────────────────────────────────────────────────
    // NOTE: Client-submitted scores are logged but NOT trusted.
    // Server should calculate scores authoritatively in future phases.
    socket.on('score-update', (data: { roomId: string; score: number }) => {
      if (!checkRateLimit(socket.id, 'score-update', 3)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      const score = typeof data?.score === 'number' && isFinite(data.score)
        ? Math.max(0, Math.min(data.score, 500_000)) : 0;

      // Score anti-cheat validation
      const now = Date.now();
      const history = playerScoreHistory.get(socket.id);
      if (history) {
        const scoreDelta = score - history.lastScore;
        const timeDelta = now - history.lastTime;
        if (scoreDelta > 5000 && timeDelta < 1000) {
          console.warn(`[ANTI-CHEAT] ${socket.id} score spike: +${scoreDelta} in ${timeDelta}ms — rejected`);
          return; // reject suspicious score update
        }
      }
      playerScoreHistory.set(socket.id, { lastScore: score, lastTime: now });

      room.scores.set(socket.id, score);
    });

    // ── Voice chat ──────────────────────────────────────────────────────────
    socket.on('voice-signal', (data: { roomId: string; to: string; signal: unknown }) => {
      if (!checkRateLimit(socket.id, 'voice-signal', 30)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room
      const to = typeof data?.to === 'string' ? data.to : null;
      if (!to || !room.players.has(to)) return;
      // Cap signal payload size to prevent DoS
      const signalStr = JSON.stringify(data.signal ?? null);
      if (signalStr.length > 8192) return;
      io.to(to).emit('voice-signal', { from: socket.id, signal: data.signal });
    });

    socket.on('voice-state', (data: { roomId: string; isMuted: boolean; isSpeaking: boolean }) => {
      if (!checkRateLimit(socket.id, 'voice-state', 5)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      if (playerRoom.get(socket.id) !== roomId) return; // Not in this room
      const p = room.players.get(socket.id);
      if (p) {
        p.isMuted = data?.isMuted === true;
        p.isSpeaking = data?.isSpeaking === true;
        broadcastRoomUpdate(io, room!);
      }
    });

    // ── Leave room ──────────────────────────────────────────────────────────
    socket.on('leave-room', (data: { roomId: string }) => {
      if (!checkRateLimit(socket.id, 'leave-room', 3)) return;
      const roomId = validateRoomId(data?.roomId);
      if (!roomId) return;
      handleLeave(io, socket, roomId);
    });

    // ── Disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log('[-]', socket.id);
      const roomId = playerRoom.get(socket.id);
      if (roomId) handleLeave(io, socket, roomId);

      // Remove from matchmaking queue
      const ei = escaperQueue.findIndex(e => e.socketId === socket.id);
      if (ei !== -1) escaperQueue.splice(ei, 1);
      const ai = attackerQueue.findIndex(e => e.socketId === socket.id);
      if (ai !== -1) attackerQueue.splice(ai, 1);

      // Cleanup rate limit entries, energy, and score history
      cleanupRateLimits(socket.id);
      playerEnergy.delete(socket.id);
      playerScoreHistory.delete(socket.id);
    });
  });

  // ── Periodic matchmaking check (every 5s) ─────────────────────────────────
  setInterval(() => tryMatchmaking(io), 5000);

  // ── Room garbage collection (every 60s) ────────────────────────────────────
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      const isStale = room.gamePhase === 'GAMEOVER' && (now - room.startTime > 300_000);
      const isEmpty = room.players.size === 0;
      const isAbandoned = room.startTime > 0 && (now - room.startTime > 600_000);
      if (isStale || isEmpty || isAbandoned) {
        if (room.gameTimer) clearInterval(room.gameTimer);
        rooms.delete(id);
        console.log(`[GC] Cleaned up room ${id}`);
      }
    }
  }, 60_000);

  // ── Start ──────────────────────────────────────────────────────────────────
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Neon Velocity server → http://localhost:${PORT}`);
  });
}

function handleLeave(io: Server, socket: Socket, roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.players.delete(socket.id);
  room.scores.delete(socket.id);
  playerRoom.delete(socket.id);
  socket.leave(roomId);

  if (room.players.size === 0) {
    if (room.gameTimer) clearInterval(room.gameTimer);
    rooms.delete(roomId);
  } else {
    broadcastRoomUpdate(io, room);
    // If all real active escapers disconnected mid-match
    if (room.gamePhase === 'PLAYING' && getActiveEscapers(room).filter(p => !p.isBot).length === 0) {
      endRoom(io, room, 'ATTACKERS_WIN');
    }
  }
}

main().catch(err => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
