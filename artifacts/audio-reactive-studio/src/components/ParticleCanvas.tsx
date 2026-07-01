import { useEffect, useRef } from "react";
import type { VisualizerSettings, ParticleVisualSettings, DensityLevel, PaletteName } from "@/types/visualizer";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Particle {
  x:          number;
  y:          number;
  vx:         number;
  vy:         number;
  /** Base radius — never mutated by effects; used as the resting size. */
  radius:     number;
  opacity:    number;
  /** Index into the active palette array. */
  colorIndex: number;
}

export interface ParticleCanvasProps {
  /** Live frequency band values from useFrequencyAnalysis, each 0–100. */
  sub:  number;
  low:  number;
  mid:  number;
  high: number;
  /** Per-band influence percentages (0–200) from the Controls sidebar. */
  settings: VisualizerSettings;
  /** Visual styling settings (density, speed, palette, glow, trails, …). */
  visualSettings: ParticleVisualSettings;
}

// ─── Palettes ─────────────────────────────────────────────────────────────────
// Defined here — the single source of truth for particle colours.

const PALETTES: Record<PaletteName, readonly string[]> = {
  cyanViolet: [
    "#22d3ee", // cyan-400
    "#06b6d4", // cyan-500
    "#a855f7", // purple-500
    "#8b5cf6", // violet-500
    "#ec4899", // pink-500
    "#f472b6", // pink-400
  ],
  monochrome: [
    "#f8fafc", // slate-50
    "#e2e8f0", // slate-200
    "#cbd5e1", // slate-300
    "#94a3b8", // slate-400
    "#64748b", // slate-500
    "#475569", // slate-600
  ],
  ember: [
    "#fbbf24", // amber-400
    "#f59e0b", // amber-500
    "#f97316", // orange-500
    "#fb923c", // orange-400
    "#ef4444", // red-500
    "#dc2626", // red-600
  ],
};

/** Neutral glow shadow — readable against all three palettes. */
const GLOW_SHADOW_COLOR = "rgba(255,255,255,0.75)";

// ─── Density → particle count ─────────────────────────────────────────────────

const DENSITY_COUNTS: Record<DensityLevel, number> = {
  low:    150,
  medium: 300,
  high:   500,
};

// ─── Particle constants ───────────────────────────────────────────────────────

/** Resting line max-alpha (falls off linearly to 0 at connectionDistance). */
const LINE_MAX_ALPHA = 0.14;

const MAX_SPEED = 0.55;
const MIN_SPEED = 0.08;
const MIN_RADIUS = 0.9;
const MAX_RADIUS = 3.2;
const MIN_OPACITY = 0.22;
const MAX_OPACITY = 0.82;

// ── Per-frame exponential smoothing ──────────────────────────────────────────
/**
 * ATTACK  = 0.35 → reaches ~95 % of a new peak in ~8 frames  (~130 ms).
 * RELEASE = 0.055 → decays to ~5 % in ~52 frames (~870 ms).
 */
const SMOOTHING_ATTACK  = 0.35;
const SMOOTHING_RELEASE = 0.055;

// ── Sub visual constants ──────────────────────────────────────────────────────
const SUB_RADIUS_BOOST  = 0.65;
const SUB_LINE_BOOST    = 2.4;
const SUB_OPACITY_BOOST = 0.2;

// ── Low visual constants ──────────────────────────────────────────────────────
const LOW_SPREAD_MAX = 0.32;

// ── Mid visual constants ──────────────────────────────────────────────────────
/**
 * Rotation speed in radians per frame at effectiveMid = 1.
 * Accumulated from mid energy only — never multiplied by Motion Speed so
 * the swirl does not become unpredictable when speed is changed.
 */
const MID_ROT_SPEED = 0.0022;

// ── High visual constants ─────────────────────────────────────────────────────
const HIGH_BRIGHTNESS    = 0.28;
const HIGH_SPARKLE_PROB  = 0.2;
const HIGH_SPARKLE_BOOST = 0.55;
const HIGH_SPARKLE_SCALE = 0.45;
/** Quadratic peak flash — kept restrained even at high glow. */
const HIGH_FLASH_MAX = 0.055;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createParticle(w: number, h: number, paletteLength: number): Particle {
  const angle = Math.random() * Math.PI * 2;
  const speed = rand(MIN_SPEED, MAX_SPEED);
  return {
    x:          rand(0, w),
    y:          rand(0, h),
    vx:         Math.cos(angle) * speed,
    vy:         Math.sin(angle) * speed,
    radius:     rand(MIN_RADIUS, MAX_RADIUS),
    opacity:    rand(MIN_OPACITY, MAX_OPACITY),
    colorIndex: Math.floor(Math.random() * paletteLength),
  };
}

