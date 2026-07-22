import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  type AudioLevels,
  rand,
  paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * SILK LINES — a small set of long smooth luminous lines drifting gently in space.
 *
 * Each line is a THREE.Line built on a 32-point BufferGeometry whose position
 * and color arrays are rewritten every frame in JS. At most 9 lines × 32 points
 * = 288 vertices — negligible CPU cost, clean smooth curves.
 *
 * Density:
 *   Low = 3 lines  |  Medium = 6 lines  |  High = 9 lines
 *
 * Audio mapping (all bounded; no chaos):
 *   LOW      → separation: each line drifts along its perpendicular AWAY from
 *              the scene centre (fixed per-line direction, varied amount), so
 *              sustained bass opens space between the lines.
 *   LOW hit  → a quick extra separation push that eases back with the envelope
 *              + overall brightness pulse.
 *   MID      → controlled ripple along the line (higher frequency than resting wave).
 *   HIGH     → travelling shimmer: a bright spot moving along each line.
 *   HIGH hit → sharper, faster sparkle.
 */

const COUNTS: Record<DensityLevel, number> = { low: 3, medium: 6, high: 9 };
const PTS    = 32;     // vertices per line
const TWO_PI = Math.PI * 2;

interface LineState {
  /** Line centre as fraction of the creation-time volume (stays valid after resize). */
  cxF: number; cyF: number; czF: number;
  /** Main spread axis (XY, normalised). */
  ax: number; ay: number;
  /** Perpendicular to the axis (rotation by 90°). */
  perpX: number; perpY: number;
  /** Line span as fraction of halfW. */
  lengthF: number;
  /** Resting-wave amplitude in world units. */
  amplitude: number;
  phase: number;
  driftSpeed: number;
  /** Palette interpolation [0,1]. */
  colorT: number;
  /** Band affinities [0,1]. */
  affLow: number; affMid: number; affHigh: number;
  /** Fixed separation direction along ±perp — points AWAY from the scene centre. */
  sepDir: number;
  /** Per-line separation magnitude variation. */
  sepVary: number;
  geo: THREE.BufferGeometry;
  posArr: Float32Array;
  colArr: Float32Array;
}

// ─── Build per-line geometry + state ─────────────────────────────────────────

function buildLines(
  n: number,
  halfW: number, halfH: number, halfD: number,
  group: THREE.Group,
  mat: THREE.LineBasicMaterial,
): LineState[] {
  const states: LineState[] = [];
  for (let i = 0; i < n; i++) {
    // Random orientation mostly horizontal with slight tilt
    const angle = rand(-Math.PI * 0.30, Math.PI * 0.30);
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);

    const cx = rand(-halfW * 0.55, halfW * 0.55);
    const cy = rand(-halfH * 0.50, halfH * 0.50);
    const cz = rand(-halfD * 0.25, halfD * 0.25);
    const length = rand(halfW * 1.05, halfW * 1.55); // extends past frame edges

    const posArr = new Float32Array(PTS * 3);
    const colArr = new Float32Array(PTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute("color",    new THREE.BufferAttribute(colArr, 3));

    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);

    // Affinities: round-robin dominant band so lines react to different frequencies
    states.push({
      cxF: cx / halfW, cyF: cy / halfH, czF: cz / halfD,
      ax, ay, perpX: -ay, perpY: ax,
      lengthF: length / halfW,
      amplitude:  rand(5, 14),
      phase:      (i / n) * TWO_PI + rand(0, 0.9),
      driftSpeed: rand(0.10, 0.26),
      colorT:     i / Math.max(n - 1, 1),
      affLow:  i % 3 === 0 ? rand(0.70, 1.00) : rand(0.08, 0.38),
      affMid:  i % 3 === 1 ? rand(0.70, 1.00) : rand(0.08, 0.38),
      affHigh: i % 3 === 2 ? rand(0.70, 1.00) : rand(0.08, 0.38),
      // Which way along ±perp points AWAY from the scene centre for this line —
      // fixed at build so Low always pushes lines apart, never oscillates them.
      sepDir: (cx * -ay + cy * ax) >= 0 ? 1 : -1,
      sepVary: rand(0.7, 1.3),
      geo, posArr, colArr,
    });
  }
  return states;
}

