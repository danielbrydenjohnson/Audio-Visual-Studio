import * as THREE from "three";
import {
  type VisualTemplate, type TemplateCreateArgs, type TemplateRuntime,
  rand, paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * REACTIVE EYE
 *
 * A layered, high-contrast eye built from line and point geometry. The eye
 * structure is always legible at a glance: almond contour → iris rings → pupil.
 *
 * Layers (from back to front in the additive stack):
 *   • Eye contour  — almond shape (two ellipse arcs: fuller top lid, shallow bottom lid)
 *   • Outer points — sparse particles at/beyond the iris edge that shimmer
 *   • irisGroup    — all rotating iris content spins together as one unit
 *       · Iris concentric rings (inner → outer, each at different z depth)
 *       · Radial spokes (from pupil edge to iris rim)
 *   • Pupil ring   — bright small circle; scales subtly with LOW for dilation feel
 *
 *   LOW  → iris rings pulse outward on individual phases; pupil subtly dilates
 *   MID  → the iris group as a whole rotates faster; each ring also brightens
 *   HIGH → outer point ring sparkles; iris ring flickers on changing subsets
 *
 * Works exceptionally well with Kaleidoscope because the eye is radially symmetric.
 */

const DENSITY_CFG: Record<DensityLevel, { irisRings: number; spokes: number; outerPts: number }> = {
  low:    { irisRings: 3, spokes: 16, outerPts: 30 },
  medium: { irisRings: 5, spokes: 24, outerPts: 60 },
  high:   { irisRings: 7, spokes: 36, outerPts: 110 },
};

const TAU = Math.PI * 2;

function lmat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
}

/**
 * Almond eye contour: two ellipse arcs sharing the same x half-width W.
 *   Top arc:    t 0→π  →  y = topH × sin(t)    (positive, fuller upper lid)
 *   Bottom arc: t π→2π →  y = botH × sin(t)    (negative, shallower lower lid)
 */