/** Clamp particles inside [radius, dim-radius] after a resize. */
function clampParticle(p: Particle, w: number, h: number): void {
  p.x = Math.max(p.radius, Math.min(w - p.radius, p.x));
  p.y = Math.max(p.radius, Math.min(h - p.radius, p.y));
}

/** One step of exponential smoothing with fast attack / slow release. */
function expSmooth(current: number, target: number): number {
  const coeff = target > current ? SMOOTHING_ATTACK : SMOOTHING_RELEASE;
  return current + (target - current) * coeff;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParticleCanvas({
  sub, low, mid, high, settings, visualSettings,
}: ParticleCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);

  /**
   * Ref bridge — all props synchronously mirrored into refs so the
   * single-run canvas effect always reads the latest values without
   * restarting or causing React state updates.
   */
  const subRef            = useRef(sub);
  const lowRef            = useRef(low);
  const midRef            = useRef(mid);
  const highRef           = useRef(high);
  const settingsRef       = useRef(settings);
  const visualSettingsRef = useRef(visualSettings);

  subRef.current            = sub;
  lowRef.current            = low;
  midRef.current            = mid;
  highRef.current           = high;
  settingsRef.current       = settings;
  visualSettingsRef.current = visualSettings;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas  = canvasRef.current;
    if (!wrapper || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // ── Mutable state inside the effect closure ───────────────────────────
    let rafId    = 0;
    let logicalW = 0;
    let logicalH = 0;
    let dpr      = 1;
    let particles: Particle[] = [];

    // Draw-position buffers — avoids per-frame heap allocation.
    // Sized to the maximum possible count; we only read [0..particles.length).
    const MAX_PARTICLES = DENSITY_COUNTS.high;
    let drawXBuf = new Float32Array(MAX_PARTICLES);
    let drawYBuf = new Float32Array(MAX_PARTICLES);

    // Per-band smoothed values in [0, 1] — updated at the top of every frame.
    let smoothedSub  = 0;
    let smoothedLow  = 0;
    let smoothedMid  = 0;
    let smoothedHigh = 0;

    // Accumulated rotation angle for Mid (radians); grows each frame.
    let rotationAngle = 0;

    // ── Resize ───────────────────────────────────────────────────────────
    function applyResize(): void {
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = wrapper!.getBoundingClientRect();
      logicalW = rect.width;
      logicalH = rect.height;

      canvas!.width         = Math.round(logicalW * dpr);
      canvas!.height        = Math.round(logicalH * dpr);
      canvas!.style.width   = `${logicalW}px`;
      canvas!.style.height  = `${logicalH}px`;
      ctx!.scale(dpr, dpr);

      for (const p of particles) clampParticle(p, logicalW, logicalH);
    }

    // ── Initialise particles ──────────────────────────────────────────────
    function initParticles(count: number, paletteLength: number): void {
      particles = Array.from({ length: count }, () =>
        createParticle(logicalW, logicalH, paletteLength),
      );
    }

    // ── Draw loop ─────────────────────────────────────────────────────────
    function drawFrame(): void {
      const vs      = visualSettingsRef.current;
      const palette = PALETTES[vs.palette];

      // ── 0a. Advance smoothed band values ────────────────────────────────
      smoothedSub  = expSmooth(smoothedSub,  Math.min(1, Math.max(0, subRef.current  / 100)));
      smoothedLow  = expSmooth(smoothedLow,  Math.min(1, Math.max(0, lowRef.current  / 100)));
      smoothedMid  = expSmooth(smoothedMid,  Math.min(1, Math.max(0, midRef.current  / 100)));
      smoothedHigh = expSmooth(smoothedHigh, Math.min(1, Math.max(0, highRef.current / 100)));

      const s             = settingsRef.current;
      const effectiveSub  = smoothedSub  * (s.sub  / 100);
      const effectiveLow  = smoothedLow  * (s.low  / 100);
      const effectiveMid  = smoothedMid  * (s.mid  / 100);
      const effectiveHigh = smoothedHigh * (s.high / 100);

      // ── 0b. Mid rotation accumulation ───────────────────────────────────
      // Driven by audio energy only — Motion Speed does NOT affect this.
      rotationAngle += effectiveMid * MID_ROT_SPEED;
      if (rotationAngle >= Math.PI * 2) rotationAngle -= Math.PI * 2;

      // Derived frame-level scalars.
      const sizeMultiplier  = vs.particleSize / 100;
      const speedMultiplier = vs.speed / 100;
      const subRadiusScale  = 1 + effectiveSub * SUB_RADIUS_BOOST;
      const subLineScale    = 1 + effectiveSub * SUB_LINE_BOOST;
      const subOpacityBump  =     effectiveSub * SUB_OPACITY_BOOST;
      const highOpacityBump =     effectiveHigh * HIGH_BRIGHTNESS;
      const spread          =     effectiveLow  * LOW_SPREAD_MAX;

      // ── 0c. Density sync — add / remove particles without RAF restart ───
      const targetCount = DENSITY_COUNTS[vs.density];
      if (particles.length < targetCount) {
        while (particles.length < targetCount) {
          particles.push(createParticle(logicalW, logicalH, palette.length));
        }
      } else if (particles.length > targetCount) {
        particles.length = targetCount;
      }
      const count = particles.length;

      // ── 0d. Clear / trails ──────────────────────────────────────────────
      if (vs.trails === 0) {
        ctx!.clearRect(0, 0, logicalW, logicalH);
      } else {
        // Draw a partially transparent background to retain a fraction of
        // the previous frame.  Alpha = (1 - retention); e.g. at trails=50 %
        // → retain 50 % of previous frame → alpha 0.5.
        // Trails slider range is 0–90, so max retention = 90 %.
        const retentionFraction = vs.trails / 100;
        const clearAlpha        = 1 - retentionFraction;
        ctx!.globalAlpha = clearAlpha;
        ctx!.fillStyle   = "#000000";
        ctx!.fillRect(0, 0, logicalW, logicalH);
        ctx!.globalAlpha = 1;
      }

      // Canvas centre — used for Low spread and Mid rotation.
      const cx = logicalW * 0.5;
      const cy = logicalH * 0.5;

      // ── 1. Update particle positions (motion only — no effect mutation) ──
      for (let i = 0; i < count; i++) {
        const p = particles[i];
        // Speed multiplier applied only to position — not to rotationAngle.
        p.x += p.vx * speedMultiplier;
        p.y += p.vy * speedMultiplier;

        if (p.x - p.radius < 0) {
          p.x = p.radius; p.vx = Math.abs(p.vx);
        } else if (p.x + p.radius > logicalW) {
          p.x = logicalW - p.radius; p.vx = -Math.abs(p.vx);
        }
        if (p.y - p.radius < 0) {
          p.y = p.radius; p.vy = Math.abs(p.vy);
        } else if (p.y + p.radius > logicalH) {
          p.y = logicalH - p.radius; p.vy = -Math.abs(p.vy);
        }
      }

      // ── 2. Compute draw positions (Low spread + Mid rotation) ────────────
      //
      // Low:  shifts each draw position away from canvas centre proportional
      //       to its distance.  p.x / p.y are never changed.
      // Mid:  rotates every draw position by the accumulated rotationAngle.
      //       Again, p.x / p.y unchanged.
      // Results written into pre-allocated Float32Arrays.
      const useRotation = rotationAngle !== 0;
      for (let i = 0; i < count; i++) {
        const p = particles[i];

        // Low spread.
        let px = cx + (p.x - cx) * (1 + spread);
        let py = cy + (p.y - cy) * (1 + spread);

        // Mid rotation.
        if (useRotation) {
          const ddx   = px - cx;
          const ddy   = py - cy;
          const dist  = Math.sqrt(ddx * ddx + ddy * ddy);
          const angle = Math.atan2(ddy, ddx) + rotationAngle;
          px = cx + Math.cos(angle) * dist;
          py = cy + Math.sin(angle) * dist;
        }

        // Clamp so glow/size combos cannot push dots off-screen.
        const r = p.radius * sizeMultiplier * subRadiusScale;
        drawXBuf[i] = Math.max(r, Math.min(logicalW - r, px));
        drawYBuf[i] = Math.max(r, Math.min(logicalH - r, py));
      }

      // ── 3. Connecting lines (no shadowBlur — expensive per connection) ───
      const connDist = vs.connectionDistance;
      if (connDist > 0) {
        const lineCdSq   = connDist * connDist;
        const lineAlphaCap = 0.9;

        // Ensure shadow is off for lines.
        ctx!.shadowBlur = 0;

        for (let i = 0; i < count - 1; i++) {
          const ax = drawXBuf[i];
          const ay = drawYBuf[i];
          for (let j = i + 1; j < count; j++) {
            const dx     = ax - drawXBuf[j];
            const dy     = ay - drawYBuf[j];
            const distSq = dx * dx + dy * dy;
            if (distSq >= lineCdSq) continue;

            const alpha = Math.min(
              lineAlphaCap,
              (1 - Math.sqrt(distSq) / connDist) * LINE_MAX_ALPHA * subLineScale,
            );

            ctx!.globalAlpha  = alpha;
            ctx!.beginPath();
            ctx!.moveTo(ax, ay);
            ctx!.lineTo(drawXBuf[j], drawYBuf[j]);
            ctx!.strokeStyle = palette[particles[i].colorIndex % palette.length];
            ctx!.lineWidth   = 0.6;
            ctx!.stroke();
          }
        }
      }

      // ── 4. Particles (glow applies here only) ────────────────────────────
      const glowBlur = vs.glow > 0 ? Math.round((vs.glow / 100) * 18) : 0;
      if (glowBlur > 0) {
        ctx!.shadowBlur  = glowBlur;
        ctx!.shadowColor = GLOW_SHADOW_COLOR;
      } else {
        ctx!.shadowBlur = 0;
      }

      const sparkleProbability = effectiveHigh * effectiveHigh * HIGH_SPARKLE_PROB;

      for (let i = 0; i < count; i++) {
        const p = particles[i];

        // High sparkle — quadratic probability so it only fires at peaks.
        const sparkle = (sparkleProbability > 0 && Math.random() < sparkleProbability)
          ? effectiveHigh * HIGH_SPARKLE_BOOST
          : 0;

        const drawRadius  = p.radius * sizeMultiplier * subRadiusScale
          * (sparkle > 0 ? 1 + sparkle * HIGH_SPARKLE_SCALE : 1);
        const drawOpacity = Math.min(1, p.opacity + subOpacityBump + highOpacityBump + sparkle);

        ctx!.globalAlpha = drawOpacity;
        ctx!.beginPath();
        ctx!.arc(drawXBuf[i], drawYBuf[i], drawRadius, 0, Math.PI * 2);
        ctx!.fillStyle = palette[p.colorIndex % palette.length];
        ctx!.fill();
      }

      // ── 5. High flash overlay ─────────────────────────────────────────────
      // Disable glow before the flash — flash is a full-canvas rect and must
      // not be amplified by shadowBlur, even when glow is high.
      ctx!.shadowBlur = 0;

      if (effectiveHigh > 0.01) {
        const flashAlpha = effectiveHigh * effectiveHigh * HIGH_FLASH_MAX;
        ctx!.globalAlpha = flashAlpha;
        ctx!.fillStyle   = "#b4e6ff"; // pale cyan-white
        ctx!.fillRect(0, 0, logicalW, logicalH);
      }

      ctx!.globalAlpha = 1;
      rafId = requestAnimationFrame(drawFrame);
    }

    // ── ResizeObserver ────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => { applyResize(); });
    ro.observe(wrapper);

    // ── Bootstrap ─────────────────────────────────────────────────────────
    applyResize();
    const initialVs = visualSettingsRef.current;
    initParticles(
      DENSITY_COUNTS[initialVs.density],
      PALETTES[initialVs.palette].length,
    );
    rafId = requestAnimationFrame(drawFrame);

    // ── Cleanup ───────────────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []); // runs once — all mutable animation state lives inside the closure

  return (
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden rounded-xl">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
