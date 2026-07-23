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
 * SACRED GEOMETRY BLOOM — layered radial line geometry built from generic
 * constructions only (circles, regular polygons, star rings and a flower-of-life
 * style cluster of interlocking circles). Concentric layers sit at varied depths
 * and each animates INDEPENDENTLY — no whole-scene rotate/scale. Density controls
 * how many layers bloom.
 *
 *   LOW  → each layer breathes (local radial pulse), on its own phase
 *   MID  → layers rotate about z at independent rates, phases and directions
 *   HIGH → a changing subset of layers flickers brighter with restraint
 *
 * Hit envelopes (transients) on top, per layer:
 *
 *   LOW hit  → radial pulse that punches inner layers hardest (the kick blooms
 *              outward from the centre) — never one uniform scene scale
 *   MID hit  → rotation-rate burst, integrated per layer (keeps its new phase)
 *   HIGH hit → fast-reshuffling subset of layers glints for an instant
 *
 * Uses only generic geometric constructions — no copyrighted iconography.
 * There is deliberately NO square/rectangular frame around the composition —
 * the polygon family skips 4-sided rings so circular forms stay the focus.
 */

const LAYERS: Record<DensityLevel, number> = { low: 6, medium: 10, high: 15 };

const TAU = Math.PI * 2;

