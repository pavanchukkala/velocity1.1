import { useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import type { Role, RoomMode, RemotePlayer, WinResult, Obstacle } from '../../types';
import {
  makeInitialGameState, tick, dropAttack, useAbility,
  receiveObstacle, receiveAbility, markRemotePlayerEliminated,
  recallRemotePlayer, recallSelf, triggerOnlineGameOver,
  type RecallAsset,
} from '../../utils/engine';
import {
  drawSpeedLines, drawParticles, drawTrails, drawObstacle,
  drawPowerUp, drawEscaper, drawBotEscaper, drawRemoteEscaper, drawRemoteAttacker,
  drawAttackerBody, drawRecallAsset,
  drawAttackerCursor, drawReticle, drawFloatingTexts, drawSpawnFlashes,
  drawGlitch, drawEdgeDangerVignette, drawLevelFlash,
} from '../../utils/renderer';
import { HUD } from '../HUD/HUD';
import { startAmbient } from '../../utils/audio';
import { PLAYER_RADIUS, SCREEN_EDGE_DANGER_ZONE } from '../../constants';
import { getDeviceProfile } from '../../utils/responsive';

interface Props {
  dimensions: { width: number; height: number };
  role: Role;
  mode: RoomMode;
  roomId: string;
  playerName: string;
  socket: Socket | null;
  remotePlayers: RemotePlayer[];
  teamSize: number;
  isHost: boolean;
  onGameOver: (result: WinResult, score: number) => void;
  onScoreUpdate: (s: number) => void;
  onLevelUpdate: (l: number) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  score: number;
  level: number;
}

export function GameCanvas({
  dimensions, role, mode, roomId, playerName,
  socket, remotePlayers, teamSize, isHost, onGameOver, onScoreUpdate, onLevelUpdate,
  isFullscreen, onToggleFullscreen,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const dimRef    = useRef(dimensions);
  const socketRef = useRef(socket);
  const roomIdRef = useRef(roomId);
  const cbRef     = useRef({ onGameOver, onScoreUpdate, onLevelUpdate });
  const teamSizeRef = useRef(teamSize);

  dimRef.current    = dimensions;
  socketRef.current = socket;
  roomIdRef.current = roomId;
  cbRef.current     = { onGameOver, onScoreUpdate, onLevelUpdate };
  teamSizeRef.current = teamSize;
  const isHostRef   = useRef(isHost);
  isHostRef.current = isHost;
  const roleRef     = useRef(role);
  roleRef.current   = role;

  // Recall assets live here — mutated by socket events and engine pickup
  const recallAssetsRef = useRef<RecallAsset[]>([]);
  // Is the local player spectating?
  const isSpectatingRef = useRef(false);

  // Game state — created ONCE, never recreated
  const gRef = useRef(
    makeInitialGameState(dimensions.width, dimensions.height, role, mode, 0, playerName)
  );

  // HUD ref — loop writes it, HUD React component polls it every 100ms
  const hudRef = useRef({
    score: 0, level: 1, combo: 0, multiplier: 1,
    energy: 20, timerSeconds: role === 'ATTACKER' ? 60 : 90,
    shieldActive: false, fireActive: false, hideActive: false,
    slowActive: false, magnetActive: false, timeStopActive: false, boostActive: false,
    shieldTimer: 0, fireTimer: 0, hideTimer: 0, slowTimer: 0,
    magnetTimer: 0, timeStopTimer: 0, boostTimer: 0,
    isSpectating: false,
    teamSize: teamSize,
  });

  // Sync remote players
  useEffect(() => {
    gRef.current.remotePlayers = remotePlayers.map(p => ({ ...p }));
  }, [remotePlayers]);

  // Sync canvas size when dimensions change — update game state but do NOT restart loop
  useEffect(() => {
    const g = gRef.current;
    const oldH = g.playerY > 0 ? (g.playerY + 80) : dimensions.height; // approximate old height
    const scaleX = dimensions.width / (dimRef.current.width || dimensions.width);
    const scaleY = dimensions.height / (dimRef.current.height || dimensions.height);
    g.playerX = Math.max(PLAYER_RADIUS, Math.min(dimensions.width - PLAYER_RADIUS, g.playerX * scaleX));
    g.playerY = Math.max(200, Math.min(dimensions.height - PLAYER_RADIUS, g.playerY * scaleY));
    g.bots.forEach(b => {
      b.x = Math.max(PLAYER_RADIUS, Math.min(dimensions.width - PLAYER_RADIUS, b.x * scaleX));
      b.y = Math.max(200, Math.min(dimensions.height - PLAYER_RADIUS, b.y * scaleY));
    });
    const canvas = canvasRef.current;
    if (canvas) {
      // DPI-aware: render at device-profile-aware DPR for crisp visuals
      const dpr = getDeviceProfile().renderDpr;
      canvas.width  = Math.round(dimensions.width * dpr);
      canvas.height = Math.round(dimensions.height * dpr);
      canvas.style.width  = dimensions.width + 'px';
      canvas.style.height = dimensions.height + 'px';
    }
  }, [dimensions]);

  // Keyboard — registered once
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      gRef.current.keys[e.key] = true;
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key))
        e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { gRef.current.keys[e.key] = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // Pause game when tab is hidden to prevent physics accumulation
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        // Pause: clear all keys to stop movement
        gRef.current.keys = {};
        gRef.current.touchX = null;
        gRef.current.touchY = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Touch / mouse — registered once (role never changes mid-game)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getXY = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (dimRef.current.width / rect.width),
        y: (clientY - rect.top) * (dimRef.current.height / rect.height),
      };
    };

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      const { x, y } = getXY(e.touches[0].clientX, e.touches[0].clientY);
      if (role === 'ESCAPER') {
        gRef.current.touchX = x;
        gRef.current.touchY = y;
      } else {
        dropAttack(gRef.current, x, dimRef.current.width);
        // Normalize x to 0-1 for cross-device sync
        socketRef.current?.emit('drop-attack', { roomId: roomIdRef.current, x: x / dimRef.current.width });
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (role === 'ESCAPER') {
        const { x, y } = getXY(e.touches[0].clientX, e.touches[0].clientY);
        gRef.current.touchX = x;
        gRef.current.touchY = y;
      }
    };
    const onTouchEnd = () => {
      if (role === 'ESCAPER') {
        gRef.current.touchX = null;
        gRef.current.touchY = null;
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (role === 'ATTACKER') {
        const { x } = getXY(e.clientX, e.clientY);
        dropAttack(gRef.current, x, dimRef.current.width);
        // Normalize x to 0-1 for cross-device sync
        socketRef.current?.emit('drop-attack', { roomId: roomIdRef.current, x: x / dimRef.current.width });
      }
    };

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
    canvas.addEventListener('touchend',   onTouchEnd);
    canvas.addEventListener('mousedown',  onMouseDown);
    return () => {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove',  onTouchMove);
      canvas.removeEventListener('touchend',   onTouchEnd);
      canvas.removeEventListener('mousedown',  onMouseDown);
    };
  }, [role]);

  // Socket — only re-register if socket instance changes
  useEffect(() => {
    if (!socket) return;

    const onPlayerMoved = ({ id, nx, ny, vx, isShielded, isFiring, isHidden }: {
      id: string; nx: number; ny: number; vx: number;
      isShielded: boolean; isFiring: boolean; isHidden: boolean;
    }) => {
      const p = gRef.current.remotePlayers.find(r => r.id === id);
      if (p) {
        // Denormalize: convert 0-1 normalized coords to local canvas pixels
        const w = dimRef.current.width;
        const h = dimRef.current.height;
        p.x = nx * w;
        p.y = ny * h;
        p.vx = vx * w / 800; // scale velocity proportionally
        p.isShielded = isShielded; p.isFiring = isFiring; p.isHidden = isHidden;
      }
    };

    const onAttackDropped = ({ obstacle }: { obstacle: Obstacle }) => {
      // Denormalize obstacle position to local canvas size
      const w = dimRef.current.width;
      const h = dimRef.current.height;
      const localObs = { ...obstacle, x: obstacle.x * w, y: obstacle.y * h, width: obstacle.width * w, height: obstacle.height * h };
      receiveObstacle(gRef.current, localObs);
    };

    const onAbilityUsed = ({ ability }: { ability: 'SWARM' | 'EMP' | 'FIREWALL' }) =>
      receiveAbility(gRef.current, ability, dimRef.current.width, dimRef.current.height);

    const onEscaperEliminated = ({ escaperId }: { escaperId: string }) =>
      markRemotePlayerEliminated(gRef.current, escaperId);

    const onRecallAssetSpawned = ({ id, x, recallTargetId }: { id: string; x: number; recallTargetId: string }) => {
      // Denormalize x from 0-1 to local canvas pixels, then add recall asset
      const localX = x * dimRef.current.width;
      recallAssetsRef.current.push({ id, x: localX, y: -40, recallTargetId, life: 1500 });
    };

    const onEscaperRecalled = ({ escaperId }: { escaperId: string }) => {
      const g = gRef.current;
      if (escaperId === socketRef.current?.id) {
        // Local player recalled
        recallSelf(g, dimRef.current.width, dimRef.current.height);
        isSpectatingRef.current = false;
        g.isSpectating = false;
      } else {
        recallRemotePlayer(g, escaperId);
      }
      // Remove recall asset for this player from the list
      recallAssetsRef.current = recallAssetsRef.current.filter(r => r.recallTargetId !== escaperId);
    };

    const onGameEnd = ({ result }: { result: WinResult }) =>
      triggerOnlineGameOver(gRef.current, result, {
        onScoreUpdate: (s) => cbRef.current.onScoreUpdate(s),
        onLevelUpdate: (l) => cbRef.current.onLevelUpdate(l),
        onComboUpdate: () => {},
        onEnergyUpdate: () => {},
        onTimerUpdate: () => {},
        onGameOver: (r, s) => cbRef.current.onGameOver(r, s),
      });

    // Attacker scoring: points awarded when a real player is eliminated
    const onAttackerScored = ({ points }: { points: number }) => {
      if (roleRef.current === 'ATTACKER') {
        const g = gRef.current;
        g.score += points;
        g.attackerKillStreak = (g.attackerKillStreak || 0) + 1;
        hudRef.current.score = g.score;
        cbRef.current.onScoreUpdate(g.score);
        // Kill streak feedback
        const streak = g.attackerKillStreak;
        const label = streak >= 3 ? 'CYBER MASSACRE!' : streak >= 2 ? 'DOUBLE BREACH!' : 'BREACH!';
        const w = dimRef.current.width;
        const h = dimRef.current.height;
        g.floatingTexts.push({ id: 'kill-' + streak, x: w / 2, y: h * 0.3, text: label, life: 1, maxLife: 1, color: '#ff0055', size: 32 });
        g.shake = Math.min(50, 25 + streak * 10);
      }
    };

    socket.on('player-moved',         onPlayerMoved);
    socket.on('attack-dropped',        onAttackDropped);
    socket.on('ability-used',          onAbilityUsed);
    socket.on('escaper-eliminated',    onEscaperEliminated);
    socket.on('recall-asset-spawned',  onRecallAssetSpawned);
    socket.on('escaper-recalled',      onEscaperRecalled);
    socket.on('game-end',              onGameEnd);
    socket.on('attacker-scored',       onAttackerScored);

    return () => {
      socket.off('player-moved',         onPlayerMoved);
      socket.off('attack-dropped',       onAttackDropped);
      socket.off('ability-used',         onAbilityUsed);
      socket.off('escaper-eliminated',   onEscaperEliminated);
      socket.off('recall-asset-spawned', onRecallAssetSpawned);
      socket.off('escaper-recalled',     onEscaperRecalled);
      socket.off('game-end',             onGameEnd);
      socket.off('attacker-scored',      onAttackerScored);
    };
  }, [socket]);

  // Ability buttons (attacker HUD) — stable forever
  const triggerAbility = useCallback((ability: 'SWARM' | 'EMP' | 'FIREWALL') => {
    const result = useAbility(gRef.current, ability, dimRef.current.width, dimRef.current.height, {
      onScoreUpdate: (s) => cbRef.current.onScoreUpdate(s),
      onLevelUpdate: (l) => cbRef.current.onLevelUpdate(l),
      onComboUpdate: () => {},
      onEnergyUpdate: (e) => { hudRef.current.energy = e; },
      onTimerUpdate: () => {},
      onGameOver: (r, s) => cbRef.current.onGameOver(r, s),
    });
    if (result) socketRef.current?.emit('use-ability', { roomId: roomIdRef.current, ability });
  }, []);

  // THE GAME LOOP — empty deps = created ONCE, lives until component unmounts
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    startAmbient();

    // Throttle React state callbacks — onScoreUpdate/onLevelUpdate call setState in parent
    // which causes parent re-render. We only need this for the GameOver screen to show
    // final score. HUD reads hudRef directly so it doesn't need React state at all.
    let lastScoreNotify  = 0;
    let lastLevelNotify  = 0;

    let rafId: number;

    const FIXED_DT = 1000 / 60; // 16.67ms per tick — locked to 60fps logic
    let accumulator = 0;
    let lastTime = 0;

    const loop = (timestamp: number) => {
      if (lastTime === 0) lastTime = timestamp;
      const elapsed = Math.min(timestamp - lastTime, 100); // cap to prevent spiral of death
      lastTime = timestamp;
      accumulator += elapsed;

      const g  = gRef.current;
      const w  = dimRef.current.width;
      const h  = dimRef.current.height;
      const pt = g.powerUpTimers;

      // Run physics at fixed 60fps regardless of display refresh rate
      while (accumulator >= FIXED_DT) {
        accumulator -= FIXED_DT;

      // Logic
      tick(g, w, h, role, mode, {
        onScoreUpdate: (s) => {
          hudRef.current.score = s;
          if (timestamp - lastScoreNotify > 500) {
            lastScoreNotify = timestamp;
            cbRef.current.onScoreUpdate(s);
          }
        },
        onLevelUpdate: (l) => {
          hudRef.current.level = l;
          if (timestamp - lastLevelNotify > 1000) {
            lastLevelNotify = timestamp;
            cbRef.current.onLevelUpdate(l);
          }
        },
        onComboUpdate: (c, m) => {
          hudRef.current.combo = c;
          hudRef.current.multiplier = m;
        },
        onEnergyUpdate: (e) => { hudRef.current.energy = e; },
        onTimerUpdate:  (s) => { hudRef.current.timerSeconds = s; },
        onGameOver: (result, finalScore) => {
          hudRef.current.score = finalScore;
          cbRef.current.onScoreUpdate(finalScore);
          cbRef.current.onGameOver(result, finalScore);
        },
        onPlayerSpectating: () => {
          isSpectatingRef.current = true;
          if (mode !== 'OFFLINE') {
            socketRef.current?.emit('game-over-report', {
              roomId: roomIdRef.current,
              escaperId: socketRef.current?.id,
            });
          }
        },
        onPlayerEliminated: (playerId) => {
          // Bot teammate was hit — report to server
          if (mode !== 'OFFLINE') {
            socketRef.current?.emit('game-over-report', {
              roomId: roomIdRef.current,
              escaperId: playerId,
            });
          }
        },
        onRecallUsed: (recallTargetId) => {
          socketRef.current?.emit('recall-teammate', {
            roomId: roomIdRef.current, recallTargetId,
          });
        },
        emitMove: (x, y, vx, vy, states) => {
          if (g.frameCount % 3 === 0) {
            // Normalize to 0-1 range for cross-device sync
            const nx = x / w;
            const ny = y / h;
            const nvx = vx / w * 800; // normalize velocity
            socketRef.current?.emit('player-move', {
              roomId: roomIdRef.current, x: nx, y: ny, vx: nvx, vy, powerUpStates: states,
            });
          }
        },
        emitBotMove: (botId, x, y, vx, vy) => {
          if (g.frameCount % 4 === 0 && isHostRef.current) {
            // Normalize to 0-1 range
            const nx = x / w;
            const ny = y / h;
            const nvx = vx / w * 800;
            socketRef.current?.emit('bot-move', {
              roomId: roomIdRef.current, botId, x: nx, y: ny, vx: nvx, vy,
            });
          }
        },
        emitBotDrop: (botId, x) => {
          if (isHostRef.current)
            socketRef.current?.emit('bot-drop', {
              // Normalize x to 0-1
              roomId: roomIdRef.current, botId, x: x / w,
            });
        },
      }, recallAssetsRef.current, teamSizeRef.current);

      // Age recall assets (move them down with world, expire them)
      for (let i = recallAssetsRef.current.length - 1; i >= 0; i--) {
        const ra = recallAssetsRef.current[i];
        ra.y += g.worldSpeed * 0.4; // drifts down slowly
        ra.life--;
        if (ra.life <= 0 || ra.y > h + 60) recallAssetsRef.current.splice(i, 1);
      }

      } // end fixed timestep while loop

      // Sync HUD power-up state
      hudRef.current.shieldActive   = pt.shield    > 0;
      hudRef.current.fireActive     = pt.fire      > 0;
      hudRef.current.hideActive     = pt.hide      > 0;
      hudRef.current.slowActive     = pt.slow      > 0;
      hudRef.current.magnetActive   = pt.magnet    > 0;
      hudRef.current.timeStopActive = pt.timeStop  > 0;
      hudRef.current.boostActive    = pt.boost     > 0;
      hudRef.current.shieldTimer    = pt.shield;
      hudRef.current.fireTimer      = pt.fire;
      hudRef.current.hideTimer      = pt.hide;
      hudRef.current.slowTimer      = pt.slow;
      hudRef.current.magnetTimer    = pt.magnet;
      hudRef.current.timeStopTimer  = pt.timeStop;
      hudRef.current.boostTimer     = pt.boost;
      hudRef.current.isSpectating   = isSpectatingRef.current;
      hudRef.current.teamSize       = teamSizeRef.current;

      // Draw
      ctx.save();
      // DPI scaling — draw in CSS-pixel coordinates on a HiDPI backing store
      const dpr = canvas.width / w;
      ctx.scale(dpr, dpr);
      if (g.shake > 1)
        ctx.translate((Math.random() - 0.5) * g.shake, (Math.random() - 0.5) * g.shake);

      ctx.fillStyle = 'rgba(5,5,5,0.92)';
      ctx.fillRect(0, 0, w, h);

      drawSpeedLines(ctx, g.speedLines);
      drawSpawnFlashes(ctx, g.spawns);
      drawTrails(ctx, g.trails);
      g.obstacles.forEach(obs => drawObstacle(ctx, obs, g.frameCount, pt.timeStop > 0));
      if (role === 'ESCAPER') g.powerUps.forEach(pu => drawPowerUp(ctx, pu, g.frameCount));

      // Recall assets — visible to escapers (so they can pick them up)
      if (role === 'ESCAPER') {
        recallAssetsRef.current.forEach(ra => drawRecallAsset(ctx, ra, g.frameCount));
      }

      drawParticles(ctx, g.particles);
      g.remotePlayers.forEach(p => {
        if (p.id === socketRef.current?.id) return;
        if (p.role === 'ESCAPER') drawRemoteEscaper(ctx, p, g.frameCount);
        else drawRemoteAttacker(ctx, p, g.frameCount);
      });
      g.bots.forEach(bot => drawBotEscaper(ctx, bot, g.frameCount));

      // Local escaper (only if not spectating)
      if (role === 'ESCAPER' && !isSpectatingRef.current) {
        drawEscaper(ctx, g.playerX, g.playerY, g.playerColor, g.playerVx, g.frameCount, 'YOU', false, {
          isShielded: pt.shield > 0, isFiring: pt.fire > 0, isHidden: pt.hide > 0,
          isSlowed: pt.slow > 0, isMagnetized: pt.magnet > 0,
          isTimeStopped: pt.timeStop > 0, isBoosted: pt.boost > 0,
        });
      }

      // Local attacker physical body (ONLINE/LOCAL)
      if (role === 'ATTACKER' && mode !== 'OFFLINE') {
        drawAttackerBody(ctx, g.attackerX, g.attackerVx, g.frameCount, 'YOU');
      }

      drawFloatingTexts(ctx, g.floatingTexts);
      drawGlitch(ctx, canvas, g.glitchTimer, w, h);

      // Edge danger red vignette (escaper only)
      if (role === 'ESCAPER' && !isSpectatingRef.current) {
        drawEdgeDangerVignette(ctx, g.playerX, w, h, SCREEN_EDGE_DANGER_ZONE);
      }

      // Level-up flash overlay
      if (g.levelFlashTimer > 0) {
        drawLevelFlash(ctx, w, h, g.levelFlashTimer, 30);
      }

      // Spectate indicator — subtle top bar, NO screen dimming
      // Player can fully watch teammates play
      if (isSpectatingRef.current) {
        // Top status bar
        const barH = 36;
        ctx.fillStyle = 'rgba(255,0,85,0.85)';
        ctx.fillRect(0, 0, w, barH);
        // Gradient fade at bottom edge
        const grad = ctx.createLinearGradient(0, barH - 6, 0, barH + 8);
        grad.addColorStop(0, 'rgba(255,0,85,0.3)');
        grad.addColorStop(1, 'rgba(255,0,85,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, barH - 6, w, 14);
        // Text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 13px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const hasRecall = recallAssetsRef.current.some(r => r.recallTargetId === socketRef.current?.id);
        ctx.fillText(
          hasRecall ? '📡 ELIMINATED — Recall token is live! Teammate can save you!' : '💀 ELIMINATED — Watching teammates… waiting for recall',
          w / 2, barH / 2
        );
      }

      ctx.restore();

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []); // EMPTY — loop never restarts. All runtime values via refs.

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="game-canvas absolute inset-0"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      <HUD
        hudRef={hudRef}
        role={role}
        mode={mode}
        teamSize={teamSize}
        onTriggerAbility={triggerAbility}
        isFullscreen={isFullscreen}
        onToggleFullscreen={onToggleFullscreen}
      />
    </div>
  );
}
