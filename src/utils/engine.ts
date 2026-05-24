/**
 * Pure game-logic engine.
 * All mutable game state lives in a GameState ref (not React state) so
 * values are NEVER stale inside the animation loop.
 * React state is only updated for HUD display via callback functions.
 */
import { nanoid } from 'nanoid';
import {
  PLAYER_RADIUS, ACCEL, FRICTION, MAX_VX,
  INITIAL_SPEED, SPEED_RAMP, LEVEL_SPEED_BONUS,
  BASE_SPAWN_INTERVAL, MIN_SPAWN_INTERVAL, BOSS_SPAWN_INTERVAL,
  BOT_ACCEL, BOT_FRICTION, BOT_EVADE_DIST,
  BOT_REACTION_MIN, BOT_REACTION_MAX, BOT_SKILL_PER_LVL,
  BOT_ATTACK_INTERVAL_BASE, BOT_ATTACK_INTERVAL_MIN,
  SCORE_PER_LEVEL, SCORE_SURVIVE_PER_FRAME, SCORE_NEAR_MISS,
  SCORE_OBSTACLE_CLEARED, SCORE_POWERUP_COIN, SCORE_ATTACKER_HIT_BOT,
  COMBO_TIMEOUT_FRAMES, POWERUP_SPAWN_INTERVAL, POWERUP_DURATION,
  MAGNET_ATTRACT_RADIUS, MAGNET_FORCE,
  ATTACKER_ENERGY_REGEN, ATTACKER_ENERGY_MAX, ATTACKER_DROP_COST, ABILITY_COST,
  NEAR_MISS_THRESHOLD, EXPLOSION_PARTICLE_COUNT, SPARK_PARTICLE_COUNT,
  BOT_FILL_COLOR_POOL, TEAM_SIZE,
  COLOR_ESCAPER, COLOR_ATTACKER, COLOR_OBSTACLE, COLOR_BOSS_OBS,
  // Enhanced physics
  GRAVITY, VERTICAL_ACCEL, MAX_VY, PLAYER_MIN_Y_OFFSET,
  DASH_SPEED, DASH_DURATION_FRAMES, DASH_COOLDOWN_FRAMES,
  DASH_INVINCIBILITY, DASH_TRAIL_MULTIPLIER,
  BULLET_TIME_DURATION, BULLET_TIME_SPEED_MULT,
  BULLET_TIME_THRESHOLD, BULLET_TIME_WINDOW,
  OBSTACLE_MIN_ROTATION, OBSTACLE_MAX_ROTATION,
  OBSTACLE_GRAVITY_BASE, OBSTACLE_GRAVITY_VARIANCE,
  // Recall & attacker body
  RECALL_ASSET_SIZE, RECALL_SPAWN_CHANCE_EARLY, RECALL_SPAWN_CHANCE_MID, RECALL_SPAWN_CHANCE_LATE,
  ATTACKER_RADIUS, ATTACKER_ACCEL, ATTACKER_FRICTION, ATTACKER_MAX_VX,
  ATTACKER_BUMP_FORCE, ATTACKER_PUSH_THRESHOLD,
} from '../constants';
import type {
  GameState, Obstacle, PowerUp, PowerUpType, BotState,
  FloatingText, Particle, TrailPoint, SpeedLine, WinResult,
  RemotePlayer,
} from '../types';

// ── Recall asset (live on canvas, only in ONLINE/LOCAL) ───────────────────────
export interface RecallAsset {
  id: string;
  x: number;
  y: number;
  recallTargetId: string; // the eliminated escaperId this recall revives
  life: number;           // counts down; if hits 0 before pickup → disappears
}
import { playSound, startAmbient, stopAmbient } from './audio';

// ── Factory ───────────────────────────────────────────────────────────────────
export function makeInitialGameState(
  canvasW: number,
  canvasH: number,
  role: 'ESCAPER' | 'ATTACKER',
  mode: 'OFFLINE' | 'ONLINE' | 'LOCAL',
  numBots: number,
  playerName: string
): GameState {
  const bots = buildBots(numBots, canvasW, canvasH, role, mode);
  return {
    playerX: canvasW / 2,
    playerY: canvasH - 80,
    playerVx: 0,
    playerVy: 0,
    playerColor: COLOR_ESCAPER,
    playerHue: 120,
    bots,
    remotePlayers: [],
    obstacles: [],
    powerUps: [],
    particles: [],
    trails: [],
    floatingTexts: [],
    speedLines: [],
    spawns: [],
    worldSpeed: INITIAL_SPEED,
    frameCount: 0,
    shake: 0,
    glitchTimer: 0,
    keys: {},
    touchX: null,
    touchY: null,
    powerUpTimers: { shield: 0, fire: 0, hide: 0, slow: 0, magnet: 0, timeStop: 0, boost: 0 },
    attackerEnergy: 20,
    attackerTimer: role === 'ATTACKER' && mode !== 'ONLINE' ? 60 * 60 : 90 * 60,
    attackerReticle: { x: canvasW / 2, y: canvasH - 80, lockProgress: 0, targetId: null },
    attackerDropCooldown: 0,
    score: 0,
    level: 1,
    combo: 0,
    comboTimer: 0,
    multiplier: 1,
    levelUpFlash: 0,
    isGameOver: false,
    winResult: null,
    isSpectating: false,
    attackerX: canvasW / 2,
    attackerVx: 0,
    lastSpawnFrame: 0,
    lastPowerUpFrame: 0,
    botAttackFrame: 0,
    // Enhanced mechanics
    dashCooldown: 0,
    dashActive: 0,
    dashDirectionX: 0,
    dashDirectionY: 0,
    dashInvincibility: 0,
    bulletTimeActive: 0,
    recentNearMissTimestamps: [],
  };
}

function buildBots(
  count: number,
  canvasW: number,
  canvasH: number,
  role: 'ESCAPER' | 'ATTACKER',
  mode: 'OFFLINE' | 'ONLINE' | 'LOCAL'
): BotState[] {
  if (mode === 'OFFLINE') {
    if (role === 'ESCAPER') {
      // No bots needed — obstacle AI handles it
      return [];
    } else {
      // One bot escaper for attacker to hunt
      return [{
        id: 'bot-0',
        x: canvasW / 2,
        y: canvasH - 80,
        vx: 0,
        vy: 0,
        isDefeated: false,
        reactionTimer: 0,
        targetX: canvasW / 2,
        evadeDir: 1,
        evadeCooldown: 0,
        name: 'GHOST',
        color: COLOR_ESCAPER,
        dropCooldown: 0,
      }];
    }
  }
  // Online/local — fill missing team slots with bots
  return Array.from({ length: count }, (_, i) => ({
    id: `bot-${i}`,
    x: (canvasW / (count + 1)) * (i + 1),
    y: canvasH - 80,
    vx: 0,
    vy: 0,
    isDefeated: false,
    reactionTimer: BOT_REACTION_MIN + Math.random() * (BOT_REACTION_MAX - BOT_REACTION_MIN),
    targetX: canvasW / 2,
    evadeDir: Math.random() > 0.5 ? 1 : -1,
    evadeCooldown: 0,
    name: `BOT-${i + 1}`,
    color: BOT_FILL_COLOR_POOL[i % BOT_FILL_COLOR_POOL.length],
  }));
}

