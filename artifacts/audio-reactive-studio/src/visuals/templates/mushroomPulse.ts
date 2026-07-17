import * as THREE from "three";
import {
  type VisualTemplate, type TemplateCreateArgs, type TemplateRuntime,
  rand, paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * MUSHROOM PULSE
 *
 * A stylised geometric mushroom built from dome arcs, radial gills, and drifting
 * spore particles. The silhouette is immediately recognisable in any lighting.
 *
 * Structure (all geometry in XY plane, depth via position.z):
 *   • Cap dome arc — the outer silhouette; bright structural outline
 *   • Cap underside line — flat rim where cap meets gills
 *   • Inner rib domes — concentric dome arcs inside the cap for depth + layering
 *   • Stem — two vertical lines + base
 *   • Gills — radial lines under the cap
 *   • Spores — drifting point particles around the mushroom
 *
 *   LOW  → cap dome breathes locally; spores get pushed outward
 *   MID  → inner ribs rotate at own rates; gills pulse; spore turbulence
 *   HIGH → ribs and spores sparkle (changing subsets)
 */

const DENSITY_CFG: Record<DensityLevel, { ribs: number; gills: number; spores: number }> = {
  low:    { ribs: 2, gills:  7, spores:  65 },
  medium: { ribs: 3, gills: 11, spores: 140 },
  high:   { ribs: 5, gills: 17, spores: 270 },
};

function lmat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
}

/** Half-ellipse dome arc from (maxR, botY) up through (0, topY) to (-maxR, botY). */
function domeArc(maxR: number, botY: number, topY: number, segs: number): THREE.BufferGeometry {
  const p = new Float32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI, t1 = ((i + 1) / segs) * Math.PI;
    const o  = i * 6;
    p[o]   = Math.cos(t0) * maxR; p[o+1] = botY + (topY - botY) * Math.sin(t0); p[o+2] = 0;
    p[o+3] = Math.cos(t1) * maxR; p[o+4] = botY + (topY - botY) * Math.sin(t1); p[o+5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

/** Horizontal line segment at height y from x0 to x1. */
function hLine(x0: number, x1: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x0, y, 0, x1, y, 0]), 3));
  return g;
}

