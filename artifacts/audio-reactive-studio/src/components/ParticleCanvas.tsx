import { useEffect, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
  /** Index into PALETTE */
  colorIndex: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 300;
/** Max pixels between two particles before a connecting line is drawn */
const CONNECTION_DISTANCE = 90;
/** Drawn line opacity at distance 0 (falls off linearly to 0 at CONNECTION_DISTANCE) */
const LINE_MAX_ALPHA = 0.14;
const MAX_SPEED = 0.55;
const MIN_SPEED = 0.08;
const MIN_RADIUS = 0.9;
const MAX_RADIUS = 3.2;
const MIN_OPACITY = 0.22;
const MAX_OPACITY = 0.82;

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

/** Clamp particles to stay inside [radius, dim - radius] after a resize. */
function clampParticle(p: Particle, w: number, h: number): void {
  p.x = Math.max(p.radius, Math.min(w - p.radius, p.x));
  p.y = Math.max(p.radius, Math.min(h - p.radius, p.y));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ParticleCanvas() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

    // ── Resize ───────────────────────────────────────────────────────────────
    function applyResize(): void {
      dpr = Math.min(window.devicePixelRatio || 1, 3); // cap at 3× for perf
      const rect = wrapper!.getBoundingClientRect();
      logicalW = rect.width;
      logicalH = rect.height;

      // Setting canvas.width resets the context transform — always re-scale.
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
      ctx!.clearRect(0, 0, logicalW, logicalH);

      // 1. Update positions and bounce off edges
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

      // 2. Connecting lines (O(n²) — fine at 300 particles)
      //    Batch all line segments into a single path per colour pair to reduce
      //    state changes, but the simpler per-pair approach is clearer and fast
      //    enough on modern hardware.
      for (let i = 0; i < particles.length - 1; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          // Use squared distance to skip the sqrt when possible
          const distSq = dx * dx + dy * dy;
          if (distSq >= CONNECTION_DISTANCE * CONNECTION_DISTANCE) continue;

          const alpha =
            (1 - Math.sqrt(distSq) / CONNECTION_DISTANCE) * LINE_MAX_ALPHA;

          ctx!.globalAlpha = alpha;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.strokeStyle = PALETTE[a.colorIndex];
          ctx!.lineWidth = 0.6;
          ctx!.stroke();
        }
      }

      // 3. Particles on top of lines
      for (const p of particles) {
        ctx!.globalAlpha = p.opacity;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
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
  }, []); // runs once — all mutable state is inside the effect

  return (
    // wrapper fills the parent absolutely; overflow:hidden clips the canvas
    <div ref={wrapperRef} className="absolute inset-0 overflow-hidden rounded-xl">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