// ── Obstacle factory ──────────────────────────────────────────────────────────
function spawnRandomObstacle(canvasW: number, level: number): Obstacle {
  const roll = Math.random();
  let type: Obstacle['type'] = 'BLOCK';
  let width = 36 + Math.random() * 24;
  let height = 28 + Math.random() * 20;
  if (roll > 0.72) {
    type = 'GATE';
    width = 120 + Math.random() * 80;
    height = 22 + Math.random() * 14;
  }
  // At higher levels give some blocks horizontal velocity
  const vx = level >= 3 ? (Math.random() - 0.5) * (level * 0.6) : 0;
  // Rotation and gravity variance for enhanced physics
  const rotSpeed = level >= 2 && type === 'BLOCK'
    ? OBSTACLE_MIN_ROTATION + Math.random() * (OBSTACLE_MAX_ROTATION - OBSTACLE_MIN_ROTATION)
    : 0;
  const gravMult = OBSTACLE_GRAVITY_BASE + (Math.random() - 0.5) * OBSTACLE_GRAVITY_VARIANCE;
  return {
    id: nanoid(8),
    x: Math.random() * Math.max(canvasW - width, 10),
    y: -80,
    width,
    height,
    color: COLOR_OBSTACLE,
    type,
    vx,
    nearMissTriggered: false,
    rotation: 0,
    rotationSpeed: rotSpeed,
    gravityMultiplier: gravMult,
  };
}

function spawnBossObstacle(canvasW: number): Obstacle {
  return {
    id: nanoid(8),
    x: 0,
    y: -100,
    width: canvasW,
    height: 40 + Math.random() * 20,
    color: COLOR_BOSS_OBS,
    type: 'BOSS',
    vx: 0,
    nearMissTriggered: false,
    rotation: 0,
    rotationSpeed: 0,
    gravityMultiplier: 0.8,
  };
}

function spawnObstacleAtX(x: number): Obstacle {
  return {
    id: nanoid(8),
    x: x - 20,
    y: -50,
    width: 40,
    height: 36,
    color: COLOR_ATTACKER,
    type: 'BLOCK',
    vx: 0,
    nearMissTriggered: false,
    rotation: 0,
    rotationSpeed: (Math.random() - 0.5) * 0.03,
    gravityMultiplier: 1.0,
  };
}

function spawnPowerUp(canvasW: number): PowerUp {
  const types: PowerUpType[] = ['SHIELD','BOOST','FIRE','HIDE','COIN','SLOW','MAGNET','TIME_STOP'];
  return {
    id: nanoid(8),
    x: PLAYER_RADIUS + Math.random() * (canvasW - PLAYER_RADIUS * 2),
    y: -30,
    type: types[Math.floor(Math.random() * types.length)],
    size: 22,
  };
}

// ── Particle factory ──────────────────────────────────────────────────────────
function explosion(g: GameState, x: number, y: number, color: string, count = EXPLOSION_PARTICLE_COUNT) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 7;
    g.particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      maxLife: 1,
      color,
      size: 2 + Math.random() * 3,
    });
  }
}

function sparks(g: GameState, x: number, y: number, color: string) {
  explosion(g, x, y, color, SPARK_PARTICLE_COUNT);
}

function floatText(
  g: GameState,
  x: number, y: number,
  text: string,
  color: string,
  size = 18
) {
  g.floatingTexts.push({ 
    id: nanoid(6), 
    x, 
    y, 
    text, 
    life: 60, 
    maxLife: 60, 
    color, 
    size 
  });
}

// ── Main update tick ──────────────────────────────────────────────────────────
export interface TickCallbacks {
  onScoreUpdate: (s: number) => void;
  onLevelUpdate: (l: number) => void;
  onComboUpdate: (c: number, m: number) => void;
  onEnergyUpdate: (e: number) => void;
  onTimerUpdate: (seconds: number) => void;
  onGameOver: (result: WinResult, score: number) => void;
  onPlayerEliminated?: (playerId: string) => void;
  onPlayerSpectating?: () => void;                        // local player was hit → spectate
  onRecallAssetSpawned?: (asset: RecallAsset) => void;    // server should broadcast this
  onRecallUsed?: (recallTargetId: string) => void;        // teammate recalled
  emitMove?: (x: number, y: number, vx: number, vy: number, states: { isShielded: boolean; isFiring: boolean; isHidden: boolean }) => void;
  emitDropAttack?: (x: number) => void;
  emitBotMove?: (botId: string, x: number, y: number, vx: number, vy: number) => void;
  emitBotDrop?: (botId: string, x: number) => void;
}