/** Vertical line at x from y0 to y1. */
function vLine(x: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x, y0, 0, x, y1, 0]), 3));
  return g;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const cfg = DENSITY_CFG[density];
  const B   = Math.min(halfW, halfH);

  const capTopY  = B * 0.28;   // top of dome
  const capBotY  = -B * 0.08;  // dome base / cap-stem junction
  const maxCapR  = B * 0.38;   // widest radius
  const stemR    = maxCapR * 0.11;
  const stemBotY = -B * 0.44;

  const root = new THREE.Group();
  const toDispose: Array<[THREE.BufferGeometry, THREE.Material]> = [];

  function addSeg(geo: THREE.BufferGeometry, mat: THREE.LineBasicMaterial): THREE.LineSegments {
    const s = new THREE.LineSegments(geo, mat);
    s.frustumCulled = false;
    root.add(s);
    toDispose.push([geo, mat]);
    return s;
  }

  // ── Cap outer dome ─────────────────────────────────────────────────────────
  const capGeo = domeArc(maxCapR, capBotY, capTopY, 48);
  const capMat = lmat();
  const capSeg = addSeg(capGeo, capMat);

  // ── Cap underside flat line ────────────────────────────────────────────────
  const flatGeo = hLine(-maxCapR, maxCapR, capBotY);
  const flatMat = lmat();
  addSeg(flatGeo, flatMat);

  // ── Inner rib domes ────────────────────────────────────────────────────────
  interface Rib {
    seg:        THREE.LineSegments;
    mat:        THREE.LineBasicMaterial;
    zFrac:      number; // position.z = zFrac * hd
    pulseAmp:   number;
    pulsePhase: number;
    pulseSpeed: number;
    rotRate:    number;
    rotPhase:   number;
    cmix:       number;
    lowAff:     number;
    midAff:     number;
    highAff:    number;
  }
  const ribs: Rib[] = [];

  for (let i = 0; i < cfg.ribs; i++) {
    const t    = (i + 1) / (cfg.ribs + 1);     // 0..1 inner to outer
    const sc   = 0.90 - t * 0.50;              // shrink from 0.90 → 0.40
    const rR   = maxCapR * sc;
    const rBot = capBotY + (capTopY - capBotY) * (1 - sc) * 0.4;
    const rTop = capTopY - (capTopY - capBotY) * (1 - sc) * 0.4;
    const rGeo = domeArc(rR, rBot, rTop, Math.max(12, Math.round(36 * sc)));
    const rMat = lmat();
    const seg  = addSeg(rGeo, rMat);
    const dom  = Math.floor(Math.random() * 3);
    ribs.push({
      seg, mat: rMat,
      zFrac:      -t * 0.28,
      pulseAmp:   rand(0.04, 0.16),
      pulsePhase: rand(0, Math.PI * 2),
      pulseSpeed: rand(0.30, 0.80),
      rotRate:    rand(0.03, 0.13) * (Math.random() < 0.5 ? -1 : 1),
      rotPhase:   rand(0, Math.PI * 2),
      cmix:       t,
      lowAff:  dom === 0 ? rand(0.7, 1) : rand(0, 0.25),
      midAff:  dom === 1 ? rand(0.7, 1) : rand(0, 0.25),
      highAff: dom === 2 ? rand(0.7, 1) : rand(0, 0.25),
    });
  }

  // ── Stem ──────────────────────────────────────────────────────────────────
  const lStemGeo = vLine(-stemR, capBotY, stemBotY);
  const lStemMat = lmat();
  addSeg(lStemGeo, lStemMat);
  const rStemGeo = vLine( stemR, capBotY, stemBotY);
  const rStemMat = lmat();
  addSeg(rStemGeo, rStemMat);
  const baseGeo = hLine(-stemR * 1.4, stemR * 1.4, stemBotY);
  const baseMat = lmat();
  addSeg(baseGeo, baseMat);

  // ── Gills: radial lines from near stem to cap rim, at capBotY ─────────────
  const gillN = cfg.gills;
  const gillPos = new Float32Array(gillN * 6);
  for (let i = 0; i < gillN; i++) {
    const a = (i / gillN) * Math.PI * 2;
    const o = i * 6;
    gillPos[o]   = Math.cos(a) * stemR * 1.5;     gillPos[o+1] = capBotY; gillPos[o+2] = 0;
    gillPos[o+3] = Math.cos(a) * maxCapR * 0.84;  gillPos[o+4] = capBotY; gillPos[o+5] = 0;
  }
  const gillGeo = new THREE.BufferGeometry();
  gillGeo.setAttribute("position", new THREE.BufferAttribute(gillPos, 3));
  const gillMat = lmat();
  addSeg(gillGeo, gillMat);

  // ── Spores ────────────────────────────────────────────────────────────────
  const sN    = cfg.spores;
  const sPos  = new Float32Array(sN * 3);
  const sVel  = new Float32Array(sN * 3);
  const sCol  = new Float32Array(sN * 3);
  const sBr   = new Float32Array(sN);
  const sCmix = new Float32Array(sN);
  const sPh   = new Float32Array(sN);

  let hd = halfD;

  function spawnSpore(i: number) {
    const a = rand(0, Math.PI * 2);
    const d = rand(maxCapR * 0.2, maxCapR * 1.8);
    sPos[i*3]   = Math.cos(a) * d;
    sPos[i*3+1] = rand(stemBotY, capTopY + B * 0.18);
    sPos[i*3+2] = rand(-hd * 0.5, hd * 0.5);
    sVel[i*3]   = rand(-0.35, 0.35);
    sVel[i*3+1] = rand(0.3, 1.0) * 0.55; // slow upward drift
    sVel[i*3+2] = rand(-0.2, 0.2);
    sBr[i]   = rand(0.28, 0.85);
    sCmix[i] = rand(0, 1);
    sPh[i]   = rand(0, Math.PI * 2);
  }
  for (let i = 0; i < sN; i++) spawnSpore(i);

  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  sGeo.setAttribute("color",    new THREE.BufferAttribute(sCol, 3));
  const sMat = new THREE.PointsMaterial({
    size: 2.5, vertexColors: true, transparent: true,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sporePts = new THREE.Points(sGeo, sMat);
  sporePts.frustumCulled = false;
  root.add(sporePts);

  const tmpC = new THREE.Color();
  const wrapY = B * 1.5;

  return {
    root,
    onFrame(time, dt, audio) {
      const sp = shared.uSpeed.value, es = shared.uElementSize.value, gl = shared.uGlow.value;
      const ca = shared.uColorA.value, cb = shared.uColorB.value, cc = shared.uColorC.value;

      // Cap outer dome — LOW breathe (local scale, not whole-scene)
      paletteMix(0.05, ca, cb, cc, tmpC);
      const cB = 0.60 + gl * 0.55 + audio.low * 0.25;
      capMat.color.setRGB(tmpC.r * cB, tmpC.g * cB, tmpC.b * cB);
      capMat.opacity = Math.min(1, 0.55 + audio.low * 0.28 + gl * 0.18);
      capSeg.scale.setScalar(1 + Math.sin(time * 0.85) * 0.010 + audio.low * 0.048);

      // Stem, flat, base — MID brightens structure
      paletteMix(0.25, ca, cb, cc, tmpC);
      const sB = 0.38 + gl * 0.35 + audio.mid * 0.22;
      for (const mat of [flatMat, lStemMat, rStemMat, baseMat]) {
        mat.color.setRGB(tmpC.r * sB, tmpC.g * sB, tmpC.b * sB);
        mat.opacity = Math.min(1, 0.38 + audio.mid * 0.20 + gl * 0.12);
      }

      // Gills — MID ripple (opacity + color)
      paletteMix(0.35, ca, cb, cc, tmpC);
      const gB = 0.30 + gl * 0.40 + audio.mid * 0.32;
      gillMat.color.setRGB(tmpC.r * gB, tmpC.g * gB, tmpC.b * gB);
      gillMat.opacity = Math.min(1, 0.28 + audio.mid * 0.28 + gl * 0.15);

      // Inner ribs — each pulses (LOW) and rotates about Y independently (MID)
      for (const rib of ribs) {
        const lowR  = audio.low  * rib.lowAff;
        const midR  = audio.mid  * rib.midAff;
        const highR = audio.high * rib.highAff;
        const flick = highR * (Math.sin(rib.cmix * 71.3 + time * 2.7) > 0.55 ? 1 : 0);
        const breathe = 1 + Math.sin(time * rib.pulseSpeed + rib.pulsePhase) * rib.pulseAmp
                          + lowR * 0.30;
        rib.seg.scale.setScalar(breathe);
        rib.seg.position.z = rib.zFrac * hd;
        // Rotation about Y (horizontal axis) = rotating dome in 3D, each at own rate
        rib.seg.rotation.y = rib.rotPhase + time * sp * rib.rotRate * (1 + midR * 2.2);
        paletteMix(rib.cmix, ca, cb, cc, tmpC);
        const rB = 0.40 + gl * 0.60 + lowR * 0.28 + midR * 0.20 + flick * 1.20;
        rib.mat.color.setRGB(tmpC.r * rB, tmpC.g * rB, tmpC.b * rB);
        rib.mat.opacity = Math.min(1, 0.38 + gl * 0.25 + lowR * 0.22 + flick * 0.40);
      }

      // Spores — drift + LOW pushes outward; MID turbulence; HIGH sparkle
      const posA = sGeo.attributes.position as THREE.BufferAttribute;
      const colA = sGeo.attributes.color    as THREE.BufferAttribute;
      for (let i = 0; i < sN; i++) {
        const turb  = audio.mid * 1.3;
        sPos[i*3]   += (sVel[i*3]   + Math.sin(sPh[i] + time * 0.65 + i * 0.31) * turb * 0.30) * sp * dt;
        sPos[i*3+1] += (sVel[i*3+1] + audio.low * 0.95) * sp * dt;
        sPos[i*3+2] +=  sVel[i*3+2] * dt;
        if (sPos[i*3+1] > wrapY) spawnSpore(i);
        posA.setXYZ(i, sPos[i*3], sPos[i*3+1], sPos[i*3+2]);
        const flick = audio.high * (Math.sin(i * 43.1 + time * 5.7) > 0.58 ? 1 : 0);
        paletteMix(sCmix[i], ca, cb, cc, tmpC);
        const br = sBr[i] * (0.28 + gl * 0.52) * (1 + flick * 2.0);
        colA.setXYZ(i, tmpC.r * br, tmpC.g * br, tmpC.b * br);
      }
      posA.needsUpdate = true;
      colA.needsUpdate = true;
      sMat.size = Math.max(1.5, 2.8 * es);
    },
    onFraming(_nw, _nh, nd) { hd = nd; },
    dispose() {
      for (const [geo, mat] of toDispose) { geo.dispose(); mat.dispose(); }
      sGeo.dispose(); sMat.dispose();
    },
  };
}

export const mushroomPulseTemplate: VisualTemplate = {
  id: "mushroom-pulse",
  create: build,
};