function eyeContourGeo(W: number, topH: number, botH: number, segs: number): THREE.BufferGeometry {
  const p = new Float32Array(segs * 2 * 6);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    // Top arc
    const at0 = t0 * Math.PI, at1 = t1 * Math.PI;
    const ot = i * 6;
    p[ot]   = W * Math.cos(at0); p[ot+1] = topH * Math.sin(at0); p[ot+2] = 0;
    p[ot+3] = W * Math.cos(at1); p[ot+4] = topH * Math.sin(at1); p[ot+5] = 0;
    // Bottom arc (sin is negative in (π, 2π) → y below center)
    const ab0 = Math.PI + t0 * Math.PI, ab1 = Math.PI + t1 * Math.PI;
    const ob = (segs + i) * 6;
    p[ob]   = W * Math.cos(ab0); p[ob+1] = botH * Math.sin(ab0); p[ob+2] = 0;
    p[ob+3] = W * Math.cos(ab1); p[ob+4] = botH * Math.sin(ab1); p[ob+5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

/** Full circle at radius r. */
function circleGeo(r: number, segs: number): THREE.BufferGeometry {
  const p = new Float32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const o  = i * 6;
    p[o]   = Math.cos(a0) * r; p[o+1] = Math.sin(a0) * r; p[o+2] = 0;
    p[o+3] = Math.cos(a1) * r; p[o+4] = Math.sin(a1) * r; p[o+5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

/** N radial spokes from radius r0 to r1 (with a slight length jitter for organic feel). */
function spokesGeoFn(r0: number, r1: number, N: number): THREE.BufferGeometry {
  const p = new Float32Array(N * 6);
  for (let i = 0; i < N; i++) {
    const a  = (i / N) * TAU + rand(-0.04, 0.04);
    const ri = r1 * rand(0.90, 1.0); // inner ends vary slightly
    const o  = i * 6;
    p[o]   = Math.cos(a) * r0; p[o+1] = Math.sin(a) * r0; p[o+2] = 0;
    p[o+3] = Math.cos(a) * ri; p[o+4] = Math.sin(a) * ri; p[o+5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const cfg = DENSITY_CFG[density];
  const B   = Math.min(halfW, halfH);

  // Eye proportions (relative to B = min visible half-dimension)
  const W      = B * 0.50;         // eye half-width (horizontal)
  const topH   = B * 0.26;         // upper lid peak height
  const botH   = topH * 0.58;      // lower lid depth (sin will be negative → y below center)
  const irisR  = botH * 0.88;      // iris radius — fits within lower lid opening
  const pupilR = irisR * 0.40;     // pupil radius

  const root = new THREE.Group();
  const toDispose: Array<[THREE.BufferGeometry, THREE.Material]> = [];

  function addToRoot(geo: THREE.BufferGeometry, mat: THREE.LineBasicMaterial): THREE.LineSegments {
    const s = new THREE.LineSegments(geo, mat);
    s.frustumCulled = false;
    root.add(s);
    toDispose.push([geo, mat]);
    return s;
  }

  function addToGroup(group: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.LineBasicMaterial): THREE.LineSegments {
    const s = new THREE.LineSegments(geo, mat);
    s.frustumCulled = false;
    group.add(s);
    toDispose.push([geo, mat]);
    return s;
  }

  // ── Eye contour ────────────────────────────────────────────────────────────
  const contourGeo = eyeContourGeo(W, topH, botH, 64);
  const contourMat = lmat();
  const contourSeg = addToRoot(contourGeo, contourMat);

  // ── Iris group (rotates as a unit for MID reaction) ───────────────────────
  const irisGroup = new THREE.Group();
  root.add(irisGroup);

  interface IRing {
    seg:        THREE.LineSegments;
    mat:        THREE.LineBasicMaterial;
    zFrac:      number;
    pulseAmp:   number;
    pulsePhase: number;
    pulseSpeed: number;
    cmix:       number;
    lowAff:     number;
    midAff:     number;
    highAff:    number;
  }
  const irisRings: IRing[] = [];

  for (let i = 0; i < cfg.irisRings; i++) {
    const t = i / Math.max(1, cfg.irisRings - 1);              // 0 (inner) → 1 (outer)
    const r = pupilR * 1.1 + (irisR - pupilR * 1.1) * t;      // linear from just outside pupil to iris edge
    const rGeo = circleGeo(r, Math.max(16, Math.round(36 * r / irisR)));
    const rMat = lmat();
    const seg  = addToGroup(irisGroup, rGeo, rMat);
    const dom  = Math.floor(Math.random() * 3);
    irisRings.push({
      seg, mat: rMat,
      zFrac:      t * 0.10,                       // outer rings slightly behind
      pulseAmp:   rand(0.04, 0.15),
      pulsePhase: rand(0, TAU),
      pulseSpeed: rand(0.30, 0.80),
      cmix:       t,
      lowAff:  dom === 0 ? rand(0.7, 1) : rand(0, 0.25),
      midAff:  dom === 1 ? rand(0.7, 1) : rand(0, 0.25),
      highAff: dom === 2 ? rand(0.7, 1) : rand(0, 0.25),
    });
  }

  // ── Radial spokes ──────────────────────────────────────────────────────────
  const spokesGeo = spokesGeoFn(pupilR * 1.08, irisR, cfg.spokes);
  const spokesMat = lmat();
  addToGroup(irisGroup, spokesGeo, spokesMat);

  // ── Pupil ring ─────────────────────────────────────────────────────────────
  const pupilGeo = circleGeo(pupilR, 24);
  const pupilMat = lmat();
  const pupilSeg = addToRoot(pupilGeo, pupilMat);

  // ── Outer iris points ──────────────────────────────────────────────────────
  const oN    = cfg.outerPts;
  const oPos  = new Float32Array(oN * 3);  // static initial positions
  const oCol  = new Float32Array(oN * 3);
  const oBr   = new Float32Array(oN);
  const oCmix = new Float32Array(oN);
  const oPh   = new Float32Array(oN);      // phase for shimmer animation

  for (let i = 0; i < oN; i++) {
    const a     = rand(0, TAU);
    const inner = i < Math.floor(oN * 0.65); // 65% tightly at iris edge
    const d     = inner ? irisR * rand(0.88, 1.12) : rand(irisR * 1.1, irisR * 1.40);
    oPos[i*3]   = Math.cos(a) * d;
    oPos[i*3+1] = Math.sin(a) * d;
    oPos[i*3+2] = rand(-halfD * 0.12, halfD * 0.12);
    oBr[i]   = rand(0.30, 0.92);
    oCmix[i] = rand(0, 1);
    oPh[i]   = rand(0, TAU);
  }
  const oGeo = new THREE.BufferGeometry();
  oGeo.setAttribute("position", new THREE.BufferAttribute(oPos, 3));
  oGeo.setAttribute("color",    new THREE.BufferAttribute(oCol, 3));
  const oMat = new THREE.PointsMaterial({
    size: 2.2, vertexColors: true, transparent: true,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const oPoints = new THREE.Points(oGeo, oMat);
  oPoints.frustumCulled = false;
  root.add(oPoints);

  const tmpC = new THREE.Color();
  let hd = halfD;

  return {
    root,
    onFrame(time, dt, audio) {
      const sp = shared.uSpeed.value, es = shared.uElementSize.value, gl = shared.uGlow.value;
      const ca = shared.uColorA.value, cb = shared.uColorB.value, cc = shared.uColorC.value;

      // Whole eye — bass makes the entire eye visibly pump
      const eyePump = 1 + audio.low * 0.22;
      root.scale.setScalar(eyePump);

      // Eye contour — LOW slams brightness up hard (kick = the eye "opens")
      paletteMix(0.06, ca, cb, cc, tmpC);
      const ctB = 0.45 + gl * 0.50 + audio.low * 1.60;
      contourMat.color.setRGB(tmpC.r * ctB, tmpC.g * ctB, tmpC.b * ctB);
      contourMat.opacity = Math.min(1, 0.40 + audio.low * 0.60 + gl * 0.18);
      // Bass also stretches the lids vertically — a widening / squinting motion
      contourSeg.scale.y = 1 + audio.low * 0.55;

      // Iris group — MID whips the rotation around dramatically
      irisGroup.rotation.z = (irisGroup.rotation.z + dt * sp * (0.10 + audio.mid * 4.5 + audio.high * 1.5)) % TAU;
      // MID also swells the whole iris
      irisGroup.scale.setScalar(1 + audio.mid * 0.35);

      // Iris rings — LOW shockwave breathe; HIGH hard strobe on subsets
      for (const ring of irisRings) {
        const lowR  = audio.low  * ring.lowAff;
        const midR  = audio.mid  * ring.midAff;
        const highR = audio.high * ring.highAff;
        const flick = highR * (Math.sin(ring.cmix * 79.3 + time * 3.1) > 0.30 ? 1 : 0);
        const breathe = 1 + Math.sin(time * ring.pulseSpeed + ring.pulsePhase) * ring.pulseAmp
                          + lowR * 0.85;
        ring.seg.scale.setScalar(breathe);
        ring.seg.position.z = ring.zFrac * hd;
        paletteMix(ring.cmix, ca, cb, cc, tmpC);
        const rB = 0.35 + gl * 0.55 + lowR * 1.20 + midR * 0.90 + flick * 2.60;
        ring.mat.color.setRGB(tmpC.r * rB, tmpC.g * rB, tmpC.b * rB);
        ring.mat.opacity = Math.min(1, 0.30 + gl * 0.25 + lowR * 0.60 + midR * 0.40 + flick * 0.70);
      }

      // Spokes — MID blazes them; near-invisible when quiet
      paletteMix(0.50, ca, cb, cc, tmpC);
      const spB = 0.22 + gl * 0.40 + audio.mid * 1.80;
      spokesMat.color.setRGB(tmpC.r * spB, tmpC.g * spB, tmpC.b * spB);
      spokesMat.opacity = Math.min(1, 0.18 + audio.mid * 0.80 + gl * 0.15);

      // Pupil ring — dramatic bass dilation, contracts hard on treble
      paletteMix(0.85, ca, cb, cc, tmpC);
      const dilation = Math.max(0.45, 1 + audio.low * 1.10 - audio.high * 0.35);
      pupilSeg.scale.setScalar(dilation);
      const pB = 0.70 + gl * 0.30 + audio.high * 2.00 + audio.low * 0.60;
      pupilMat.color.setRGB(tmpC.r * pB, tmpC.g * pB, tmpC.b * pB);
      pupilMat.opacity = Math.min(1, 0.70 + audio.high * 0.30 + audio.low * 0.30);

      // Outer points — HIGH strobes them violently; nearly dark when quiet
      const colA = oGeo.attributes.color as THREE.BufferAttribute;
      const oScale = 1 + audio.high * 0.45 + audio.low * 0.20;
      oPoints.scale.setScalar(oScale);
      for (let i = 0; i < oN; i++) {
        const shimmer = 0.50 + 0.50 * Math.sin(oPh[i] + time * 0.85 + i * 0.41);
        const flick   = audio.high * (Math.sin(i * 41.7 + time * 5.8) > 0.20 ? 1 : 0);
        paletteMix(oCmix[i], ca, cb, cc, tmpC);
        const br = oBr[i] * shimmer * (0.18 + gl * 0.35) * (1 + flick * 5.0 + audio.low * 1.2);
        colA.setXYZ(i, tmpC.r * br, tmpC.g * br, tmpC.b * br);
      }
      colA.needsUpdate = true;
      oMat.size = Math.max(1.2, 2.5 * es * (1 + audio.high * 1.2));
    },
    onFraming(_nw, _nh, nd) { hd = nd; },
    dispose() {
      for (const [geo, mat] of toDispose) { geo.dispose(); mat.dispose(); }
      oGeo.dispose(); oMat.dispose();
    },
  };
}

export const reactiveEyeTemplate: VisualTemplate = {
  id: "reactive-eye",
  create: build,
};