export function tick(
  g: GameState,
  canvasW: number,
  canvasH: number,
  role: 'ESCAPER' | 'ATTACKER',
  mode: 'OFFLINE' | 'ONLINE' | 'LOCAL',
  cb: TickCallbacks,
  recallAssets: RecallAsset[] = [],
  teamSize: number = 2
) {
  if (g.isGameOver) return;

  g.frameCount++;

  // ── Player movement ────────────────────────────────────────────────────────
  if (role === 'ESCAPER') {
    updateEscaperMovement(g, canvasW, canvasH, cb);
  } else {
    updateAttacker(g, canvasW, canvasH, mode, cb);
  }

  // ── Bot logic ──────────────────────────────────────────────────────────────
  // CONCEPT FIX: process ALL bots including defeated ones (for respawn timer)
  g.bots.forEach(bot => updateBot(bot, g, canvasW, canvasH, role));

  // ── Online Bot Hosting ─────────────────────────────────────────────────────
  // Host client simulates the remote server bots so they actually move/attack
  if (mode !== 'OFFLINE' && cb.emitBotMove && cb.emitBotDrop) {
    g.remotePlayers.forEach(p => {
      if (!p.isBot) return;
      
      if (p.role === 'ESCAPER' && !p.isDefeated) {
        // Run fast bot AI
        updateBotEscaperAI(p as any as BotState, g, canvasW);
        cb.emitBotMove!(p.id, p.x, p.y, p.vx, 0); // emit to server
      } else if (p.role === 'ATTACKER') {
        const botAttackInterval = Math.max(
          BOT_ATTACK_INTERVAL_MIN,
          BOT_ATTACK_INTERVAL_BASE - g.level * 8
        );
        // stagger drops between different bots
        const frameOffset = parseInt(p.id.slice(-2), 16) || 0; 
        if ((g.frameCount + frameOffset * 30) % botAttackInterval === 0) {
          // Find alive escapers to target
          const targets = g.remotePlayers.filter(rp => rp.role === 'ESCAPER' && !rp.isDefeated);
          if (role === 'ESCAPER' && !g.isGameOver) targets.push({ x: g.playerX, vx: g.playerVx } as any);
          
          let aimX = canvasW / 2;
          if (targets.length > 0) {
            const t = targets[Math.floor(Math.random() * targets.length)];
            const predictX = t.x + (t.vx || 0) * (canvasH / (g.worldSpeed * 2));
            const spread = Math.max(20, 120 - g.level * 8);
            aimX = predictX + (Math.random() - 0.5) * spread;
          }
          const clampedX = Math.max(30, Math.min(canvasW - 30, aimX));
          cb.emitBotDrop!(p.id, clampedX);

          // Volley Drops
          if (g.level >= 3 && Math.random() < 0.4) {
            const flankX = clampedX + (Math.random() > 0.5 ? 1 : -1) * (80 + Math.random() * 100);
            cb.emitBotDrop!(p.id, Math.max(30, Math.min(canvasW - 30, flankX)));
          }
          if (g.level >= 6 && Math.random() < 0.25) {
            for (let i = 0; i < 3; i++) {
               const bx = 40 + Math.random() * (canvasW - 80);
               cb.emitBotDrop!(p.id, bx);
            }
          }
        }
      }
    });
  }

  // ── Attacker physical body movement (ONLINE/LOCAL only) ────────────────────
  // Attackers are physical beings at the top strip of the screen.
  // They move left/right, collide with each other realistically.
  if (role === 'ATTACKER' && mode !== 'OFFLINE') {
    // Keyboard movement
    if (g.keys['ArrowLeft'] || g.keys['a'] || g.keys['A']) g.attackerVx -= ATTACKER_ACCEL;
    if (g.keys['ArrowRight'] || g.keys['d'] || g.keys['D']) g.attackerVx += ATTACKER_ACCEL;
    g.attackerVx *= ATTACKER_FRICTION;
    g.attackerVx = Math.max(-ATTACKER_MAX_VX, Math.min(ATTACKER_MAX_VX, g.attackerVx));
    g.attackerX += g.attackerVx;
    // Wall bounce
    if (g.attackerX < ATTACKER_RADIUS) { g.attackerX = ATTACKER_RADIUS; g.attackerVx *= -0.5; }
    if (g.attackerX > canvasW - ATTACKER_RADIUS) { g.attackerX = canvasW - ATTACKER_RADIUS; g.attackerVx *= -0.5; }

    // Collision with other remote attackers — physical bump
    g.remotePlayers.forEach(p => {
      if (p.role !== 'ATTACKER' || p.id === undefined) return;
      const dx = g.attackerX - p.x;
      const dist = Math.abs(dx);
      if (dist < ATTACKER_PUSH_THRESHOLD && dist > 0) {
        // Push both apart — equal and opposite impulse
        const pushDir = dx > 0 ? 1 : -1;
        const overlap = ATTACKER_PUSH_THRESHOLD - dist;
        const force = (overlap / ATTACKER_PUSH_THRESHOLD) * ATTACKER_BUMP_FORCE;
        g.attackerX += pushDir * force;
        g.attackerVx += pushDir * force * 0.6;
        // Clamp to screen edges after bump
        g.attackerX = Math.max(ATTACKER_RADIUS, Math.min(canvasW - ATTACKER_RADIUS, g.attackerX));
        // Visual feedback
        if (overlap > 8) {
          g.shake = Math.max(g.shake, 4);
          sparks(g, g.attackerX, 40, '#ff6600');
        }
      }
    });
  }

  // ── Recall asset pickup (ESCAPER in ONLINE/LOCAL, not spectating) ──────────
  if (role === 'ESCAPER' && mode !== 'OFFLINE' && !g.isSpectating) {
    for (let i = recallAssets.length - 1; i >= 0; i--) {
      const ra = recallAssets[i];
      const dx = g.playerX - ra.x;
      const dy = g.playerY - ra.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < RECALL_ASSET_SIZE + PLAYER_RADIUS) {
        // Picked up! Remove it and emit recall
        recallAssets.splice(i, 1);
        cb.onRecallUsed?.(ra.recallTargetId);
        floatText(g, g.playerX, g.playerY - 40, '📡 RECALL SENT!', '#00ff88', 18);
        sparks(g, g.playerX, g.playerY, '#00ff88');
        playSound('powerup');
        g.shake = 6;
      }
    }
  }

  // ── World speed ramp ───────────────────────────────────────────────────────
  g.worldSpeed = Math.min(22, g.worldSpeed + SPEED_RAMP);

  // ── Leveling ───────────────────────────────────────────────────────────────
  const newLevel = Math.floor(g.score / SCORE_PER_LEVEL) + 1;
  if (newLevel > g.level) {
    g.level = newLevel;
    g.worldSpeed += LEVEL_SPEED_BONUS;
    playSound('levelup');
    floatText(g, canvasW / 2, canvasH / 2, `SECTOR ${g.level}`, '#ff0055', 28);
    cb.onLevelUpdate(g.level);
  }

  // ── Level-up flash timer ───────────────────────────────────────────────────
  if (g.levelUpFlash > 0) g.levelUpFlash--;

  // ── Spawning (offline escaper mode) ───────────────────────────────────────
  if (role === 'ESCAPER' && mode === 'OFFLINE') {
    const isBoss = g.level % 5 === 0;
    const spawnInterval = isBoss
      ? BOSS_SPAWN_INTERVAL
      : Math.max(MIN_SPAWN_INTERVAL, BASE_SPAWN_INTERVAL - g.level * 3);

    // Cap max active obstacles to prevent impossible scenarios
    const MAX_OBSTACLES = 35;
    if (g.obstacles.length >= MAX_OBSTACLES) {
      // Skip spawning when screen is saturated
    } else if (g.frameCount - g.lastSpawnFrame >= spawnInterval) {
      if (isBoss && g.frameCount % 90 === 0) {
        g.obstacles.push(spawnBossObstacle(canvasW));
      } else {
        // Spawn extra obstacles at higher levels for intensity
        const count = g.level >= 6 ? 2 : 1;
        for (let i = 0; i < count; i++) {
          g.obstacles.push(spawnRandomObstacle(canvasW, g.level));
        }
      }
      g.lastSpawnFrame = g.frameCount;
      playSound('spawn');
    }

    // ── Bot attacker AI — drop targeted attacks in offline mode ────────────
    const botAttackInterval = Math.max(
      BOT_ATTACK_INTERVAL_MIN,
      BOT_ATTACK_INTERVAL_BASE - g.level * 8
    );
    if (g.frameCount - g.botAttackFrame >= botAttackInterval) {
      // Smart targeting: predict player position and aim slightly ahead
      const predictX = g.playerX + g.playerVx * (canvasH / (g.worldSpeed * 2));
      const spread = Math.max(20, 120 - g.level * 8); // tighter aim at higher levels
      const aimX = predictX + (Math.random() - 0.5) * spread;
      const clampedX = Math.max(30, Math.min(canvasW - 30, aimX));
      g.obstacles.push(spawnObstacleAtX(clampedX));
      g.botAttackFrame = g.frameCount;

      // At higher levels, drop flanking attacks too
      if (g.level >= 4 && Math.random() < 0.35) {
        const flankX = g.playerX + (Math.random() > 0.5 ? 1 : -1) * (80 + Math.random() * 100);
        g.obstacles.push(spawnObstacleAtX(Math.max(30, Math.min(canvasW - 30, flankX))));
      }
      // Boss levels: carpet bomb
      if (g.level >= 8 && Math.random() < 0.2) {
        for (let i = 0; i < 4; i++) {
          const bx = 40 + Math.random() * (canvasW - 80);
          g.obstacles.push(spawnObstacleAtX(bx));
        }
        floatText(g, canvasW / 2, 100, 'CARPET BOMB!', '#ff3300', 22);
        g.shake = 8;
      }
    }
  }

  // ── Power-up spawning (escaper mode only) ─────────────────────────────────
  if (role === 'ESCAPER' && g.frameCount - g.lastPowerUpFrame >= POWERUP_SPAWN_INTERVAL) {
    g.powerUps.push(spawnPowerUp(canvasW));
    g.lastPowerUpFrame = g.frameCount;
  }

  // ── Active power-up timers ─────────────────────────────────────────────────
  const pt = g.powerUpTimers;
  if (pt.shield > 0) pt.shield--;
  if (pt.fire > 0) pt.fire--;
  if (pt.hide > 0) pt.hide--;
  if (pt.slow > 0) pt.slow--;
  if (pt.magnet > 0) pt.magnet--;
  if (pt.timeStop > 0) pt.timeStop--;
  if (pt.boost > 0) pt.boost--;

  // ── Effective world speed (with bullet-time) ──────────────────────────────
  let effectiveSpeed = g.worldSpeed;
  if (g.bulletTimeActive > 0) {
    effectiveSpeed *= BULLET_TIME_SPEED_MULT;
    g.bulletTimeActive--;
  } else if (pt.timeStop > 0) {
    effectiveSpeed = 0;
  } else if (pt.slow > 0) {
    effectiveSpeed *= 0.38;
  } else if (pt.boost > 0) {
    effectiveSpeed *= 1.55;
  }

  // ── Dash timer decay ──────────────────────────────────────────────────────
  if (g.dashActive > 0) g.dashActive--;
  if (g.dashCooldown > 0) g.dashCooldown--;
  if (g.dashInvincibility > 0) g.dashInvincibility--;

  // ── Attacker cooldown ─────────────────────────────────────────────────────
  if (g.attackerDropCooldown > 0) g.attackerDropCooldown--;

  // ── Obstacles update ───────────────────────────────────────────────────────
  for (let i = g.obstacles.length - 1; i >= 0; i--) {
    const obs = g.obstacles[i];
    obs.y += effectiveSpeed * obs.gravityMultiplier;
    if (obs.vx) obs.x += obs.vx;
    // Rotate obstacles
    if (obs.rotationSpeed) obs.rotation += obs.rotationSpeed;
    // Wall bounce for moving obstacles
    if (obs.vx && (obs.x < 0 || obs.x + obs.width > canvasW)) obs.vx *= -1;

    // ── Escaper collision ──────────────────────────────────────────────────
    if (role === 'ESCAPER' && pt.hide <= 0 && g.dashInvincibility <= 0) {
      const hit = circleRectHit(g.playerX, g.playerY, PLAYER_RADIUS, obs);
      if (hit) {
        if (pt.fire > 0) {
          // Fire destroys obstacle
          explosion(g, obs.x + obs.width / 2, obs.y + obs.height / 2, obs.color);
          g.obstacles.splice(i, 1);
          addScore(g, 40, cb.onScoreUpdate);
          playSound('hit');
          g.shake = 8;
        } else if (pt.shield > 0) {
          // Shield absorbs one hit
          pt.shield = 0;
          explosion(g, obs.x + obs.width / 2, obs.y + obs.height / 2, '#00f2ff', 18);
          g.obstacles.splice(i, 1);
          playSound('shield_ping');
          g.shake = 5;
        } else {
          // Death — in ONLINE/LOCAL enter spectate mode instead of instant game-over
          g.shake = 35;
          g.glitchTimer = 30;
          if (mode === 'OFFLINE') {
            triggerGameOver(g, 'PLAYER_HIT', cb);
          } else {
            g.isSpectating = true;
            explosion(g, g.playerX, g.playerY, '#ff0055', 40);
            floatText(g, g.playerX, g.playerY - 50, 'ELIMINATED — SPECTATING', '#ff0055', 16);
            playSound('defeat');
            cb.onPlayerSpectating?.();
          }
        }
        continue;
      }
      // Near-miss detection
      if (!obs.nearMissTriggered) {
        // Use edge-to-circle distance (same as collision but with expanded radius)
        const nearX = Math.max(obs.x, Math.min(g.playerX, obs.x + obs.width));
        const nearY = Math.max(obs.y, Math.min(g.playerY, obs.y + obs.height));
        const edgeDx = g.playerX - nearX;
        const edgeDy = g.playerY - nearY;
        const edgeDist = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
        if (edgeDist < NEAR_MISS_THRESHOLD + PLAYER_RADIUS && edgeDist > PLAYER_RADIUS) {
          obs.nearMissTriggered = true;
          g.combo++;
          g.comboTimer = COMBO_TIMEOUT_FRAMES;
          g.multiplier = Math.min(5, 1 + Math.floor(g.combo / 8));
          addScore(g, SCORE_NEAR_MISS * g.multiplier, cb.onScoreUpdate);
          playSound('nearmiss');
          floatText(g, g.playerX, g.playerY - 30, `NEAR MISS! x${g.multiplier}`, '#00f2ff', 16);
          cb.onComboUpdate(g.combo, g.multiplier);
          sparks(g, g.playerX, g.playerY, '#00f2ff');
          // Track for bullet-time trigger
          g.recentNearMissTimestamps.push(g.frameCount);
          // Remove old timestamps outside window
          g.recentNearMissTimestamps = g.recentNearMissTimestamps.filter(
            t => g.frameCount - t < BULLET_TIME_WINDOW
          );
          // Trigger bullet-time if threshold reached
          if (g.recentNearMissTimestamps.length >= BULLET_TIME_THRESHOLD && g.bulletTimeActive <= 0) {
            g.bulletTimeActive = BULLET_TIME_DURATION;
            g.recentNearMissTimestamps = []; // reset
            g.shake = 12;
            floatText(g, canvasW / 2, canvasH / 2 - 50, '⏱ BULLET TIME!', '#ff00ff', 28);
            playSound('boost_activate');
          }
        }
      }
    }

    // ── Bot escaper collision (attacker mode) ──────────────────────────────
    let levelWon = false;
    if (role === 'ATTACKER') {
      for (const bot of g.bots) {
        if (bot.isDefeated || levelWon) break;
        const hit = circleRectHit(bot.x, bot.y, PLAYER_RADIUS, obs);
        if (hit) {
          bot.isDefeated = true;
          explosion(g, bot.x, bot.y, '#ff0055', 30);
          g.obstacles.splice(i, 1);
          addScore(g, SCORE_ATTACKER_HIT_BOT * g.level, cb.onScoreUpdate);
          playSound('hit');
          g.shake = 14;

          // ── WIN THIS LEVEL! Level up with harder bot ──
          g.level++;
          g.worldSpeed += LEVEL_SPEED_BONUS;
          cb.onLevelUpdate(g.level);
          floatText(g, bot.x, bot.y - 30, `SECTOR ${g.level} CLEARED!`, '#00ff88', 24);
          floatText(g, canvasW / 2, canvasH / 2, '⭐ LEVEL UP!', '#ffd700', 32);
          playSound('levelup');

          // Full timer reset — every level is a fair, winnable challenge
          g.attackerTimer = 60 * 60; // always 60 seconds

          // Respawn bot with harder stats after short delay
          bot.respawnTimer = 90; // 1.5 seconds

          levelWon = true;
        }
      }
      // CRITICAL FIX: If we won the level, clear remaining obstacles and immediately BREAK the outer loop
      // so it does not attempt to read the next obstacle in an empty array (which causes Cannot read .y of undefined)
      if (levelWon) {
        g.obstacles.length = 0;
        break;
      }
    }

    // ── Remote escaper collision (online/local) ────────────────────────────
    if (role === 'ATTACKER' && (mode === 'ONLINE' || mode === 'LOCAL')) {
      g.remotePlayers.forEach(p => {
        if (p.role !== 'ESCAPER' || p.isDefeated || p.isHidden) return;
        const hit = circleRectHit(p.x, p.y, PLAYER_RADIUS, obs);
        if (hit) {
          if (!p.isShielded) {
            explosion(g, p.x, p.y, '#ff0055', 24);
            sparks(g, p.x, p.y, '#ff0055');
            playSound('hit');
          }
        }
      });
    }

    // ── Off-screen cleanup (moved scoring here for consistency) ─────────────
    if (obs.y > canvasH + 60) {
      g.obstacles.splice(i, 1);
      if (role === 'ESCAPER') {
        addScore(g, SCORE_OBSTACLE_CLEARED * g.multiplier, cb.onScoreUpdate);
      }
    }
  }

  // ── Power-ups update ───────────────────────────────────────────────────────
  if (role === 'ESCAPER') {
    for (let i = g.powerUps.length - 1; i >= 0; i--) {
      const pu = g.powerUps[i];
      // Magnet pull
      if (pt.magnet > 0) {
        const dx = g.playerX - pu.x;
        const dy = g.playerY - pu.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAGNET_ATTRACT_RADIUS) {
          pu.x += dx * MAGNET_FORCE;
          pu.y += dy * MAGNET_FORCE;
        }
      }
      pu.y += effectiveSpeed * 0.75;
      const dx = g.playerX - pu.x;
      const dy = g.playerY - pu.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < pu.size + PLAYER_RADIUS) {
        g.powerUps.splice(i, 1);
        applyPowerUp(g, pu, canvasW, canvasH, cb);
        continue;
      }
      if (pu.y > canvasH + 40) g.powerUps.splice(i, 1);
    }
  }

  // ── Particles ──────────────────────────────────────────────────────────────
  for (let i = g.particles.length - 1; i >= 0; i--) {
    const p = g.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12; // micro gravity
    p.life -= 0.025;
    if (p.life <= 0) g.particles.splice(i, 1);
  }

  // ── Trails (enhanced with dash multiplier) ────────────────────────────────
  const trailInterval = g.dashActive > 0 ? 1 : 2;
  if (role === 'ESCAPER' && g.frameCount % trailInterval === 0 && (Math.abs(g.playerVx) > 0.5 || Math.abs(g.playerVy) > 0.5)) {
    const trailCount = g.dashActive > 0 ? DASH_TRAIL_MULTIPLIER : 1;
    for (let t = 0; t < trailCount; t++) {
      g.trails.push({
        x: g.playerX + (Math.random() - 0.5) * (g.dashActive > 0 ? 12 : 0),
        y: g.playerY + (Math.random() - 0.5) * (g.dashActive > 0 ? 12 : 0),
        life: 1,
        color: g.dashActive > 0 ? '#ff00ff' : g.playerColor,
      });
    }
  }
  for (let i = g.trails.length - 1; i >= 0; i--) {
    g.trails[i].life -= 0.055;
    if (g.trails[i].life <= 0) g.trails.splice(i, 1);
  }

  // ── Speed lines ────────────────────────────────────────────────────────────
  if (g.frameCount % 4 === 0 && g.speedLines.length < 50) {
    g.speedLines.push({
      x: Math.random() * canvasW,
      y: -80,
      length: 20 + Math.random() * 60,
      speed: 8 + Math.random() * 12,
      opacity: 0.05 + Math.random() * 0.12,
    });
  }
  for (let i = g.speedLines.length - 1; i >= 0; i--) {
    const sl = g.speedLines[i];
    sl.y += sl.speed + g.worldSpeed;
    if (sl.y > canvasH + 100) g.speedLines.splice(i, 1);
  }

  // ── Floating texts ─────────────────────────────────────────────────────────
  for (let i = g.floatingTexts.length - 1; i >= 0; i--) {
    const ft = g.floatingTexts[i];
    ft.y -= 1.2;
    ft.life -= 0.018;
    if (ft.life <= 0) g.floatingTexts.splice(i, 1);
  }

  // ── Spawn flashes ──────────────────────────────────────────────────────────
  for (let i = g.spawns.length - 1; i >= 0; i--) {
    g.spawns[i].life -= 0.08;
    if (g.spawns[i].life <= 0) g.spawns.splice(i, 1);
  }

  // ── Screen shake decay ─────────────────────────────────────────────────────
  if (g.shake > 0) g.shake *= 0.88;

  // ── Glitch decay ───────────────────────────────────────────────────────────
  if (g.glitchTimer > 0) g.glitchTimer--;

  // ── Combo timeout ─────────────────────────────────────────────────────────
  if (g.comboTimer > 0) {
    g.comboTimer--;
  } else if (g.combo > 0) {
    g.combo = 0;
    g.multiplier = 1;
    cb.onComboUpdate(0, 1);
    playSound('combobreak');
  }

  // ── Survive score (escaper only, per 4 frames) ─────────────────────────────
  if (role === 'ESCAPER' && g.frameCount % 4 === 0) {
    addScore(g, SCORE_SURVIVE_PER_FRAME, cb.onScoreUpdate);
  }

  // ── Attacker energy regen ──────────────────────────────────────────────────
  if (role === 'ATTACKER') {
    g.attackerEnergy = Math.min(ATTACKER_ENERGY_MAX, g.attackerEnergy + ATTACKER_ENERGY_REGEN);
    cb.onEnergyUpdate(g.attackerEnergy);
  }

  // ── Player hue cycle ───────────────────────────────────────────────────────
  if (role === 'ESCAPER') {
    g.playerHue = (g.playerHue + 0.3) % 360;
    if (g.frameCount % 180 === 0) {
      g.playerColor = `hsl(${g.playerHue}, 100%, 65%)`;
    }
  }

  // Cleanup is handled by splice() in the individual update loops above.
  // No redundant .filter() needed — avoids O(n) array allocations per frame.
}

