// ─── Virtual Canvas ───────────────────────────────────────────────────────────
export const VIRTUAL_W = 800;
export const VIRTUAL_H = 1000;

// ─── Player Physics ───────────────────────────────────────────────────────────
export const PLAYER_RADIUS = 18;
export const ACCEL = 1.6;
export const FRICTION = 0.88;
export const MAX_VX = 18;

// ─── World Speed ──────────────────────────────────────────────────────────────
export const INITIAL_SPEED = 12;
export const SPEED_RAMP = 0.0018;      // added per frame always
export const LEVEL_SPEED_BONUS = 2.0;  // added per level-up

// ─── Obstacle Spawning ────────────────────────────────────────────────────────
export const BASE_SPAWN_INTERVAL = 48;  // frames between auto-spawns (offline escaper)
export const MIN_SPAWN_INTERVAL  = 12;
export const BOSS_SPAWN_INTERVAL = 20;

// ─── Bot AI ───────────────────────────────────────────────────────────────────
export const BOT_ACCEL         = 1.1;
export const BOT_FRICTION      = 0.85;
export const BOT_EVADE_DIST    = 250;   // px — when to start evading (faster speed needs longer evade dist)
export const BOT_REACTION_MIN  = 4;     // frames before bot reacts (easy)
export const BOT_REACTION_MAX  = 18;    // frames before bot reacts (hard)
// Offline attacker mode: bot escaper gets harder per level
export const BOT_SKILL_PER_LVL = 0.12; // 0–1 scale added per level

// Bot attacker (offline escaper mode): drop interval in frames
export const BOT_ATTACK_INTERVAL_BASE = 50;
export const BOT_ATTACK_INTERVAL_MIN  = 15;

// ─── Online Match ─────────────────────────────────────────────────────────────
export const MATCH_DURATION_SECONDS = 90;
export const TEAM_SIZE = 2; // default; overridden at runtime by lobby selection

// ─── Recall Asset ─────────────────────────────────────────────────────────────
export const RECALL_SPAWN_CHANCE_EARLY = 1.0;   // guaranteed first elimination
export const RECALL_SPAWN_CHANCE_MID   = 0.55;  // 55% mid-game
export const RECALL_SPAWN_CHANCE_LATE  = 0.30;  // 30% late game
export const RECALL_ASSET_SIZE = 26;

// ─── Attacker Physical Body (online / local) ──────────────────────────────────
export const ATTACKER_RADIUS          = 20;
export const ATTACKER_ACCEL           = 1.4;
export const ATTACKER_FRICTION        = 0.86;
export const ATTACKER_MAX_VX          = 16;
export const ATTACKER_BUMP_FORCE      = 8;
export const ATTACKER_PUSH_THRESHOLD  = 44;
export const BOT_FILL_COLOR_POOL = [
  '#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c77dff',
  '#ff9f1c','#2ec4b6','#e71d36','#011627',
];

// ─── Scoring ──────────────────────────────────────────────────────────────────
export const SCORE_SURVIVE_PER_FRAME   = 1;
export const SCORE_NEAR_MISS           = 25;
export const SCORE_OBSTACLE_CLEARED    = 40;
export const SCORE_POWERUP_COIN        = 500;
export const SCORE_ATTACKER_HIT_BOT    = 600;
export const SCORE_ATTACKER_HIT_REAL   = 1200; // awarded when attacker eliminates real player online
export const SCORE_LEVEL_UP_BONUS      = 200;  // awarded on each level up
export const COMBO_TIMEOUT_FRAMES      = 120;

// ─── Power-Ups ────────────────────────────────────────────────────────────────
export const POWERUP_SPAWN_INTERVAL = 280; // frames
export const POWERUP_DURATION       = 300; // frames (~5s)
export const POWERUP_COIN_DURATION  = 1;   // immediate
export const MAGNET_ATTRACT_RADIUS  = 220;
export const MAGNET_FORCE           = 0.055;
export const SHIELD_BLOCK_HITS      = 1;

// ─── Attacker ─────────────────────────────────────────────────────────────────
export const ATTACKER_ENERGY_REGEN    = 0.15;  // per frame
export const ATTACKER_ENERGY_MAX      = 100;
export const ATTACKER_DROP_COST       = 5;
export const ABILITY_COST: Record<string, number> = {
  SWARM:    18,
  EMP:      30,
  FIREWALL: 45,
};
export const ATTACKER_OFFLINE_DURATION_S = 60; // seconds for solo attacker

