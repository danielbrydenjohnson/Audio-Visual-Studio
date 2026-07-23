import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  rand,
  paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * WIREFRAME BLOOM — exactly THREE primary wireframe forms (EdgesGeometry →
 * LineSegments): a torus (donut), a diamond (vertically stretched octahedron)
 * and an octahedron. Each occupies its own position and depth and moves,
 * rotates and pulses INDEPENDENTLY — deliberately simplified from the old
 * many-layer stack so every form stays clear and readable. Density never adds
 * shapes; it only refines the torus tessellation.
 *
 *   LOW  → each form EXPANDS in size — a breathing pulse with a different
 *          character per form (torus broad, diamond sharpest, octahedron
 *          calmest); the sustained level adds gentle outward pressure
 *   MID  → individual twist/rotation at differing rates, phases and directions
 *   HIGH → a changing subset brightens / flickers with restraint
 *
 * Hit envelopes (transients) on top, per form:
 *
 *   LOW hit  → the breathing punch — a bounded per-form scale expansion that
 *              eases back as the envelope decays (plus a small forward shove);
 *              never an explosion, still composed at 200% influence
 *   MID hit  → rotation-rate burst that decays with the envelope
 *   HIGH hit → fast-reshuffling subset glints brighter for an instant
 *
 * The root group is never rotated or scaled as the main motion.
 */

/** Density refines the torus tessellation only — always exactly three forms. */
const TORUS_SEGS: Record<DensityLevel, [number, number]> = {
  low: [6, 14], medium: [8, 18], high: [10, 24],
};

function fract(x: number): number { return x - Math.floor(x); }

const TAU = Math.PI * 2;

interface Form {
  seg:   THREE.LineSegments;
  mat:   THREE.LineBasicMaterial;
  edges: THREE.EdgesGeometry;
  baseScale: number;
  rotSX: number; rotSY: number; rotSZ: number;
  posX: number; posY: number; posZ: number;
  driftAmp: number; driftSpeed: number; driftPhase: number;
  phase: number; seed: number; cmix: number;
  lowAff: number; midAff: number; highAff: number;
  /** LOW expansion character — sustained (level) and punch (hit) amounts. */
  expandLevel: number; expandHit: number;
  /** MID-hit rotation burst (radians) — direct envelope, decays naturally. */
  hitTwist: number;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const root = new THREE.Group();
  const forms: Form[] = [];
  const [tubeSegs, radSegs] = TORUS_SEGS[density];

  // The three primary forms. Each gets its own geometry, home position and
  // LOW-expansion character (how much it breathes on level vs. kick punch).
  const specs = [
    {
      // Torus — the roundest form; broad, generous breathing.
      make: () => new THREE.TorusGeometry(19, 19 * 0.34, tubeSegs, radSegs),
      px: -halfW * 0.20, py: halfH * 0.08, pz: -halfD * 0.25,
      expandLevel: 0.10, expandHit: 0.34,
    },
    {
      // Diamond — an octahedron stretched vertically reads as a classic gem
      // silhouette; it gets the sharpest expansion punch.
      make: () => {
        const g = new THREE.OctahedronGeometry(12, 0);
        g.scale(1, 1.6, 1);
        return g;
      },
      px: halfW * 0.22, py: -halfH * 0.10, pz: halfD * 0.15,
      expandLevel: 0.12, expandHit: 0.42,
    },
    {
      // Octahedron — the calmest breather.
      make: () => new THREE.OctahedronGeometry(15, 0),
      px: halfW * 0.02, py: halfH * 0.02, pz: halfD * 0.55,
      expandLevel: 0.08, expandHit: 0.26,
    },
  ];

  specs.forEach((spec, i) => {
    const base = spec.make();
    const edges = new THREE.EdgesGeometry(base);
    base.dispose(); // edges keeps its own copy of the line data
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const seg = new THREE.LineSegments(edges, mat);
    seg.frustumCulled = false;
    forms.push({
      seg, mat, edges,
      baseScale: 1,
      rotSX: rand(-0.18, 0.18), rotSY: rand(-0.18, 0.18), rotSZ: rand(-0.18, 0.18),
      posX: spec.px, posY: spec.py, posZ: spec.pz,
      driftAmp: rand(5, 10), driftSpeed: rand(0.2, 0.5), driftPhase: rand(0, TAU),
      phase: rand(0, TAU), seed: rand(0, 1000), cmix: i / 2,
      // All three forms answer LOW (expansion IS this template's Low
      // signature); MID/HIGH strengths vary per form so each stays individual.
      lowAff: 1, midAff: rand(0.45, 1), highAff: rand(0.45, 1),
      expandLevel: spec.expandLevel, expandHit: spec.expandHit,
      hitTwist: 0,
    });
    root.add(seg);
  });