// ── Escaper movement ──────────────────────────────────────────────────────────
function updateEscaperMovement(
  g: GameState,
  canvasW: number,
  canvasH: number,
  cb: TickCallbacks
) {
  const { keys, powerUpTimers: pt } = g;
  const speedMod = pt.boost > 0 ? 1.4 : (pt.slow > 0 ? 0.6 : 1);

  // ── Horizontal movement ─────────────────────────────────────────────────
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) g.playerVx -= ACCEL * speedMod;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) g.playerVx += ACCEL * speedMod;

  // ── Vertical movement (NEW — free 2D movement) ─────────────────────────
  if (keys['ArrowUp'] || keys['w'] || keys['W']) g.playerVy -= VERTICAL_ACCEL * speedMod;
  if (keys['ArrowDown'] || keys['s'] || keys['S']) g.playerVy += VERTICAL_ACCEL * speedMod * 0.5;

  // ── Gravity pulls player down ───────────────────────────────────────────
  g.playerVy += GRAVITY;

  // ── Dash mechanic ───────────────────────────────────────────────────────
  if ((keys[' '] || keys['Shift']) && g.dashCooldown <= 0 && g.dashActive <= 0) {
    // Determine dash direction
    let dx = 0, dy = 0;
    if (keys['ArrowLeft'] || keys['a'] || keys['A']) dx = -1;
    if (keys['ArrowRight'] || keys['d'] || keys['D']) dx = 1;
    if (keys['ArrowUp'] || keys['w'] || keys['W']) dy = -1;
    if (keys['ArrowDown'] || keys['s'] || keys['S']) dy = 1;
    // Default: dash in current velocity direction or forward
    if (dx === 0 && dy === 0) {
      dx = Math.sign(g.playerVx) || 0;
      dy = -1; // default upward dash
    }
    // Normalize
    const mag = Math.sqrt(dx * dx + dy * dy) || 1;
    g.dashDirectionX = dx / mag;
    g.dashDirectionY = dy / mag;
    g.dashActive = DASH_DURATION_FRAMES;
    g.dashCooldown = DASH_COOLDOWN_FRAMES;
    g.dashInvincibility = DASH_INVINCIBILITY;
    playSound('boost_activate');
    g.shake = 4;
    // Cancel gravity during dash
    g.playerVy = 0;
  }

  // ── Apply dash velocity ─────────────────────────────────────────────────
  if (g.dashActive > 0) {
    g.playerVx = g.dashDirectionX * DASH_SPEED;
    g.playerVy = g.dashDirectionY * DASH_SPEED;
  }

  // Touch control — pull towards touch X and Y
  if (g.touchX !== null) {
    const diffX = g.touchX - g.playerX;
    if (Math.abs(diffX) > 5) {
      g.playerVx += Math.sign(diffX) * ACCEL * 1.2 * speedMod;
    }
  }
  if (g.touchY !== null) {
    const diffY = g.touchY - g.playerY;
    if (Math.abs(diffY) > 5) {
      g.playerVy += Math.sign(diffY) * VERTICAL_ACCEL * 0.8 * speedMod;
    }
  }

  // ── Friction ─────────────────────────────────────────────────────────────
  g.playerVx *= FRICTION;
  g.playerVy *= (FRICTION + 0.04); // slightly less friction on Y for floaty feel

  // ── Speed clamp ─────────────────────────────────────────────────────────
  if (Math.abs(g.playerVx) > MAX_VX * speedMod) {
    g.playerVx = Math.sign(g.playerVx) * MAX_VX * speedMod;
  }
  if (Math.abs(g.playerVy) > MAX_VY * speedMod) {
    g.playerVy = Math.sign(g.playerVy) * MAX_VY * speedMod;
  }

  // ── Apply position ──────────────────────────────────────────────────────
  g.playerX += g.playerVx;
  g.playerY += g.playerVy;

  // ── Boundary with bounce (horizontal) ───────────────────────────────────
  if (g.playerX < PLAYER_RADIUS) { g.playerX = PLAYER_RADIUS; g.playerVx *= -0.4; }
  if (g.playerX > canvasW - PLAYER_RADIUS) { g.playerX = canvasW - PLAYER_RADIUS; g.playerVx *= -0.4; }

  // ── Boundary (vertical) — keep player on screen ─────────────────────────
  if (g.playerY < PLAYER_MIN_Y_OFFSET) {
    g.playerY = PLAYER_MIN_Y_OFFSET;
    g.playerVy *= -0.3;
  }
  if (g.playerY > canvasH - PLAYER_RADIUS) {
    g.playerY = canvasH - PLAYER_RADIUS;
    g.playerVy = 0; // land on floor
  }

  // Emit position to server
  cb.emitMove?.(g.playerX, g.playerY, g.playerVx, g.playerVy, {
    isShielded: g.powerUpTimers.shield > 0,
    isFiring: g.powerUpTimers.fire > 0,
    isHidden: g.powerUpTimers.hide > 0,
  });
}

