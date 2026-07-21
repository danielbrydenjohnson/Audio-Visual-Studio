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
 * WIREFRAME CORE — a simple nested 3D wireframe shape pulsing and unfolding in
 * space. One strong readable structure: concentric wireframe shells (octahedron
 * → diamond cube → icosahedron, repeating) nested from a small inner core to a
 * large outer shell, plus a few tilted orbit rings between them. Corner nodes
 * sit at each shell's vertices as small luminous points.
 *
 * Every shell/ring has its own rotation axis rates, breathing phase, depth
 * drift, brightness, colour position and Low/Mid/High affinities — the layers
 * move independently, so the core feels alive and mechanical rather than one
 * spinning logo. The root group is NEVER rotated or scaled as a whole.
 *
 *   LOW  → low-tuned shells pulse in scale + edge brightness; selected shells
 *          push forward/back a little; their corner nodes grow briefly
 *   MID  → mid-tuned shells twist faster / phase-shift independently, with a
 *          small positional wobble
 *   HIGH → a changing subset of shells glints; corner nodes sparkle on their
 *          own changing subsets
 *
 * All rotation angles accumulate with dt and wrap modulo 2π (no unbounded
 * floats, no React state). Efficient: EdgesGeometry line shells + one small
 * Points cloud per polyhedron shell — a handful of draw calls in total.
 */

const SHELLS: Record<DensityLevel, number> = { low: 4, medium: 6, high: 9 };
const RINGS:  Record<DensityLevel, number> = { low: 2, medium: 3, high: 4 };

const TAU = Math.PI * 2;

function fract(x: number): number { return x - Math.floor(x); }

/** Polyhedron for shell index i — simple, instantly readable forms only. */
function shellGeometry(i: number, r: number): THREE.BufferGeometry {
  switch (i % 3) {
    case 0:  return new THREE.OctahedronGeometry(r, 0);
    case 1:  return new THREE.BoxGeometry(r * 1.15, r * 1.15, r * 1.15);
    default: return new THREE.IcosahedronGeometry(r, 0);
  }
}

/** Flat circle ring (LineLoop positions) of radius r in the xy plane. */
function ringGeometry(r: number, segs = 96): THREE.BufferGeometry {
  const p = new Float32Array(segs * 3);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * TAU;
    p[i * 3 + 0] = Math.cos(a) * r;
    p[i * 3 + 1] = Math.sin(a) * r;
    p[i * 3 + 2] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

/** Deduplicated vertex positions of a geometry (for corner-node points). */
function uniqueVertices(geo: THREE.BufferGeometry): Float32Array {
  const pos = geo.attributes.position;
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x, y, z);
    }
  }
  return new Float32Array(out);
}

interface Layer {
  /** Group holding the line shell (+ corner nodes for polyhedra). */
  group:     THREE.Group;
  lineMat:   THREE.LineBasicMaterial;
  nodeMat:   THREE.PointsMaterial | null;
  /** Current accumulated rotation angles (wrapped mod 2π). */
  ax: number; ay: number; az: number;
  /** Base rotation rates per axis (rad/s at 100% speed). */
  rx: number; ry: number; rz: number;
  breatheAmp:   number;
  breatheSpeed: number;
  breathePhase: number;
  driftAmp:     number;
  driftSpeed:   number;
  driftPhase:   number;
  /** LOW push direction: +1 toward camera, -1 away. */
  pushDir:      number;
  baseScale:    number;
  seed:         number;
  cmix:         number;
  lowAff:  number;
  midAff:  number;
  highAff: number;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const shellCount = SHELLS[density];
  const ringCount  = RINGS[density];

  const B    = Math.min(halfW, halfH);
  const rMin = B * 0.16;
  const rMax = B * 0.72;

  const root = new THREE.Group();
  const layers: Layer[] = [];
  const toDispose: Array<{ dispose(): void }> = [];

  function lineMaterial(): THREE.LineBasicMaterial {
    const m = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.7,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    toDispose.push(m);
    return m;
  }

  // ── Nested polyhedron shells (inner core → outer shell) ────────────────────
  for (let i = 0; i < shellCount; i++) {
    const t = shellCount === 1 ? 0 : i / (shellCount - 1);
    const r = rMin + (rMax - rMin) * t;

    const base  = shellGeometry(i, r);
    const edges = new THREE.EdgesGeometry(base);
    toDispose.push(edges);
    const lMat = lineMaterial();
    const seg  = new THREE.LineSegments(edges, lMat);
    seg.frustumCulled = false;

    // Corner nodes at this shell's vertices (6 / 8 / 12 points — cheap).
    const verts   = uniqueVertices(base);
    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    toDispose.push(nodeGeo);
    const nMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.6, transparent: true,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    toDispose.push(nMat);
    const nodes = new THREE.Points(nodeGeo, nMat);
    nodes.frustumCulled = false;
    base.dispose(); // edges + nodes hold their own copies now

    const group = new THREE.Group();
    group.add(seg);
    group.add(nodes);
    // Cubes start rotated so they read as diamonds in the nest.
    if (i % 3 === 1) group.rotation.set(Math.PI / 4, 0, Math.PI / 4);
    root.add(group);

    const [l, m, h] = randomAffinities();
    layers.push({
      group, lineMat: lMat, nodeMat: nMat,
      ax: group.rotation.x, ay: 0, az: group.rotation.z,
      rx: rand(0.06, 0.22) * (Math.random() < 0.5 ? -1 : 1),
      ry: rand(0.06, 0.22) * (Math.random() < 0.5 ? -1 : 1),
      rz: rand(0.03, 0.12) * (Math.random() < 0.5 ? -1 : 1),
      breatheAmp: rand(0.025, 0.06), breatheSpeed: rand(0.3, 0.8), breathePhase: rand(0, TAU),
      driftAmp: rand(2, 6), driftSpeed: rand(0.15, 0.45), driftPhase: rand(0, TAU),
      pushDir: Math.random() < 0.5 ? 1 : -1,
      baseScale: 1,
      seed: rand(0, 1000),
      cmix: t,
      lowAff: l, midAff: m, highAff: h,
    });
  }