/** A closed ring polyline as LineSegments (each edge = 2 verts, one draw call). */
function ringSegments(radius: number, sides: number): THREE.BufferGeometry {
  const seg = Math.max(3, sides);
  const pos = new Float32Array(seg * 2 * 3); // seg edges × 2 verts × xyz
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const o = i * 6;
    pos[o + 0] = Math.cos(a0) * radius; pos[o + 1] = Math.sin(a0) * radius; pos[o + 2] = 0;
    pos[o + 3] = Math.cos(a1) * radius; pos[o + 4] = Math.sin(a1) * radius; pos[o + 5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

/** A star ring: a single closed polyline stepping around by `skip` vertices. */
function starSegments(radius: number, points: number, skip: number): THREE.BufferGeometry {
  const n = Math.max(5, points);
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const a0 = ((i * skip) % n) / n * Math.PI * 2;
    const a1 = (((i + 1) * skip) % n) / n * Math.PI * 2;
    const o = i * 6;
    pos[o + 0] = Math.cos(a0) * radius; pos[o + 1] = Math.sin(a0) * radius; pos[o + 2] = 0;
    pos[o + 3] = Math.cos(a1) * radius; pos[o + 4] = Math.sin(a1) * radius; pos[o + 5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

/**
 * Flower-of-life style cluster: a central circle plus a ring of interlocking
 * circles whose centres sit one radius out (generic circle-packing construction).
 */
function flowerSegments(radius: number, ringCount: number): THREE.BufferGeometry {
  const petals = 32; // segments per circle
  const centres: [number, number][] = [[0, 0]];
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2;
    centres.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  const pos = new Float32Array(centres.length * petals * 2 * 3);
  let o = 0;
  for (const [cx, cy] of centres) {
    for (let i = 0; i < petals; i++) {
      const a0 = (i / petals) * Math.PI * 2;
      const a1 = ((i + 1) / petals) * Math.PI * 2;
      pos[o++] = cx + Math.cos(a0) * radius; pos[o++] = cy + Math.sin(a0) * radius; pos[o++] = 0;
      pos[o++] = cx + Math.cos(a1) * radius; pos[o++] = cy + Math.sin(a1) * radius; pos[o++] = 0;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

/** Build a varied generic construction for layer index i. */
function layerGeometry(i: number, r: number): THREE.BufferGeometry {
  switch (i % 5) {
    case 0:  return ringSegments(r, 64);                 // circle
    case 1:  return ringSegments(r, 6);                  // hexagon
    case 2:  return starSegments(r, 12, 5);              // 12-point star ring
    case 3:  return flowerSegments(r * 0.5, 6);          // flower-of-life cluster
    // Polygon family: triangle / pentagon / hexagon — never 4 sides. The square
    // outer frame was removed by request; circular forms stay the focus.
    default: return ringSegments(r, [3, 5, 6][i % 3]);
  }
}

interface Layer {
  seg:   THREE.LineSegments;
  mat:   THREE.LineBasicMaterial;
  geo:   THREE.BufferGeometry;
  baseScale: number;
  rotRate:   number; // signed independent rotation rate
  rotPhase:  number;
  posZ:      number;
  pulseAmp:  number; pulseSpeed: number; pulsePhase: number;
  seed:  number; cmix: number;
  lowAff: number; midAff: number; highAff: number;
  /**
   * How much Mid rotation applies to this layer: 1.0 = full (innermost),
   * fades to 0 for outer layers — so only the central section spins on Mid.
   */
  centralFactor: number;
  /** Accumulated MID-hit rotation burst (radians, wrapped). */
  hitRot: number;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const count = LAYERS[density];
  const root = new THREE.Group();
  const layers: Layer[] = [];

  const maxR = Math.min(halfW, halfH) * 0.9;

  for (let i = 0; i < count; i++) {
    // Concentric radii spread from small to frame-filling.
    const r = maxR * (0.18 + 0.82 * (i / Math.max(1, count - 1)));
    const geo = layerGeometry(i, r);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const seg = new THREE.LineSegments(geo, mat);
    seg.frustumCulled = false;

    const [l, m, h] = randomAffinities();
    layers.push({
      seg, mat, geo,
      baseScale: 1,
      rotRate:  rand(0.08, 0.5) * (Math.random() < 0.5 ? -1 : 1),
      rotPhase: rand(0, Math.PI * 2),
      // Layers fan out through the depth volume so bloom reads in 3D.
      posZ:     (i / Math.max(1, count - 1) * 2 - 1) * halfD * 0.7,
      pulseAmp: rand(0.06, 0.2), pulseSpeed: rand(0.3, 0.9), pulsePhase: rand(0, Math.PI * 2),
      seed: rand(0, 1000), cmix: i / Math.max(1, count - 1),
      lowAff: l, midAff: m, highAff: h,
      // Innermost layers (small cmix) get full Mid rotation; this falls to
      // zero by cmix ≈ 0.25 so outer circles remain visually stable on Mid.
      centralFactor: Math.max(0, 1.0 - (i / Math.max(1, count - 1)) * 4.0),
      hitRot: 0,
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
      // High-hit glints reshuffle which layers light up ~24×/s.
      const glintSlot = Math.floor(time * 24);

      for (const L of layers) {
        const lowR  = audio.low  * L.lowAff;
        const midR  = audio.mid  * L.midAff;
        const highR = audio.high * L.highAff;
        const lowHitR  = audio.lowHit  * L.lowAff;
        const midHitR  = audio.midHit  * L.midAff;
        const highHitR = audio.highHit * L.highAff;

        const tw = (Math.sin(L.seed + time * 3.0) * 43758.5453) % 1;
        const flick = highR * (Math.abs(tw) > 0.6 ? 1 : 0);
        // HIGH hit: independent fast-reshuffling layer subset.
        const twHit = Math.abs((Math.sin(L.seed * 7.7 + glintSlot * 13.13) * 43758.5453) % 1);
        const spark = highHitR * (twHit > 0.55 ? 1 : 0);

        // MID hit: rotation accent is gated to the central layers only.
        // Bounded direct envelope — decays naturally, no permanent accumulation.
        L.hitRot = midHitR * 0.65 * L.centralFactor;

        // MID: resting rotation continues for ALL layers at their own signed
        // rates (the geometry always drifts gently). The Mid-driven speed-up
        // is multiplied by centralFactor so only the innermost section spins
        // faster on a snare/clap — outer circles remain visually stable.
        const rotDir = L.rotRate < 0 ? -1 : 1;
        L.seg.rotation.z = L.rotPhase
          + time * speed * L.rotRate * (1 + midR * 0.4 * L.centralFactor)
          + L.hitRot * rotDir;

        // LOW: each layer breathes on its own phase (local radial pulse). LOW
        // hits expand the circles outward — inner layers punch slightly harder
        // than outer ones (1 - cmix), so the kick blooms from the centre and
        // symmetry is preserved; never one uniform scene scale.
        const breathe = 1 + Math.sin(time * L.pulseSpeed + L.pulsePhase) * L.pulseAmp;
        const s = esize * breathe * (1 + lowR * 0.45 + lowHitR * (0.32 + 0.28 * (1 - L.cmix)) + flick * 0.18 + spark * 0.1);
        L.seg.scale.set(s, s, s);

        L.seg.position.set(0, 0, Math.max(-hd, Math.min(hd, L.posZ)));

        // Colour: palette base × per-layer brightness (glow + LOW + MID + HIGH
        // + hit accents on their own subsets).
        paletteMix(L.cmix, a, b, c, tmpCol);
        const bright = 0.5 + glow * 0.7 + lowR * 0.28 + lowHitR * 0.3 + midR * 0.12 + flick * 1.4 + spark * 1.6;
        L.mat.color.setRGB(tmpCol.r * bright, tmpCol.g * bright, tmpCol.b * bright);
        L.mat.opacity = Math.min(1, 0.45 + lowR * 0.3 + lowHitR * 0.25 + flick * 0.5 + spark * 0.45 + glow * 0.2);
      }
    },
    onFraming(_nw, _nh, nd) {
      hd = nd;
    },
    dispose() {
      for (const L of layers) {
        L.geo.dispose();
        L.mat.dispose();
      }
    },
  };
}

export const sacredGeometryBloomTemplate: VisualTemplate = {
  id: "sacred-geometry-bloom",
  create: build,
};