// (All remaining functions below remain unchanged from your original file)
// ── Attacker logic, Bot AI, dropAttack, useAbility, applyPowerUp, addScore, 
// triggerGameOver, circleRectHit, receiveObstacle, receiveAbility, etc. ───────

function updateAttacker(
  g: GameState,
  canvasW: number,
  canvasH: number,
  mode: 'OFFLINE' | 'ONLINE' | 'LOCAL',
  cb: TickCallbacks
) {
  // Countdown timer
  if (g.attackerTimer > 0) {
    g.attackerTimer--;
    if (g.frameCount % 60 === 0) {
      cb.onTimerUpdate(Math.ceil(g.attackerTimer / 60));
    }
  } else {
    triggerGameOver(g, 'TIME_EXPIRED', cb);
    return;
  }
  // CONCEPT FIX: Track NEAREST live target, not just the first one
  let primaryX = canvasW / 2;
  let primaryY = canvasH - 80;
  let nearestDist = Infinity;
  let targetId: string | null = null;

  if (mode === 'OFFLINE') {
    // Track nearest live bot escaper
    g.bots.forEach(bot => {
      if (bot.isDefeated) return;
      const d = Math.abs(g.attackerReticle.x - bot.x) + Math.abs(g.attackerReticle.y - bot.y);
      if (d < nearestDist) {
        nearestDist = d;
        primaryX = bot.x;
        primaryY = bot.y;
        targetId = bot.id;
      }
    });
  } else {
    // Online/local: track nearest live remote escaper
    g.remotePlayers.forEach(p => {
      if (p.role !== 'ESCAPER' || p.isDefeated) return;
      const d = Math.abs(g.attackerReticle.x - p.x) + Math.abs(g.attackerReticle.y - p.y);
      if (d < nearestDist) {
        nearestDist = d;
        primaryX = p.x;
        primaryY = p.y;
        targetId = p.id;
      }
    });
  }

  g.attackerReticle.targetId = targetId;

  // Smooth reticle follow — faster tracking at closer range
  const trackSpeed = nearestDist < 100 ? 0.15 : 0.08;
  g.attackerReticle.x += (primaryX - g.attackerReticle.x) * trackSpeed;
  g.attackerReticle.y += (primaryY - g.attackerReticle.y) * trackSpeed;
  const dist = Math.abs(g.attackerReticle.x - primaryX);
  if (dist < 60) {
    g.attackerReticle.lockProgress = Math.min(1, g.attackerReticle.lockProgress + 0.012);
  } else {
    g.attackerReticle.lockProgress = Math.max(0, g.attackerReticle.lockProgress - 0.025);
  }
}