  // ── Tilted orbit rings between the shells ──────────────────────────────────
  for (let j = 0; j < ringCount; j++) {
    const t = ringCount === 1 ? 0.5 : j / (ringCount - 1);
    const r = rMin + (rMax - rMin) * (0.30 + t * 0.62);

    const geo  = ringGeometry(r);
    toDispose.push(geo);
    const lMat = lineMaterial();
    const loop = new THREE.LineLoop(geo, lMat);
    loop.frustumCulled = false;

    const group = new THREE.Group();
    group.add(loop);
    group.rotation.x = 0.5 + j * 0.55; // distinct static tilts
    group.rotation.y = j * 0.9;
    root.add(group);

    const [l, m, h] = randomAffinities();
    layers.push({
      group, lineMat: lMat, nodeMat: null,
      ax: group.rotation.x, ay: group.rotation.y, az: 0,
      rx: rand(0.02, 0.08) * (Math.random() < 0.5 ? -1 : 1),
      ry: rand(0.02, 0.08) * (Math.random() < 0.5 ? -1 : 1),
      rz: rand(0.10, 0.30) * (Math.random() < 0.5 ? -1 : 1), // rings spin in-plane
      breatheAmp: rand(0.015, 0.04), breatheSpeed: rand(0.25, 0.6), breathePhase: rand(0, TAU),
      driftAmp: rand(1.5, 4), driftSpeed: rand(0.12, 0.35), driftPhase: rand(0, TAU),
      pushDir: Math.random() < 0.5 ? 1 : -1,
      baseScale: 1,
      seed: rand(0, 1000),
      cmix: 0.35 + t * 0.5,
      lowAff: l, midAff: m, highAff: h,
    });
  }

  const tmpC = new THREE.Color();
  let hd = halfD;

  return {
    root,
    onFrame(time, dt, audio) {
      const sp = shared.uSpeed.value, es = shared.uElementSize.value, gl = shared.uGlow.value;
      const ca = shared.uColorA.value, cb = shared.uColorB.value, cc = shared.uColorC.value;
      const depthScale = hd / 55; // Depth control widens/narrows z travel

      for (const L of layers) {
        const lowR  = audio.low  * L.lowAff;
        const midR  = audio.mid  * L.midAff;
        const highR = audio.high * L.highAff;

        // HIGH: changing subset glints (edges) on this layer's own seed.
        const glint = highR * (fract(Math.sin(L.seed + time * 2.7) * 43758.5453) > 0.62 ? 1 : 0);

        // Independent rotation — MID whips this layer's own rate. Accumulated
        // with dt and wrapped so nothing grows unbounded.
        const rateBoost = 1 + midR * 2.4;
        L.ax = (L.ax + dt * sp * L.rx * rateBoost) % TAU;
        L.ay = (L.ay + dt * sp * L.ry * rateBoost) % TAU;
        L.az = (L.az + dt * sp * L.rz * rateBoost) % TAU;
        L.group.rotation.set(L.ax, L.ay, L.az);

        // Breathe + LOW pulse (this shell only — never the root).
        const breathe = 1 + Math.sin(time * L.breatheSpeed + L.breathePhase) * L.breatheAmp
                          + lowR * 0.30 + glint * 0.06;
        L.group.scale.setScalar(L.baseScale * es * breathe);

        // Depth drift + LOW push forward/back; MID adds a small lateral wobble.
        const z = Math.sin(time * L.driftSpeed + L.driftPhase) * L.driftAmp * depthScale
                + lowR * 7 * L.pushDir * depthScale;
        L.group.position.set(
          Math.sin(time * L.driftSpeed * 1.3 + L.driftPhase) * midR * 2.5,
          Math.cos(time * L.driftSpeed * 1.1 + L.driftPhase) * midR * 2.5,
          Math.max(-hd * 0.8, Math.min(hd * 0.8, z)),
        );

        // Edge colour/opacity.
        paletteMix(L.cmix, ca, cb, cc, tmpC);
        const eB = 0.50 + gl * 0.65 + lowR * 0.55 + midR * 0.30 + glint * 1.60;
        L.lineMat.color.setRGB(tmpC.r * eB, tmpC.g * eB, tmpC.b * eB);
        L.lineMat.opacity = Math.min(1, 0.42 + gl * 0.22 + lowR * 0.30 + glint * 0.50);

        // Corner nodes: LOW grows them briefly, HIGH sparkles a different subset.
        if (L.nodeMat) {
          const nodeSpark = highR * (fract(Math.sin(L.seed * 1.7 + 9.1 + time * 4.3) * 43758.5453) > 0.55 ? 1 : 0);
          L.nodeMat.size = Math.max(0.8, 1.6 * es * (1 + lowR * 0.55 + nodeSpark * 1.2));
          const nB = 0.75 + gl * 0.55 + nodeSpark * 2.0 + lowR * 0.45;
          L.nodeMat.color.setRGB(tmpC.r * nB, tmpC.g * nB, tmpC.b * nB);
          L.nodeMat.opacity = Math.min(1, 0.55 + gl * 0.25 + nodeSpark * 0.45 + lowR * 0.25);
        }
      }
    },
    onFraming(_nw, _nh, nd) { hd = nd; },
    dispose() {
      for (const d of toDispose) d.dispose();
    },
  };
}

export const wireframeCoreTemplate: VisualTemplate = {
  id: "wireframe-core",
  create: build,
};
