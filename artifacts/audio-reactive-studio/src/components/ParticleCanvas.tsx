import { useEffect, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Base radius — never mutated by the pulse; used as the resting size. */
  radius: number;
  opacity: number;
  /** Index into PALETTE */
  colorIndex: number;
}

export interface ParticleCanvasProps {
  /**
   * Live Sub bass band value from useFrequencyAnalysis, 0–100.
   * 0 = silence / paused → resting visual.
   * ~100 = loud bass hit → full pulse.
   */
  sub: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 300;
/** Max pixel distance before a connecting line is drawn */
const CONNECTION_DISTANCE = 90;
/** Resting line max-alpha (at distance 0, falls off linearly) */
const LINE_MAX_ALPHA = 0.14;
const MAX_SPEED = 0.55;
const MIN_SPEED = 0.08;
const MIN_RADIUS = 0.9;
const MAX_RADIUS = 3.2;
const MIN_OPACITY = 0.22;
const MAX_OPACITY = 0.82;

// ── Pulse tuning ──────────────────────────────────────────────────────────────
/**
 * Exponential-smoothing coefficients applied every animation frame (~60 fps).
 *
 * Attack (rising):  smoothed += (target - smoothed) * ATTACK
 * Release (falling): smoothed += (target - smoothed) * RELEASE
 *
 * ATTACK = 0.35 means the gap closes 35 % per frame → reaches ~95 % of a new
 *   peak in roughly 8 frames (~130 ms), giving a snappy bass-hit response.
 * RELEASE = 0.055 means the gap closes 5.5 % per frame → decays to ~5 % in
 *   roughly 52 frames (~870 ms), giving a natural tail-off between beats.
 */
const SMOOTHING_ATTACK = 0.35;
const SMOOTHING_RELEASE = 0.055;

/**
 * At smoothedSub = 1 (full pulse), drawn radius = base * (1 + RADIUS_BOOST).
 * 0.65 → max 1.65× the resting radius — visibly larger but not overwhelming.
 * Positions are never changed; this is purely a draw-time scale.
 */
const RADIUS_BOOST = 0.65;

/**
 * At smoothedSub = 1, line max-alpha = LINE_MAX_ALPHA * (1 + LINE_ALPHA_BOOST).
 * 2.4 → peaks at 0.14 * 3.4 ≈ 0.48, making connections clearly brighter on hits.
 */
const LINE_ALPHA_BOOST = 2.4;

/**
 * Small additive opacity bump for particles during a pulse (clamped to 1).
 * Keeps the glow feel without changing the base opacity permanently.
 */
const PARTICLE_OPACITY_BOOST = 0.2;

// Cyan / purple / pink palette – matches the app's design tokens
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
    x: rand(0, w),
    y: rand(0, h),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius: rand(MIN_RADIUS, MAX_RADIUS),
    opacity: rand(MIN_OPACITY, MAX_OPACITY),
    colorIndex: Math.floor(Math.random() * PALETTE.length),
  };
}

/** Clamp particles inside [radius, dim-radius] after a resize. */
function clampParticle(p: Particle, w: number, h: number): void {
  p.x = Math.max(p.radius, Math.min(w - p.radius, p.x));
  p.y = Math.max(p.radius, Math.min(h - p.radius, p.y));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParticleCanvas({ sub }: ParticleCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Bridge the `sub` prop into the animation loop.
   *
   * The canvas effect runs once (empty deps) so its closure captures the ref
   * object — not a stale copy of `sub`. Assigning `.current` here (during
   * render, before the effect's RAF tick) means every frame always reads the
   * latest prop value with zero React overhead.
   */
  const subRef = useRef<number>(sub);
  subRef.current = sub;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // ── Mutable state owned entirely within this effect ──────────────────────
    let rafId = 0;
    let logicalW = 0;
    let logicalH = 0;
    let dpr = 1;
    let particles: Particle[] = [];

    /**
     * Smoothed sub value in [0, 1].  Updated each frame via exponential
     * smoothing before any drawing happens.  Lives here so it persists
     * across frames without touching React state.
     */
    let smoothedSub = 0;

    // ── Resize ───────────────────────────────────────────────────────────────
    function applyResize(): void {
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = wrapper!.getBoundingClientRect();
      logicalW = rect.width;
      logicalH = rect.height;

      // canvas.width assignment resets the context transform — always re-scale.
      canvas!.width = Math.round(logicalW * dpr);
      canvas!.height = Math.round(logicalH * dpr);
      canvas!.style.width = `${logicalW}px`;
      canvas!.style.height = `${logicalH}px`;
      ctx!.scale(dpr, dpr);

      for (const p of particles) clampParticle(p, logicalW, logicalH);
    }

    // ── Initialise particles ──────────────────────────────────────────────────
    function initParticles(): void {
      particles = Array.from({ length: PARTICLE_COUNT }, () =>
        createParticle(logicalW, logicalH)
      );
    }

    // ── Draw loop ─────────────────────────────────────────────────────────────
    function drawFrame(): void {
      // ── 0. Advance smoothedSub ─────────────────────────────────────────────
      // Normalise raw prop value to [0, 1].
      const target = Math.min(1, Math.max(0, subRef.current / 100));
      // Use the faster coefficient when the value is rising (attack),
      // the slower one when it is falling (release).
      const coeff = target > smoothedSub ? SMOOTHING_ATTACK : SMOOTHING_RELEASE;
      smoothedSub += (target - smoothedSub) * coeff;

      // Derived draw-time multipliers — computed once per frame, not per particle.
      const radiusScale = 1 + smoothedSub * RADIUS_BOOST;
      const lineAlphaScale = 1 + smoothedSub * LINE_ALPHA_BOOST;
      const opacityBump = smoothedSub * PARTICLE_OPACITY_BOOST;

      ctx!.clearRect(0, 0, logicalW, logicalH);

      // ── 1. Update positions and bounce off edges ───────────────────────────
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

      // ── 2. Connecting lines ────────────────────────────────────────────────
      const lineCd = CONNECTION_DISTANCE;
      const lineCdSq = lineCd * lineCd;

      for (let i = 0; i < particles.length - 1; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distSq = dx * dx + dy * dy;
          if (distSq >= lineCdSq) continue;

          // Base alpha × pulse brightness scale
          const alpha =
            (1 - Math.sqrt(distSq) / lineCd) * LINE_MAX_ALPHA * lineAlphaScale;

          ctx!.globalAlpha = Math.min(alpha, 0.9); // hard cap so lines never overexpose
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.strokeStyle = PALETTE[a.colorIndex];
          ctx!.lineWidth = 0.6;
          ctx!.stroke();
        }
      }

      // ── 3. Particles on top of lines ──────────────────────────────────────
      for (const p of particles) {
        // Draw radius is scaled by the pulse — base radius is never mutated.
        const drawRadius = p.radius * radiusScale;
        const drawOpacity = Math.min(1, p.opacity + opacityBump);

        ctx!.globalAlpha = drawOpacity;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, drawRadius, 0, Math.PI * 2);
        ctx!.fillStyle = PALETTE[p.colorIndex];
        ctx!.fill();
      }

      // Reset global alpha for the next frame
      ctx!.globalAlpha = 1;

      rafId = requestAnimationFrame(drawFrame);
    }

    // ── ResizeObserver ────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      applyResize();
    });
    ro.observe(wrapper);

    // ── Bootstrap ─────────────────────────────────────────────────────────────
    applyResize();
    initParticles();
    rafId = requestAnimationFrame(drawFrame);

    // ── Cleanup ───────────────────────────────────────────────────────────────
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