function updateBot(
  bot: BotState,
  g: GameState,
  canvasW: number,
  _canvasH: number,
  role: 'ESCAPER' | 'ATTACKER'
) {
  // Handle frame-based respawn timer
  if (bot.isDefeated && bot.respawnTimer !== undefined) {
    bot.respawnTimer--;
    if (bot.respawnTimer <= 0) {
      bot.isDefeated = false;
      bot.x = Math.random() * canvasW;
      bot.vx = 0;
      bot.respawnTimer = undefined;
    }
    return;
  }
  if (role === 'ATTACKER') {
    updateBotEscaperAI(bot, g, canvasW);
  }
}

// ── MASSIVELY IMPROVED Bot Escaper AI ─────────────────────────────────────────
// Bot now: looks ahead at multiple obstacles, finds safest zone,
// uses momentum-aware dodging, feints, and has personality traits
function updateBotEscaperAI(bot: BotState, g: GameState, canvasW: number) {
  const botY = bot.y;
  // Bot gets MUCH harder each level: speed and intelligence scale
  const skill = Math.min(0.98, (g.level - 1) * BOT_SKILL_PER_LVL + 0.3);
  const speedMultiplier = 1.0 + g.level * 0.15; // 15% faster each level
  const lookAhead = 250 + skill * 200 + g.level * 30; // sees further each level
  
  // === PHASE 1: Gather ALL incoming threats in look-ahead window ===
  const threats: { cx: number; cy: number; width: number; urgency: number }[] = [];
  g.obstacles.forEach(obs => {
    const obsBottom = obs.y + obs.height;
    const obsCX = obs.x + obs.width / 2;
    // Only care about obstacles approaching the bot's Y position
    if (obsBottom > botY - lookAhead && obs.y < botY + 30) {
      const timeToReach = Math.max(1, (botY - obsBottom) / Math.max(g.worldSpeed, 2));
      threats.push({
        cx: obsCX + (obs.vx * timeToReach * 0.5), // predict where it'll be
        cy: obs.y,
        width: obs.width,
        urgency: 1 / timeToReach, // closer = more urgent
      });
    }
  });

  // === PHASE 2: Find safest zones across the screen ===
  const zones = 12;
  const zoneWidth = canvasW / zones;
  const zoneDanger: number[] = new Array(zones).fill(0);
  
  threats.forEach(t => {
    const zoneIdx = Math.floor(Math.max(0, Math.min(t.cx, canvasW - 1)) / zoneWidth);
    const spread = Math.ceil(t.width / zoneWidth) + 1;
    for (let z = Math.max(0, zoneIdx - spread); z <= Math.min(zones - 1, zoneIdx + spread); z++) {
      const distFromCenter = Math.abs(z - zoneIdx);
      zoneDanger[z] += t.urgency * Math.max(0.2, 1 - distFromCenter * 0.3);
    }
  });

  // === PHASE 3: Choose best target zone ===
  let bestZone = Math.floor(bot.x / zoneWidth);
  let bestScore = -Infinity;
  
  for (let z = 0; z < zones; z++) {
    const zoneCenter = (z + 0.5) * zoneWidth;
    const distFromBot = Math.abs(zoneCenter - bot.x);
    const distPenalty = distFromBot * 0.003; // prefer nearby zones
    const edgePenalty = (z === 0 || z === zones - 1) ? 0.5 : 0; // avoid edges
    const safetyScore = -zoneDanger[z] - distPenalty - edgePenalty;
    
    if (safetyScore > bestScore) {
      bestScore = safetyScore;
      bestZone = z;
    }
  }

  const targetX = (bestZone + 0.5) * zoneWidth;

  // === PHASE 4: React with skill-appropriate timing ===
  if (bot.reactionTimer > 0) {
    bot.reactionTimer--;
  } else {
    const immediateThreats = threats.filter(t => t.urgency > 0.015);
    
    if (immediateThreats.length > 0) {
      // URGENT: strong acceleration toward safe zone
      const diff = targetX - bot.x;
      const accelStrength = BOT_ACCEL * (0.8 + skill * 1.5) * speedMultiplier;
      bot.vx += Math.sign(diff) * accelStrength;
      
      // Panic dodge: if obstacle is RIGHT on top, burst movement
      const closestThreat = immediateThreats.reduce((a, b) => a.urgency > b.urgency ? a : b);
      if (closestThreat.urgency > 0.05) {
        const panicDir = bot.x < closestThreat.cx ? -1 : 1;
        bot.vx += panicDir * accelStrength * 2;
        // Edge awareness during panic
        if (bot.x < 60) bot.vx = Math.abs(bot.vx);
        if (bot.x > canvasW - 60) bot.vx = -Math.abs(bot.vx);
      }

      bot.reactionTimer = Math.max(
        BOT_REACTION_MIN,
        Math.floor((BOT_REACTION_MAX - g.level * 4) * (1 - skill * 0.5))
      );
    } else {
      // No immediate danger — drift toward center with slight random movement
      const center = canvasW / 2;
      if (Math.abs(bot.x - center) > 80) {
        bot.vx += (bot.x < center ? 1 : -1) * BOT_ACCEL * 0.3;
      }
      // Feint: random juke to look alive
      if (Math.random() < 0.02 * skill) {
        bot.vx += (Math.random() - 0.5) * 4;
      }
    }
  }

  // === PHASE 5: Physics ===
  bot.vx *= BOT_FRICTION;
  const maxSpeed = MAX_VX * (0.7 + skill * 0.5);
  if (Math.abs(bot.vx) > maxSpeed) bot.vx = Math.sign(bot.vx) * maxSpeed;
  bot.x += bot.vx;
  
  // Wall bounce with recovery
  if (bot.x < PLAYER_RADIUS) { bot.x = PLAYER_RADIUS; bot.vx = Math.abs(bot.vx) * 0.6; }
  if (bot.x > canvasW - PLAYER_RADIUS) { bot.x = canvasW - PLAYER_RADIUS; bot.vx = -Math.abs(bot.vx) * 0.6; }
}