// ─── Levels ───────────────────────────────────────────────────────────────────
export const SCORE_PER_LEVEL = 1800;

// ─── Near-Miss ────────────────────────────────────────────────────────────────
export const NEAR_MISS_THRESHOLD = 52; // px from obstacle edge

// ─── Particles ────────────────────────────────────────────────────────────────
export const EXPLOSION_PARTICLE_COUNT = 28;
export const SPARK_PARTICLE_COUNT     = 12;

// ─── Colors ───────────────────────────────────────────────────────────────────
export const COLOR_ESCAPER   = '#00ff88';
export const COLOR_ATTACKER  = '#ff0055';
export const COLOR_OBSTACLE  = '#ff0055';
export const COLOR_OBSTACLE2 = '#ff6600';
export const COLOR_BOSS_OBS  = '#ffcc00';
export const COLOR_ACCENT    = '#00f2ff';
export const COLOR_BG        = '#050505';

// ─── Enhanced Physics ─────────────────────────────────────────────────────────
export const GRAVITY             = 0.22;       // pulls player downward
export const VERTICAL_ACCEL      = 1.4;        // up/down movement acceleration
export const MAX_VY              = 16;         // max vertical speed
export const PLAYER_MIN_Y_OFFSET = 200;        // min distance from top

// ─── Dash Mechanic ────────────────────────────────────────────────────────────
export const DASH_SPEED              = 32;      // burst speed during dash
export const DASH_DURATION_FRAMES    = 8;       // how long dash lasts
export const DASH_COOLDOWN_FRAMES    = 75;      // 1.25s cooldown
export const DASH_INVINCIBILITY      = 8;       // i-frames during dash
export const DASH_TRAIL_MULTIPLIER   = 4;       // trail intensity during dash

// ─── Bullet Time ──────────────────────────────────────────────────────────────
export const BULLET_TIME_DURATION    = 60;      // frames of slow-mo (increased)
export const BULLET_TIME_SPEED_MULT  = 0.2;     // world speed multiplier
export const BULLET_TIME_THRESHOLD   = 2;       // near-misses needed (lowered for easier activation)
export const BULLET_TIME_WINDOW      = 90;      // frames window (tighter)

// ─── Obstacle Enhancements ────────────────────────────────────────────────────
export const OBSTACLE_MIN_ROTATION   = -0.04;   // rad/frame
export const OBSTACLE_MAX_ROTATION   = 0.04;
export const OBSTACLE_GRAVITY_BASE   = 1.0;     // multiplier
export const OBSTACLE_GRAVITY_VARIANCE = 0.4;   // ± variance

// ─── Screen Edge Danger ───────────────────────────────────────────────────────
export const SCREEN_EDGE_DANGER_ZONE = 50;      // px from edge
export const SCREEN_EDGE_PUSH_FORCE  = 0.15;    // force pushing away from edge

// ─── Ghost Mode (Near-Miss Streak) ────────────────────────────────────────────
export const GHOST_MODE_NEAR_MISS_COUNT = 3;    // near-misses needed in window
export const GHOST_MODE_WINDOW_FRAMES  = 120;   // 2 seconds
export const GHOST_MODE_DURATION       = 60;    // 1 second boost
export const GHOST_MODE_ACCEL_MULT     = 1.2;   // speed multiplier

// ─── Boost Power-Up ───────────────────────────────────────────────────────────
export const BOOST_ACCEL_MULT  = 1.6;   // player accel multiplier during boost
export const BOOST_MAXVX_MULT  = 1.5;   // max velocity multiplier during boost
export const BOOST_INVINCIBILITY_FRAMES = 8;    // brief i-frames on activation

// ─── Luck Mechanics ───────────────────────────────────────────────────────────
export const LUCKY_COIN_CHANCE    = 0.08;  // 8% chance for rare coin
export const CURSE_FAKE_CHANCE    = 0.05;  // 5% chance for fake power-up
export const HOT_STREAK_DODGES    = 5;     // dodges without power-up for guaranteed spawn
export const LUCKY_COIN_SCORE     = 2500;  // points for lucky coin