  const tmpCol = new THREE.Color();
  let hd = halfD;

  return {
    root,
    onFrame(time, dt, audio) {
      const speed = shared.uSpeed.value;
      const esize = shared.uElementSize.value;
      const glow  = shared.uGlow.value;
      const a = shared.uColorA.value, b = shared.uColorB.value, c = shared.uColorC.value;
      // High-hit glints reshuffle their subset ~24×/s (independent of the
      // slower level-driven flicker subset).
      const glintSlot = Math.floor(time * 24);

      for (const f of forms) {
        const lowR  = audio.low  * f.lowAff;
        const midR  = audio.mid  * f.midAff;
        const highR = audio.high * f.highAff;
        const lowHitR  = audio.lowHit  * f.lowAff;
        const midHitR  = audio.midHit  * f.midAff;
        const highHitR = audio.highHit * f.highAff;

        const tw = fract(Math.sin(f.seed + time * 3.0) * 43758.5453);
        const flick = highR * (tw > 0.6 ? 1 : 0);
        // HIGH hit: independent fast-reshuffling subset → sharper glint.
        const twHit = fract(Math.sin(f.seed * 7.7 + glintSlot * 13.13) * 43758.5453);
        const spark = highHitR * (twHit > 0.55 ? 1 : 0);

        // MID hit: very restrained rotation accent — bounded direct envelope,
        // decays naturally each frame, never accumulates.
        f.hitTwist = midHitR * 0.30;

        // Independent rotation (MID provides a subtle extra speed, not a
        // dramatic spin-up — forms stay readable and elegant at 200% influence).
        const rs = speed * (1 + midR * 0.10);
        const twistDir = f.rotSZ < 0 ? -1 : 1;
        f.seg.rotation.set(
          f.rotSX * time * rs + f.phase,
          f.rotSY * time * rs * 1.05,
          f.rotSZ * time * rs * 0.95 + f.hitTwist * twistDir,
        );
        // LOW: this form's own breathing expansion — the level applies gentle
        // sustained pressure and the hit envelope punches the scale outward,
        // each form by its own amount, easing back as the envelope decays.
        // The group is never scaled as one.
        const s = f.baseScale * esize * (1 + lowR * f.expandLevel + lowHitR * f.expandHit + flick * 0.22 + spark * 0.12);
        f.seg.scale.set(s, s, s);
        // Independent forward/back drift, clamped inside the depth volume.
        // LOW adds only a small forward shove (expansion leads, not travel).
        const z = f.posZ + Math.sin(time * f.driftSpeed + f.driftPhase) * f.driftAmp + lowR * 6.0 + lowHitR * 8.0;
        f.seg.position.set(
          f.posX,
          f.posY + Math.cos(time * f.driftSpeed * 0.8 + f.driftPhase) * f.driftAmp * 0.4,
          Math.max(-hd, Math.min(hd, z)),
        );

        // Colour: palette base × per-form brightness (glow + LOW + MID + HIGH
        // flicker + hit accents on their own subsets).
        paletteMix(f.cmix, a, b, c, tmpCol);
        const bright = 0.55 + glow * 0.7 + lowR * 0.3 + lowHitR * 0.35 + midR * 0.15 + flick * 1.5 + spark * 1.7;
        f.mat.color.setRGB(tmpCol.r * bright, tmpCol.g * bright, tmpCol.b * bright);
        f.mat.opacity = Math.min(1, 0.5 + lowR * 0.3 + lowHitR * 0.25 + flick * 0.5 + spark * 0.45 + glow * 0.2);
      }
    },
    onFraming(_nw, _nh, nd) {
      hd = nd;
    },
    dispose() {
      for (const f of forms) {
        f.edges.dispose();
        f.mat.dispose();
      }
    },
  };
}

export const wireframeBloomTemplate: VisualTemplate = {
  id: "wireframe-bloom",
  create: build,
};