export function dropAttack(g: GameState, x: number, canvasW: number) {
  if (g.attackerEnergy < ATTACKER_DROP_COST || g.attackerDropCooldown > 0) return false;
  g.attackerEnergy -= ATTACKER_DROP_COST;
  g.attackerDropCooldown = 15; // 0.25s local cooldown (4 drops per sec)
  const obs = spawnObstacleAtX(Math.max(20, Math.min(x, canvasW - 20)));
  g.obstacles.push(obs);
  g.spawns.push({ x, y: 0, life: 1, color: COLOR_ATTACKER });
  playSound('tap_drop');
  return obs;
}

export function useAbility(
  g: GameState,
  ability: 'SWARM' | 'EMP' | 'FIREWALL',
  canvasW: number,
  canvasH: number,
  cb: TickCallbacks
): Obstacle[] | false {
  const cost = ABILITY_COST[ability];
  if (g.attackerEnergy < cost) return false;
  g.attackerEnergy -= cost;
  cb.onEnergyUpdate(g.attackerEnergy);
  const newObs: Obstacle[] = [];
  switch (ability) {
    case 'SWARM': {
      for (let i = 0; i < 5; i++) {
        const o = spawnRandomObstacle(canvasW, 1);
        o.color = '#ff3300';
        o.width = 22;
        o.height = 22;
        g.obstacles.push(o);
        newObs.push(o);
      }
      playSound('swarm');
      floatText(g, canvasW / 2, 80, 'SWARM!', '#ff3300', 24);
      break;
    }
    case 'EMP': {
      g.powerUpTimers.slow = 180;
      playSound('emp');
      floatText(g, canvasW / 2, 80, 'EMP BLAST!', '#ff0055', 26);
      explosion(g, canvasW / 2, canvasH / 2, '#ff0055', 40);
      break;
    }
    case 'FIREWALL': {
      const cols = 7;
      const w = (canvasW / cols) - 4;
      const gap = Math.floor(cols / 2);
      for (let i = 0; i < cols; i++) {
        if (i === gap) continue;
        const o: Obstacle = {
          id: nanoid(8),
          x: i * (canvasW / cols) + 2,
          y: -60,
          width: w,
          height: 28,
          color: '#ff0055',
          type: 'GATE',
          vx: 0,
          nearMissTriggered: false,
          rotation: 0,
          rotationSpeed: 0,
          gravityMultiplier: 1.0,
        };
        g.obstacles.push(o);
        newObs.push(o);
      }
      playSound('firewall');
      floatText(g, canvasW / 2, 80, 'FIREWALL!', '#ff0055', 26);
      break;
    }
  }
  return newObs;
}

