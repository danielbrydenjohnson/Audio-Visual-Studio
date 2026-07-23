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
 * ORBITAL THREADS — the same smooth luminous lines as Silk Lines, each with a
 * small sphere anchored at both endpoints AND at the line's midpoint. Spheres
 * travel with their anchor points on the line, receive a subtle scale punch on
 * LOW hits, and sparkle on HIGH hits.
 *
 * Density:
 *   Low = 5 lines / 15 spheres  |  Medium = 9 / 27  |  High = 14 / 42
 *
 * All N*3 spheres are rendered as one THREE.InstancedMesh (single draw call).
 * The InstancedMesh is added to the same Group root after the line objects, so
 * it draws on top of and blends additively with the lines.
 *
 * Audio mapping:
 *   LOW      → separation: each line pushes along its perpendicular AWAY from
 *               the scene centre (fixed direction, varied amount). All three
 *               spheres sit ON the line, so they separate consistently with it.
 *   LOW hit  → quick extra separation push + scale punch on spheres + brightness.
 *   MID      → gentle curve deformation per line — the thread flexes through its
 *               curve shape. Each line responds individually (own phase/amount).
 *               Spheres follow the updated line positions automatically.
 *   MID hit  → brief extra flex accent, decays with the envelope.
 *   HIGH     → travelling shimmer along lines. Spheres sparkle on high hits.
 *   HIGH hit → sharper sphere sparkle (small glints, not flashing bulbs).
 */

const COUNTS: Record<DensityLevel, number> = { low: 5, medium: 9, high: 14 };
const PTS      = 32;        // vertices per line
const TWO_PI   = Math.PI * 2;
const SPHERE_R = 0.85;      // world-unit radius — small and elegant

interface LineState {
  cxF: number; cyF: number; czF: number;
  ax: number; ay: number;
  perpX: number; perpY: number;
  lengthF: number;
  amplitude: number;
  phase: number;
  driftSpeed: number;
  colorT: number;
  affLow: number; affMid: number; affHigh: number;
  /** Fixed separation direction along ±perp — points AWAY from the scene centre. */
  sepDir: number;
  /** Per-line separation magnitude variation. */
  sepVary: number;
  geo: THREE.BufferGeometry;
  posArr: Float32Array;
  colArr: Float32Array;
}

// ─── Per-line geometry ────────────────────────────────────────────────────────

