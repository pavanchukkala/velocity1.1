// ── Universal Device Adaptation System ────────────────────────────────────────
// Detects device capabilities and provides scaling/performance configs
// for consistent cross-platform gameplay

export interface DeviceProfile {
  // Screen
  dpr: number;           // device pixel ratio (capped for perf)
  screenW: number;       // CSS pixels
  screenH: number;       // CSS pixels
  aspectRatio: number;   // width/height
  isPortrait: boolean;
  isMobile: boolean;
  isTablet: boolean;
  isUltrawide: boolean;
  isTouchDevice: boolean;

  // Performance tier: 'low' | 'mid' | 'high'
  perfTier: 'low' | 'mid' | 'high';

  // Safe area insets (for notches, cutouts, TV overscan)
  safeArea: { top: number; right: number; bottom: number; left: number };

  // Scaling factor — everything multiplied by this for consistent visual size
  uiScale: number;
  // Game world scale factor relative to 800x1000 virtual canvas
  gameScale: number;

  // Particle/effect budget
  maxParticles: number;
  maxTrails: number;
  enableShadows: boolean;
  enableGlow: boolean;

  // Render DPR (may be lower than device DPR for performance)
  renderDpr: number;
}

// Singleton — recalculated on resize/orientation change
let _profile: DeviceProfile | null = null;
let _listeners: Array<(p: DeviceProfile) => void> = [];

function detectPerfTier(): 'low' | 'mid' | 'high' {
  // Use hardware concurrency and memory as heuristics
  const cores = navigator.hardwareConcurrency ?? 2;
  const mem = (navigator as any).deviceMemory ?? 4; // GB
  
  // Check for known low-end indicators
  const ua = navigator.userAgent.toLowerCase();
  const isLowEnd = cores <= 2 || mem <= 2 || 
    /android\s*[4-6]\./i.test(ua) || // Old Android
    /msie|trident/i.test(ua); // IE
  
  if (isLowEnd) return 'low';
  if (cores >= 6 && mem >= 6) return 'high';
  return 'mid';
}

function getSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  const style = getComputedStyle(document.documentElement);
  const parse = (v: string) => parseInt(v, 10) || 0;
  return {
    top: parse(style.getPropertyValue('--sat') || style.getPropertyValue('env(safe-area-inset-top)')) || 0,
    right: parse(style.getPropertyValue('--sar') || '0'),
    bottom: parse(style.getPropertyValue('--sab') || '0'),
    left: parse(style.getPropertyValue('--sal') || '0'),
  };
}

export function detectDevice(): DeviceProfile {
  const dpr = window.devicePixelRatio || 1;
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;
  const aspectRatio = screenW / screenH;
  const isPortrait = screenH > screenW;
  
  // Device type detection
  const ua = navigator.userAgent;
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isMobile = isTouchDevice && Math.min(screenW, screenH) < 768;
  const isTablet = isTouchDevice && !isMobile && Math.min(screenW, screenH) < 1200;
  const isUltrawide = aspectRatio > 2.0;
  
  const perfTier = detectPerfTier();
  
  // Safe area
  const safeArea = getSafeAreaInsets();
  
  // UI Scale: normalize so UI looks the same size on all screens
  // Base reference: 800px wide desktop
  const refWidth = 800;
  const rawScale = Math.min(screenW, screenH * 0.8) / refWidth;
  const uiScale = Math.max(0.5, Math.min(1.6, rawScale));
  
  // Game scale: how the 800x1000 virtual world maps to this screen
  const gameScale = Math.min(screenW / 800, screenH / 1000);
  
  // Render DPR — cap based on performance
  let renderDpr: number;
  if (perfTier === 'low') renderDpr = Math.min(dpr, 1.5);
  else if (perfTier === 'mid') renderDpr = Math.min(dpr, 2);
  else renderDpr = Math.min(dpr, 3);
  
  // Effect budgets
  const maxParticles = perfTier === 'low' ? 60 : perfTier === 'mid' ? 150 : 300;
  const maxTrails = perfTier === 'low' ? 20 : perfTier === 'mid' ? 60 : 120;
  const enableShadows = perfTier !== 'low';
  const enableGlow = perfTier !== 'low';
  
  _profile = {
    dpr, screenW, screenH, aspectRatio, isPortrait,
    isMobile, isTablet, isUltrawide, isTouchDevice,
    perfTier, safeArea, uiScale, gameScale,
    maxParticles, maxTrails, enableShadows, enableGlow, renderDpr,
  };
  
  return _profile;
}

export function getDeviceProfile(): DeviceProfile {
  if (!_profile) return detectDevice();
  return _profile;
}

export function onDeviceChange(cb: (p: DeviceProfile) => void) {
  _listeners.push(cb);
  return () => { _listeners = _listeners.filter(l => l !== cb); };
}

// Scale a pixel value relative to the reference 800px canvas
export function s(px: number): number {
  const p = getDeviceProfile();
  return Math.round(px * p.gameScale * 100) / 100;
}

// Scale a font size — ensures readability on all screens
export function fs(basePx: number): number {
  const p = getDeviceProfile();
  // Font scaling: use geometric mean of gameScale and 1 for balanced readability
  const fontScale = Math.sqrt(p.gameScale);
  return Math.max(8, Math.round(basePx * fontScale * 10) / 10);
}

// Initialize — call once at app startup
let _resizeRAF = 0;
export function initResponsive() {
  detectDevice();
  
  // Set CSS custom properties for safe area
  const root = document.documentElement;
  root.style.setProperty('--sat', 'env(safe-area-inset-top, 0px)');
  root.style.setProperty('--sar', 'env(safe-area-inset-right, 0px)');
  root.style.setProperty('--sab', 'env(safe-area-inset-bottom, 0px)');
  root.style.setProperty('--sal', 'env(safe-area-inset-left, 0px)');
  
  // Debounced resize handler
  const onResize = () => {
    cancelAnimationFrame(_resizeRAF);
    _resizeRAF = requestAnimationFrame(() => {
      const p = detectDevice();
      _listeners.forEach(cb => cb(p));
    });
  };
  
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => {
    // Delay to let the browser settle
    setTimeout(onResize, 150);
  });
  
  // Prevent pinch zoom on the game
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  
  // Prevent double-tap zoom
  let lastTap = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });
}
