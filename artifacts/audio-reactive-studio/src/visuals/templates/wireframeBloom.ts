import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  rand,
  randomAffinities,
  paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * WIREFRAME BLOOM — a controlled number of wireframe forms (EdgesGeometry →
 * LineSegments) occupying different depths, each moving, rotating, deforming and
 * pulsing INDEPENDENTLY so the result feels architectural rather than one spinning
 * logo. Density controls how many layers exist. Per-form reactions:
 *
 *   LOW  → form expands locally + drifts forward/back on its own path
 *   MID  → individual twist/rotation at differing rates, phases and directions
 *   HIGH → a changing subset brightens / flickers with restraint
 *
 * Hit envelopes (transients) on top, per form:
 *
 *   LOW hit  → shell punch (extra local expansion) + a deeper forward shove
 *   MID hit  → rotation-rate burst, integrated per form (keeps its new phase)
 *   HIGH hit → fast-reshuffling subset glints brighter for an instant
 *
 * The root group is never rotated or scaled as the main motion.
 */

const LAYERS: Record<DensityLevel, number> = { low: 5, medium: 8, high: 12 };

function fract(x: number): number { return x - Math.floor(x); }

const TAU = Math.PI * 2;

/** Build a varied base geometry for layer index i (low-poly, modest segments). */
function baseGeometry(i: number, r: number): THREE.BufferGeometry {
  switch (i % 5) {
    case 0:  return new THREE.IcosahedronGeometry(r, 0);
    case 1:  return new THREE.OctahedronGeometry(r, 0);
    case 2:  return new THREE.DodecahedronGeometry(r, 0);
    case 3:  return new THREE.TorusGeometry(r, r * 0.34, 8, 18);
    default: return new THREE.BoxGeometry(r * 1.4, r * 1.4, r * 1.4, 1, 1, 1);
  }
}

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
  /** Accumulated MID-hit rotation burst (radians, wrapped). */
  hitTwist: number;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const layers = LAYERS[density];
  const root = new THREE.Group();
  const forms: Form[] = [];

  for (let i = 0; i < layers; i++) {
    const r = rand(9, 32);
    const base = baseGeometry(i, r);
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
    const [l, m, h] = randomAffinities();
    forms.push({
      seg, mat, edges,
      baseScale: rand(0.7, 1.25),
      rotSX: rand(-0.5, 0.5), rotSY: rand(-0.5, 0.5), rotSZ: rand(-0.5, 0.5),
      posX: rand(-halfW * 0.35, halfW * 0.35),
      posY: rand(-halfH * 0.35, halfH * 0.35),
      posZ: rand(-halfD * 0.7, halfD * 0.7),
      driftAmp: rand(6, 18), driftSpeed: rand(0.2, 0.7), driftPhase: rand(0, Math.PI * 2),
      phase: rand(0, Math.PI * 2), seed: rand(0, 1000), cmix: Math.random(),
      lowAff: l, midAff: m, highAff: h,
      hitTwist: 0,
    });
    root.add(seg);
  }

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

        // MID hit: rotation-rate burst, integrated per form so it tumbles
        // faster for an instant and keeps its new phase (no rubber-banding).
        if (midHitR > 0.0001) {
          f.hitTwist = (f.hitTwist + midHitR * dt * 7.0) % TAU;
        }

        // Independent rotation (MID speeds each form differently).
        const rs = speed * (1 + midR * 1.7);
        const twistDir = f.rotSZ < 0 ? -1 : 1;
        f.seg.rotation.set(
          f.rotSX * time * rs + f.phase,
          f.rotSY * time * rs * 1.05,
          f.rotSZ * time * rs * 0.95 + f.hitTwist * twistDir,
        );
        // LOW expands this form locally (level breathes, hit punches); the
        // group is never scaled as one.
        const s = f.baseScale * esize * (1 + lowR * 0.55 + lowHitR * 0.35 + flick * 0.25 + spark * 0.12);
        f.seg.scale.set(s, s, s);
        // Independent forward/back drift, clamped inside the depth volume.
        // LOW hits shove the form deeper for an instant.
        const z = f.posZ + Math.sin(time * f.driftSpeed + f.driftPhase) * f.driftAmp + lowR * 10.0 + lowHitR * 14.0;
        f.seg.position.set(
          f.posX,
          f.posY + Math.cos(time * f.driftSpeed * 0.8 + f.driftPhase) * f.driftAmp * 0.4,
          Math.max(-hd, Math.min(hd, z)),
        );

        // Colour: palette base × per-form brightness (glow + LOW + MID + HIGH
        // flicker + hit accents on their own subsets).
        paletteMix(f.cmix, a, b, c, tmpCol);
        const bright = 0.55 + glow * 0.7 + lowR * 0.3 + lowHitR * 0.35 + midR * 0.25 + flick * 1.5 + spark * 1.7;
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