function applyPowerUp(
  g: GameState,
  pu: PowerUp,
  canvasW: number,
  canvasH: number,
  cb: TickCallbacks
) {
  playSound('powerup');
  const pt = g.powerUpTimers;
  let displayLabel = pu.type as string;
  let labelColor = '#ffff00';
  switch (pu.type) {
    case 'SHIELD':
      pt.shield = POWERUP_DURATION;
      labelColor = '#00f2ff';
      displayLabel = '🛡 SHIELD';
      break;
    case 'FIRE':
      pt.fire = POWERUP_DURATION;
      labelColor = '#ff6600';
      displayLabel = '🔥 FIRE';
      break;
    case 'HIDE':
      pt.hide = POWERUP_DURATION;
      labelColor = '#ffffff';
      displayLabel = '👁 CLOAK';
      break;
    case 'SLOW':
      pt.slow = POWERUP_DURATION;
      labelColor = '#00ffcc';
      displayLabel = '❄ SLOW';
      break;
    case 'MAGNET':
      pt.magnet = POWERUP_DURATION;
      labelColor = '#ff3333';
      displayLabel = '🧲 MAGNET';
      break;
    case 'TIME_STOP':
      pt.timeStop = 180;
      labelColor = '#9900ff';
      displayLabel = '⏸ STOP';
      break;
    case 'COIN':
      addScore(g, SCORE_POWERUP_COIN, cb.onScoreUpdate);
      labelColor = '#ffcc00';
      displayLabel = `+${SCORE_POWERUP_COIN}`;
      playSound('collect');
      break;
    case 'BOOST':
      pt.boost = POWERUP_DURATION;
      labelColor = '#ff00ff';
      displayLabel = '⚡ BOOST';
      playSound('boost_activate');
      break;
    // RECALL is a special asset, not a standard power-up pickup — handled in tick()
    case 'RECALL':
      labelColor = '#00ff88';
      displayLabel = '📡 RECALL';
      break;
  }
  floatText(g, pu.x, pu.y, displayLabel, labelColor, 16);
  sparks(g, pu.x, pu.y, labelColor);
}

function addScore(g: GameState, amount: number, onScoreUpdate: (s: number) => void) {
  g.score += amount;
  onScoreUpdate(g.score);
}

function triggerGameOver(g: GameState, result: WinResult, cb: TickCallbacks) {
  if (g.isGameOver) return;
  g.isGameOver = true;
  g.winResult = result;
  stopAmbient();
  if (result === 'ESCAPERS_WIN' || result === 'TIME_EXPIRED') {
    playSound('victory');
  } else {
    playSound('defeat');
  }
  cb.onGameOver(result, g.score);
}

function circleRectHit(cx: number, cy: number, r: number, rect: Obstacle): boolean {
  // Transform circle center into the obstacle's local (rotated) coordinate space
  if (rect.rotation) {
    const ocx = rect.x + rect.width / 2;
    const ocy = rect.y + rect.height / 2;
    const cos = Math.cos(-rect.rotation);
    const sin = Math.sin(-rect.rotation);
    const dx = cx - ocx;
    const dy = cy - ocy;
    const localX = ocx + dx * cos - dy * sin;
    const localY = ocy + dx * sin + dy * cos;
    const nearX = Math.max(rect.x, Math.min(localX, rect.x + rect.width));
    const nearY = Math.max(rect.y, Math.min(localY, rect.y + rect.height));
    const ndx = localX - nearX;
    const ndy = localY - nearY;
    return ndx * ndx + ndy * ndy < r * r;
  }
  const nearX = Math.max(rect.x, Math.min(cx, rect.x + rect.width));
  const nearY = Math.max(rect.y, Math.min(cy, rect.y + rect.height));
  const dx = cx - nearX;
  const dy = cy - nearY;
  return dx * dx + dy * dy < r * r;
}

// ── Exports for server-driven events ─────────────────────────────────────────
export function receiveObstacle(g: GameState, obs: Obstacle) {
  // Ensure new physics fields have defaults (server may not send them)
  g.obstacles.push({
    ...obs,
    rotation: obs.rotation ?? 0,
    rotationSpeed: obs.rotationSpeed ?? (Math.random() - 0.5) * 0.03,
    gravityMultiplier: obs.gravityMultiplier ?? 1.0,
  });
  g.spawns.push({ x: obs.x + obs.width / 2, y: 0, life: 1, color: COLOR_ATTACKER });
}

export function receiveAbility(g: GameState, ability: 'SWARM' | 'EMP' | 'FIREWALL', canvasW: number, canvasH: number) {
  // CONCEPT FIX: handle ALL abilities, not just EMP
  switch (ability) {
    case 'EMP': {
      g.powerUpTimers.slow = 200;
      g.shake = 15;
      g.glitchTimer = 20;
      floatText(g, canvasW / 2, canvasH / 2, 'EMP BLAST!', '#ff0055', 26);
      explosion(g, canvasW / 2, canvasH / 2, '#ff0055', 40);
      playSound('emp');
      break;
    }
    case 'SWARM': {
      // Spawn a burst of small fast obstacles
      for (let i = 0; i < 5; i++) {
        const o = spawnRandomObstacle(canvasW, 1);
        o.color = '#ff3300';
        o.width = 22;
        o.height = 22;
        o.gravityMultiplier = 1.3 + Math.random() * 0.4; // fast fallers
        g.obstacles.push(o);
      }
      g.shake = 10;
      floatText(g, canvasW / 2, 80, '⚠ SWARM INCOMING!', '#ff3300', 24);
      playSound('swarm');
      break;
    }
    case 'FIREWALL': {
      const cols = 7;
      const w = (canvasW / cols) - 4;
      const gap = Math.floor(Math.random() * cols); // random gap position
      for (let i = 0; i < cols; i++) {
        if (i === gap) continue;
        const o: Obstacle = {
          id: nanoid(8),
          x: i * (canvasW / cols) + 2,
          y: -60,
          width: w,
          height: 28,
          color: '#ff0055',
          type: 'GATE',
          vx: 0,
          nearMissTriggered: false,
          rotation: 0,
          rotationSpeed: 0,
          gravityMultiplier: 1.0,
        };
        g.obstacles.push(o);
      }
      g.shake = 12;
      floatText(g, canvasW / 2, 80, '⚠ FIREWALL!', '#ff0055', 26);
      playSound('firewall');
      break;
    }
  }
}

export function markRemotePlayerEliminated(g: GameState, escaperId: string) {
  const p = g.remotePlayers.find(r => r.id === escaperId);
  if (p) {
    p.isDefeated = true;
    p.isSpectating = true;
    explosion(g, p.x, p.y, '#ff0055', 25);
    playSound('hit');
  }
}

export function recallRemotePlayer(g: GameState, escaperId: string) {
  const p = g.remotePlayers.find(r => r.id === escaperId);
  if (p) {
    p.isDefeated = false;
    p.isSpectating = false;
    p.x = g.playerX + (Math.random() - 0.5) * 80;
    p.y = g.playerY;
    sparks(g, p.x, p.y, '#00ff88');
    floatText(g, p.x, p.y - 40, `${p.name} RECALLED!`, '#00ff88', 16);
    playSound('powerup');
  }
}

export function recallSelf(g: GameState, canvasW: number, canvasH: number) {
  // Called when server confirms the local player has been recalled
  g.isSpectating = false;
  g.playerX = canvasW / 2 + (Math.random() - 0.5) * 100;
  g.playerY = canvasH - 120;
  g.playerVx = 0;
  g.playerVy = 0;
  sparks(g, g.playerX, g.playerY, '#00ff88');
  floatText(g, g.playerX, g.playerY - 50, '⚡ RECALLED!', '#00ff88', 22);
  playSound('powerup');
}

export function triggerOnlineGameOver(g: GameState, result: WinResult, cb: TickCallbacks) {
  triggerGameOver(g, result, cb);
}