function buildLines(
  n: number,
  halfW: number, halfH: number, halfD: number,
  group: THREE.Group,
  mat: THREE.LineBasicMaterial,
): LineState[] {
  const states: LineState[] = [];
  for (let i = 0; i < n; i++) {
    const angle = rand(-Math.PI * 0.30, Math.PI * 0.30);
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);

    const cx = rand(-halfW * 0.55, halfW * 0.55);
    const cy = rand(-halfH * 0.50, halfH * 0.50);
    const cz = rand(-halfD * 0.25, halfD * 0.25);
    const length = rand(halfW * 1.05, halfW * 1.55);

    const posArr = new Float32Array(PTS * 3);
    const colArr = new Float32Array(PTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute("color",    new THREE.BufferAttribute(colArr, 3));

    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    group.add(line);

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

  // ── Lines ─────────────────────────────────────────────────────────────────
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent:  true,
    blending:     THREE.AdditiveBlending,
    depthWrite:   false,
    depthTest:    false,
  });
  const lines = buildLines(n, halfW, halfH, halfD, group, lineMat);
  const vol   = { halfW, halfH, halfD };

  // ── Spheres (one InstancedMesh, single draw call) ─────────────────────────
  // Three spheres per line: both endpoints + the midpoint (3/6/9 lines → 9/18/27).
  const sphereCount = n * 3;
  const sphereGeo = new THREE.SphereGeometry(SPHERE_R, 7, 5);
  const sphereMat = new THREE.MeshBasicMaterial({
    color:       0xffffff,
    transparent: true,
    blending:    THREE.AdditiveBlending,
    depthWrite:  false,
    depthTest:   false,
  });
  const sphereMesh = new THREE.InstancedMesh(sphereGeo, sphereMat, sphereCount);
  sphereMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sphereMesh.frustumCulled = false;
  group.add(sphereMesh);

  // Scratch objects — allocated once, reused every frame.
  const scratch  = new THREE.Color();
  const sphColor = new THREE.Color();
  const _m4      = new THREE.Matrix4();

  function onFrame(time: number, _dt: number, audio: AudioLevels): void {
    const ca = shared.uColorA.value;
    const cb = shared.uColorB.value;
    const cc = shared.uColorC.value;

    for (let li = 0; li < lines.length; li++) {
      const s = lines[li];
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
      const midHitEff  = audio.midHit  * affMid;
      const highHitEff = audio.highHit * affHigh;

      // LOW: separation — the whole line (and its spheres) pushes along its
      // perpendicular AWAY from the scene centre (sepDir fixed at build), so
      // bass opens space between the threads instead of oscillating them.
      // Level = sustained spacing pressure; hit = quick push that eases back
      // with the envelope. Direction + magnitude vary per line.
      const sepAmt = (lowEff * 5.5 + lowHitEff * 7.0) * sepDir * sepVary;
      const sepX = perpX * sepAmt;
      const sepY = perpY * sepAmt;

      for (let j = 0; j < PTS; j++) {
        const t = j / (PTS - 1);
        const u = t - 0.5;

        let px = cx + ax * u * length;
        let py = cy + ay * u * length;
        let pz = cz;

        // Resting undulation
        const restWave = Math.sin(t * TWO_PI * 1.5 + phase + time * driftSpeed);
        px += perpX * restWave * amplitude;
        py += perpY * restWave * amplitude;

        // Slow Z drift
        pz += Math.sin(t * Math.PI + phase * 0.44 + time * 0.16) * 5.0;

        // LOW: separation offset (the whole line moves as one)
        px += sepX;
        py += sepY;

        // MID: gentle curve deformation — fewer cycles than a ripple so the
        // line flexes / breathes rather than wiggling. Per-line phase (already
        // varied at build) keeps each thread individual. midHit adds a brief
        // extra flex accent that eases back with the envelope.
        const flex = Math.sin(t * TWO_PI * 1.8 + phase * 1.4 + time * 1.1);
        const flexAmp = (midEff * 0.40 + midHitEff * 0.26) * amplitude;
        px += perpX * flex * flexAmp;
        py += perpY * flex * flexAmp;

        posArr[j * 3 + 0] = px;
        posArr[j * 3 + 1] = py;
        posArr[j * 3 + 2] = pz;

        // Colour: travelling shimmer + sparkle
        const shimmer = Math.max(0, Math.sin(t * TWO_PI * 3.0 + phase + time * 5.5))
                       * highEff;
        const sparkle = Math.max(0, Math.sin(t * TWO_PI * 5.0 + phase * 1.65 + time * 8.5))
                       * highHitEff;

        const brightness = 0.52
          + lowHitEff * 0.35
          + midEff    * 0.14
          + shimmer   * 0.82
          + sparkle   * 0.95;

        colArr[j * 3 + 0] = scratch.r * brightness;
        colArr[j * 3 + 1] = scratch.g * brightness;
        colArr[j * 3 + 2] = scratch.b * brightness;
      }

      (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (geo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;

      // ── Spheres: follow the line's endpoints + midpoint ───────────────────
      // posArr is already filled for this line — read the first, middle and
      // last points, so every sphere (including the Low separation) stays ON
      // the line.
      const i0  = 0;
      const iM  = (PTS >> 1) * 3; // midpoint vertex — rides the mid ripple at t≈0.5
      const i1  = (PTS - 1) * 3;
      const p0x = posArr[i0],     p0y = posArr[i0 + 1], p0z = posArr[i0 + 2];
      const pMx = posArr[iM],     pMy = posArr[iM + 1], pMz = posArr[iM + 2];
      const p1x = posArr[i1],     p1y = posArr[i1 + 1], p1z = posArr[i1 + 2];

      // Sphere: subtle scale punch on low hit; slight forward pop on high hit.
      const sphScale  = 1.0 + lowHitEff * 0.30 + highHitEff * 0.18;
      // Sphere: slightly brighter than the line; sparkle on high hit.
      const sphBright = 0.88 + lowHitEff * 0.42 + highHitEff * 0.58;

      paletteMix(colorT, ca, cb, cc, sphColor);
      sphColor.multiplyScalar(sphBright);

      // Start / midpoint / end spheres — same small, elegant size and styling.
      _m4.makeScale(sphScale, sphScale, sphScale);
      _m4.setPosition(p0x, p0y, p0z);
      sphereMesh.setMatrixAt(li * 3, _m4);

      _m4.setPosition(pMx, pMy, pMz);
      sphereMesh.setMatrixAt(li * 3 + 1, _m4);

      _m4.setPosition(p1x, p1y, p1z);
      sphereMesh.setMatrixAt(li * 3 + 2, _m4);

      // setColorAt auto-initialises instanceColor on the first call.
      sphereMesh.setColorAt(li * 3,     sphColor);
      sphereMesh.setColorAt(li * 3 + 1, sphColor);
      sphereMesh.setColorAt(li * 3 + 2, sphColor);
    }

    sphereMesh.instanceMatrix.needsUpdate = true;
    if (sphereMesh.instanceColor) sphereMesh.instanceColor.needsUpdate = true;
  }

  return {
    root: group,
    onFrame,
    onFraming(hw, hh, hd) { vol.halfW = hw; vol.halfH = hh; vol.halfD = hd; },
    dispose() {
      for (const s of lines) s.geo.dispose();
      lineMat.dispose();
      sphereGeo.dispose();
      sphereMat.dispose();
      sphereMesh.dispose(); // releases the instance matrix/color GPU buffers
    },
  };
}

export const orbitalThreadsTemplate: VisualTemplate = {
  id: "orbital-threads",
  create: build,
};
