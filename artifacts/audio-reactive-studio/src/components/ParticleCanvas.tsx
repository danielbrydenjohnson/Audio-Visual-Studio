import { useEffect, useRef } from "react";
import type { VisualizerSettings } from "@/types/visualizer";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Particle {
  x:          number;
  y:          number;
  vx:         number;
  vy:         number;
  /** Base radius — never mutated by effects; used as the resting size. */
  radius:     number;
  opacity:    number;
  /** Index into PALETTE */
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 300;

/** Max pixel distance before a connecting line is drawn. */
const CONNECTION_DISTANCE = 90;
/** Resting line max-alpha (falls off linearly to 0 at CONNECTION_DISTANCE). */
const LINE_MAX_ALPHA = 0.14;

const MAX_SPEED = 0.55;
const MIN_SPEED = 0.08;
const MIN_RADIUS = 0.9;
const MAX_RADIUS = 3.2;
const MIN_OPACITY = 0.22;
const MAX_OPACITY = 0.82;

// ── Per-frame exponential smoothing ──────────────────────────────────────────
/**
 * Applied every animation frame (~60 fps) to each raw band value.
 *
 * ATTACK  = 0.35 → reaches ~95 % of a new peak in ~8 frames  (~130 ms).
 * RELEASE = 0.055 → decays to ~5 % in ~52 frames (~870 ms).
 */
const SMOOTHING_ATTACK  = 0.35;
const SMOOTHING_RELEASE = 0.055;

// ── Sub visual constants ──────────────────────────────────────────────────────
/** At effectiveSub = 1 → drawn radius = base × (1 + RADIUS_BOOST). */
const SUB_RADIUS_BOOST  = 0.65;
/** At effectiveSub = 1 → line alpha × (1 + LINE_ALPHA_BOOST). */
const SUB_LINE_BOOST    = 2.4;
/** Additive particle opacity at effectiveSub = 1 (clamped to 1). */
const SUB_OPACITY_BOOST = 0.2;

// ── Low visual constants ──────────────────────────────────────────────────────
/**
 * At effectiveLow = 1, draw positions are LOW_SPREAD_MAX × distance-from-centre
 * further out than their resting positions.  Draw positions are then clamped
 * to the canvas bounds — particles never actually leave the canvas.
 * 0.32 → 32 % spread at 100 % influence; 64 % at 200 %.
 */
const LOW_SPREAD_MAX = 0.32;

// ── Mid visual constants ──────────────────────────────────────────────────────
/**
 * Rotation speed in radians per frame at effectiveMid = 1.
 * 0.0022 rad/frame ≈ 7.5°/sec — subtle swirl that builds with mid energy.
 * Accumulated in `rotationAngle`; applied only at draw time.
 */
const MID_ROT_SPEED = 0.0022;

// ── High visual constants ─────────────────────────────────────────────────────
/** Additive opacity boost for all particles at effectiveHigh = 1. */
const HIGH_BRIGHTNESS    = 0.28;
/** Fraction of particles that may sparkle at effectiveHigh = 1 (per frame). */
const HIGH_SPARKLE_PROB  = 0.2;
/** Opacity boost added to a sparkling particle. */
const HIGH_SPARKLE_BOOST = 0.55;
/** Radius scale multiplier for sparkling particles. */
const HIGH_SPARKLE_SCALE = 0.45;
/**
 * Peak flash overlay max-alpha at effectiveHigh = 1.
 * Applied quadratically so it only appears at genuine peaks, not low rumble.
 * 0.055 × 1² = 0.055; at 200 % influence × smoothed=1 → 0.055 × 4 = 0.22.
 */
const HIGH_FLASH_MAX = 0.055;

// Cyan / purple / pink palette — matches the app's design tokens.
const PALETTE = [
  "#22d3ee", // cyan-400
  "#06b6d4", // cyan-500
  "#a855f7", // purple-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#f472b6", // pink-400
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createParticle(w: number, h: number): Particle {
  const angle = Math.random() * Math.PI * 2;
  const speed = rand(MIN_SPEED, MAX_SPEED);
  return {
    x:          rand(0, w),
    y:          rand(0, h),
    vx:         Math.cos(angle) * speed,
    vy:         Math.sin(angle) * speed,
    radius:     rand(MIN_RADIUS, MAX_RADIUS),
    opacity:    rand(MIN_OPACITY, MAX_OPACITY),
    colorIndex: Math.floor(Math.random() * PALETTE.length),
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
  sub, low, mid, high, settings,
}: ParticleCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);

  /**
   * Ref bridge — lets the single-run canvas effect always read the latest
   * prop values without restarting or causing React state updates.
   * Assigned synchronously during render, before the next RAF tick.
   */
  const subRef      = useRef(sub);
  const lowRef      = useRef(low);
  const midRef      = useRef(mid);
  const highRef     = useRef(high);
  const settingsRef = useRef(settings);

  subRef.current      = sub;
  lowRef.current      = low;
  midRef.current      = mid;
  highRef.current     = high;
  settingsRef.current = settings;

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

    // Pre-allocated draw-position buffers — avoids per-frame heap allocation.
    // Filled before line drawing; reused for particle drawing.
    let drawXBuf = new Float32Array(PARTICLE_COUNT);
    let drawYBuf = new Float32Array(PARTICLE_COUNT);

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

      // Assigning canvas.width resets the context transform — re-scale after.
      canvas!.width         = Math.round(logicalW * dpr);
      canvas!.height        = Math.round(logicalH * dpr);
      canvas!.style.width   = `${logicalW}px`;
      canvas!.style.height  = `${logicalH}px`;
      ctx!.scale(dpr, dpr);

      for (const p of particles) clampParticle(p, logicalW, logicalH);
    }

    // ── Initialise particles ──────────────────────────────────────────────
    function initParticles(): void {
      particles = Array.from({ length: PARTICLE_COUNT }, () =>
        createParticle(logicalW, logicalH),
      );
      drawXBuf = new Float32Array(PARTICLE_COUNT);
      drawYBuf = new Float32Array(PARTICLE_COUNT);
    }

    // ── Draw loop ─────────────────────────────────────────────────────────
    function drawFrame(): void {
      // ── 0. Advance smoothed band values ──────────────────────────────────
      smoothedSub  = expSmooth(smoothedSub,  Math.min(1, Math.max(0, subRef.current  / 100)));
      smoothedLow  = expSmooth(smoothedLow,  Math.min(1, Math.max(0, lowRef.current  / 100)));
      smoothedMid  = expSmooth(smoothedMid,  Math.min(1, Math.max(0, midRef.current  / 100)));
      smoothedHigh = expSmooth(smoothedHigh, Math.min(1, Math.max(0, highRef.current / 100)));

      // Apply influence percentages (0 % = off, 100 % = normal, 200 % = double).
      const s             = settingsRef.current;
      const effectiveSub  = smoothedSub  * (s.sub  / 100);
      const effectiveLow  = smoothedLow  * (s.low  / 100);
      const effectiveMid  = smoothedMid  * (s.mid  / 100);
      const effectiveHigh = smoothedHigh * (s.high / 100);

      // ── 0b. Advance accumulated rotation (Mid) ────────────────────────────
      rotationAngle += effectiveMid * MID_ROT_SPEED;
      if (rotationAngle >= Math.PI * 2) rotationAngle -= Math.PI * 2;

      // Derived frame-level draw scalars.
      const subRadiusScale  = 1 + effectiveSub  * SUB_RADIUS_BOOST;
      const subLineScale    = 1 + effectiveSub  * SUB_LINE_BOOST;
      const subOpacityBump  =     effectiveSub  * SUB_OPACITY_BOOST;
      const highOpacityBump =     effectiveHigh * HIGH_BRIGHTNESS;
      const spread          =     effectiveLow  * LOW_SPREAD_MAX;

      ctx!.clearRect(0, 0, logicalW, logicalH);

      // Canvas centre — used for Low spread and Mid rotation.
      const cx = logicalW * 0.5;
      const cy = logicalH * 0.5;

      // ── 1. Update particle positions (motion only — no draw-effect mutation) ─
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x - p.radius < 0) {
          p.x = p.radius;
          p.vx = Math.abs(p.vx);
        } else if (p.x + p.radius > logicalW) {
          p.x = logicalW - p.radius;
          p.vx = -Math.abs(p.vx);
        }
        if (p.y - p.radius < 0) {
          p.y = p.radius;
          p.vy = Math.abs(p.vy);
        } else if (p.y + p.radius > logicalH) {
          p.y = logicalH - p.radius;
          p.vy = -Math.abs(p.vy);
        }
      }

      // ── 2. Compute draw positions (Low spread + Mid rotation, draw-time only) ─
      //
      // Low:  shifts each particle's draw position away from the canvas centre
      //       proportionally to its distance from centre.  Particle coordinates
      //       (p.x / p.y) are never changed.
      //
      // Mid:  rotates every draw position around the canvas centre by the
      //       accumulated rotationAngle.  The angle grows with mid energy and
      //       coasts to a stop when mid drops to 0.  Again, p.x / p.y unchanged.
      //
      // Results written into pre-allocated Float32Arrays to avoid GC pressure.
      const useRotation = rotationAngle !== 0;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Low spread — scale distance from centre.
        let px = cx + (p.x - cx) * (1 + spread);
        let py = cy + (p.y - cy) * (1 + spread);

        // Mid rotation — rotate the (possibly-spread) draw position.
        if (useRotation) {
          const ddx  = px - cx;
          const ddy  = py - cy;
          const dist  = Math.sqrt(ddx * ddx + ddy * ddy);
          const angle = Math.atan2(ddy, ddx) + rotationAngle;
          px = cx + Math.cos(angle) * dist;
          py = cy + Math.sin(angle) * dist;
        }

        // Clamp to canvas — prevents High/Low combinations from pushing dots
        // outside the visible area.
        const r = p.radius * subRadiusScale;
        drawXBuf[i] = Math.max(r, Math.min(logicalW - r, px));
        drawYBuf[i] = Math.max(r, Math.min(logicalH - r, py));
      }

      // ── 3. Connecting lines ───────────────────────────────────────────────
      // Uses draw positions so lines connect the visually rendered dots.
      const lineCdSq      = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
      const lineAlphaCap  = 0.9;

      for (let i = 0; i < particles.length - 1; i++) {
        const ax = drawXBuf[i];
        const ay = drawYBuf[i];
        for (let j = i + 1; j < particles.length; j++) {
          const dx     = ax - drawXBuf[j];
          const dy     = ay - drawYBuf[j];
          const distSq = dx * dx + dy * dy;
          if (distSq >= lineCdSq) continue;

          const alpha = Math.min(
            lineAlphaCap,
            (1 - Math.sqrt(distSq) / CONNECTION_DISTANCE) * LINE_MAX_ALPHA * subLineScale,
          );

          ctx!.globalAlpha  = alpha;
          ctx!.beginPath();
          ctx!.moveTo(ax, ay);
          ctx!.lineTo(drawXBuf[j], drawYBuf[j]);
          ctx!.strokeStyle = PALETTE[particles[i].colorIndex];
          ctx!.lineWidth   = 0.6;
          ctx!.stroke();
        }
      }

      // ── 4. Particles ──────────────────────────────────────────────────────
      const sparkleProbability = effectiveHigh * effectiveHigh * HIGH_SPARKLE_PROB;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // High sparkle — random per-particle brightness + size kick.
        // Probability is quadratic so it only fires visibly at peaks.
        const sparkle = (sparkleProbability > 0 && Math.random() < sparkleProbability)
          ? effectiveHigh * HIGH_SPARKLE_BOOST
          : 0;

        const drawRadius  = p.radius * subRadiusScale * (sparkle > 0 ? 1 + sparkle * HIGH_SPARKLE_SCALE : 1);
        const drawOpacity = Math.min(1, p.opacity + subOpacityBump + highOpacityBump + sparkle);

        ctx!.globalAlpha = drawOpacity;
        ctx!.beginPath();
        ctx!.arc(drawXBuf[i], drawYBuf[i], drawRadius, 0, Math.PI * 2);
        ctx!.fillStyle = PALETTE[p.colorIndex];
        ctx!.fill();
      }

      // ── 5. High flash overlay ─────────────────────────────────────────────
      // Quadratic so it only appears at genuine peaks; rendered after particles
      // so it brightens the whole scene uniformly.
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
    initParticles();
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