// ─── Template factory ─────────────────────────────────────────────────────────

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const n     = COUNTS[density];
  const group = new THREE.Group();

  // One shared material; per-vertex colors handle all individual appearance.
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent:  true,
    blending:     THREE.AdditiveBlending,
    depthWrite:   false,
    depthTest:    false,
  });

  const lines   = buildLines(n, halfW, halfH, halfD, group, mat);
  const vol     = { halfW, halfH, halfD };
  const scratch = new THREE.Color();

  function onFrame(time: number, _dt: number, audio: AudioLevels): void {
    const ca = shared.uColorA.value;
    const cb = shared.uColorB.value;
    const cc = shared.uColorC.value;

    for (const s of lines) {
      const { posArr, colArr, geo, ax, ay, perpX, perpY,
              amplitude, phase, driftSpeed, colorT,
              affLow, affMid, affHigh, sepDir, sepVary } = s;

      const hw = vol.halfW, hh = vol.halfH, hd = vol.halfD;
      const cx = s.cxF * hw, cy = s.cyF * hh, cz = s.czF * hd;
      const length = s.lengthF * hw;

      paletteMix(colorT, ca, cb, cc, scratch);

      const lowEff     = audio.low     * affLow;
      const midEff     = audio.mid     * affMid;
      const highEff    = audio.high    * affHigh;
      const lowHitEff  = audio.lowHit  * affLow;
      const highHitEff = audio.highHit * affHigh;

      // LOW: separation — the whole line pushes along its perpendicular AWAY
      // from the scene centre (sepDir fixed at build), so bass opens space
      // between the lines instead of oscillating them. Level = sustained
      // spacing pressure; hit = a quick extra push that eases back with the
      // envelope. Direction + magnitude vary per line, so lines never move
      // identically; at 0% Low influence only the resting undulation remains.
      const sepAmt = (lowEff * 5.5 + lowHitEff * 7.0) * sepDir * sepVary;
      const sepX = perpX * sepAmt;
      const sepY = perpY * sepAmt;

      for (let j = 0; j < PTS; j++) {
        const t = j / (PTS - 1); // 0 → 1
        const u = t - 0.5;        // −0.5 → 0.5  (centred along axis)

        // Base position along line axis
        let px = cx + ax * u * length;
        let py = cy + ay * u * length;
        let pz = cz;

        // ── Resting undulation ────────────────────────────────────────────────
        // One gentle sine cycle perpendicular to the line axis.
        const restWave = Math.sin(t * TWO_PI * 1.5 + phase + time * driftSpeed);
        px += perpX * restWave * amplitude;
        py += perpY * restWave * amplitude;

        // Slow, independent Z drift so the line subtly moves in depth.
        pz += Math.sin(t * Math.PI + phase * 0.44 + time * 0.16) * 5.0;

        // ── LOW: separation offset (the whole line moves as one) ─────────────
        px += sepX;
        py += sepY;

        // ── MID: controlled ripple ────────────────────────────────────────────
        // Higher-frequency wave (3.5 cycles) at bounded amplitude — never goes mad.
        const ripple = Math.sin(t * TWO_PI * 3.5 + phase * 1.25 + time * 2.1);
        const rippleAmp = midEff * amplitude * 0.55;
        px += perpX * ripple * rippleAmp;
        py += perpY * ripple * rippleAmp;

        posArr[j * 3 + 0] = px;
        posArr[j * 3 + 1] = py;
        posArr[j * 3 + 2] = pz;

        // ── Colour ────────────────────────────────────────────────────────────
        // HIGH: travelling shimmer (bright spot moving along the line).
        const shimmer = Math.max(0, Math.sin(t * TWO_PI * 3.0 + phase + time * 5.5))
                       * highEff;
        // HIGH hit: sharper, faster sparkle on a different phase.
        const sparkle = Math.max(0, Math.sin(t * TWO_PI * 5.0 + phase * 1.65 + time * 8.5))
                       * highHitEff;

        const brightness = 0.52
          + lowHitEff  * 0.35
          + midEff     * 0.14
          + shimmer    * 0.82
          + sparkle    * 0.95;

        colArr[j * 3 + 0] = scratch.r * brightness;
        colArr[j * 3 + 1] = scratch.g * brightness;
        colArr[j * 3 + 2] = scratch.b * brightness;
      }

      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  return {
    root: group,
    onFrame,
    /** Update mutable volume so onFrame always uses the current aspect. */
    onFraming(hw, hh, hd) { vol.halfW = hw; vol.halfH = hh; vol.halfD = hd; },
    dispose() {
      for (const s of lines) s.geo.dispose();
      mat.dispose();
    },
  };
}

export const silkLinesTemplate: VisualTemplate = {
  id: "silk-lines",
  create: build,
};
