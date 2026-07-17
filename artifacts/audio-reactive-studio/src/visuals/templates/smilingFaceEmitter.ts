import * as THREE from "three";
import {
  type VisualTemplate, type TemplateCreateArgs, type TemplateRuntime,
  rand, paletteMix,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * SMILING FACE EMITTER
 *
 * A luminous stylised face built from line geometry:
 *   • Head  — bright ring outline
 *   • Eyes  — two small rings that sparkle with HIGH
 *   • Mouth — smile arc (210 → 330°) that wobbles with MID
 *   • Emitter — particles born on the mouth arc and spewed outward/downward
 *
 *   LOW  → stronger burst velocity from the emitter; head outline breathes locally
 *   MID  → mouth wobble + turbulence in emitted particle trajectories
 *   HIGH → eye sparkle + a changing subset of particles brightens
 *
 * The full face is always visible at rest; emitted particles drift even at 0% influence.
 */

const EMIT_COUNT: Record<DensityLevel, number> = { low: 140, medium: 300, high: 580 };
const TAU = Math.PI * 2;

function ringGeo(cx: number, cy: number, r: number, segs: number): THREE.BufferGeometry {
  const p = new Float32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const o = i * 6;
    p[o]   = cx + Math.cos(a0) * r; p[o+1] = cy + Math.sin(a0) * r; p[o+2] = 0;
    p[o+3] = cx + Math.cos(a1) * r; p[o+4] = cy + Math.sin(a1) * r; p[o+5] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return g;
}

function arcGeo(
  cx: number, cy: number, r: number, a0: number, a1: number, segs: number,
): [THREE.BufferGeometry, Array<[number, number]>] {
  const pts: Array<[number, number]> = [];
  const p = new Float32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    const ta = a0 + (i / segs) * (a1 - a0), tb = a0 + ((i + 1) / segs) * (a1 - a0);
    const o = i * 6;
    p[o]   = cx + Math.cos(ta) * r; p[o+1] = cy + Math.sin(ta) * r; p[o+2] = 0;
    p[o+3] = cx + Math.cos(tb) * r; p[o+4] = cy + Math.sin(tb) * r; p[o+5] = 0;
    pts.push([p[o], p[o+1]]);
  }
  pts.push([cx + Math.cos(a1) * r, cy + Math.sin(a1) * r]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p, 3));
  return [g, pts];
}

function lmat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const R  = Math.min(halfW, halfH) * 0.46;
  const N  = EMIT_COUNT[density];

  // ── Head ring ─────────────────────────────────────────────────────────────
  const hGeo = ringGeo(0, 0, R, 64);
  const hMat = lmat();
  const hSeg = new THREE.LineSegments(hGeo, hMat); hSeg.frustumCulled = false;

  // ── Eyes ──────────────────────────────────────────────────────────────────
  const eR = R * 0.082, eX = R * 0.28, eY = R * 0.22;
  const lEyeGeo = ringGeo(-eX, eY, eR, 18);
  const lEyeMat = lmat();
  const lEye = new THREE.LineSegments(lEyeGeo, lEyeMat); lEye.frustumCulled = false;
  const rEyeGeo = ringGeo( eX, eY, eR, 18);
  const rEyeMat = lmat();
  const rEye = new THREE.LineSegments(rEyeGeo, rEyeMat); rEye.frustumCulled = false;

  // Pupil dots inside each eye
  const lPupilGeo = ringGeo(-eX, eY, eR * 0.35, 8);
  const lPupilMat = lmat();
  const lPupil = new THREE.LineSegments(lPupilGeo, lPupilMat); lPupil.frustumCulled = false;
  const rPupilGeo = ringGeo( eX, eY, eR * 0.35, 8);
  const rPupilMat = lmat();
  const rPupil = new THREE.LineSegments(rPupilGeo, rPupilMat); rPupil.frustumCulled = false;

  // ── Mouth arc: 210° → 330° (smile bottom) ─────────────────────────────────
  const mR  = R * 0.48, mCY = -R * 0.1;
  const mA0 = Math.PI + 0.17 * Math.PI;   // 210.6°
  const mA1 = TAU     - 0.17 * Math.PI;   // 329.4°
  const [mGeo, mPts] = arcGeo(0, mCY, mR, mA0, mA1, 28);
  const mMat = lmat();
  const mSeg = new THREE.LineSegments(mGeo, mMat); mSeg.frustumCulled = false;

  // ── Emitter particles ──────────────────────────────────────────────────────
  const pPos  = new Float32Array(N * 3);
  const pVel  = new Float32Array(N * 3);
  const pLife = new Float32Array(N);
  const pMax  = new Float32Array(N);
  const pBr   = new Float32Array(N);
  const pCmix = new Float32Array(N);
  const pCol  = new Float32Array(N * 3);

  let hd = halfD;

  function spawn(i: number, spd: number) {
    const m  = mPts[Math.floor(Math.random() * mPts.length)];
    const mx = m[0], my = m[1];
    pPos[i*3]   = mx + rand(-R * 0.015, R * 0.015);
    pPos[i*3+1] = my + rand(-R * 0.010, R * 0.010);
    pPos[i*3+2] = rand(-hd * 0.38, hd * 0.38);
    // Outward direction from mouth-arc center (0, mCY)
    const dx = mx, dy = my - mCY, dl = Math.sqrt(dx*dx + dy*dy) || 1;
    const s  = R * 0.20 * spd * rand(0.5, 1.9);
    pVel[i*3]   = (dx/dl * 0.55 + rand(-0.45, 0.45)) * s;
    pVel[i*3+1] = (dy/dl * 0.55 - rand(0.20, 0.60)) * s; // bias downward
    pVel[i*3+2] = rand(-0.30, 0.30) * s;
    pLife[i] = rand(0, 1);   // stagger initial lifetimes so they don't all appear at once
    pMax[i]  = rand(1.8, 4.2);
    pBr[i]   = rand(0.40, 1.0);
    pCmix[i] = rand(0.20, 1.0); // mouth particles skew toward warmer palette end
  }
  for (let i = 0; i < N; i++) spawn(i, 1.0);

  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("color",    new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 3, vertexColors: true, transparent: true,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pPts = new THREE.Points(pGeo, pMat); pPts.frustumCulled = false;

  const root = new THREE.Group();
  root.add(hSeg, lEye, rEye, lPupil, rPupil, mSeg, pPts);

  const tmpC = new THREE.Color();

  return {
    root,
    onFrame(time, dt, audio) {
      const sp = shared.uSpeed.value, es = shared.uElementSize.value, gl = shared.uGlow.value;
      const ca = shared.uColorA.value, cb = shared.uColorB.value, cc = shared.uColorC.value;

      // Head — LOW breathe (local, not whole-scene scale)
      paletteMix(0.08, ca, cb, cc, tmpC);
      const hB = 0.58 + gl * 0.55 + audio.low * 0.25;
      hMat.color.setRGB(tmpC.r * hB, tmpC.g * hB, tmpC.b * hB);
      hMat.opacity = Math.min(1, 0.52 + audio.low * 0.28 + gl * 0.18);
      hSeg.scale.setScalar(1 + Math.sin(time * 1.1) * 0.008 + audio.low * 0.04);

      // Eyes — HIGH sparkle; each eye scales independently
      paletteMix(0.12, ca, cb, cc, tmpC);
      const eFlick = audio.high * (Math.sin(time * 4.7) > 0.35 ? 1 : 0);
      const eB = 0.82 + gl * 0.50 + eFlick * 1.10;
      lEyeMat.color.setRGB(tmpC.r * eB, tmpC.g * eB, tmpC.b * eB);
      lEyeMat.opacity = Math.min(1, 0.75 + eFlick * 0.25);
      rEyeMat.color.copy(lEyeMat.color); rEyeMat.opacity = lEyeMat.opacity;
      lPupilMat.color.copy(lEyeMat.color); lPupilMat.opacity = lEyeMat.opacity;
      rPupilMat.color.copy(lEyeMat.color); rPupilMat.opacity = lEyeMat.opacity;
      const ep = 1 + eFlick * 0.2;
      lEye.scale.setScalar(ep); rEye.scale.setScalar(ep);
      lPupil.scale.setScalar(ep); rPupil.scale.setScalar(ep);

      // Mouth — MID wobble (local y shift; smile "tightens/loosens")
      paletteMix(0.18, ca, cb, cc, tmpC);
      const mB = 0.62 + gl * 0.50 + audio.mid * 0.48;
      mMat.color.setRGB(tmpC.r * mB, tmpC.g * mB, tmpC.b * mB);
      mMat.opacity = Math.min(1, 0.62 + audio.mid * 0.28);
      mSeg.position.y = Math.sin(time * 1.9) * R * 0.007 + audio.mid * R * 0.014;

      // Emitter particles (integrated each frame on CPU)
      const emitSpd = 1 + audio.low * 1.8;
      const posA = pGeo.attributes.position as THREE.BufferAttribute;
      const colA = pGeo.attributes.color    as THREE.BufferAttribute;
      for (let i = 0; i < N; i++) {
        pLife[i] += dt * sp / pMax[i];
        if (pLife[i] >= 1) { spawn(i, emitSpd); continue; }
        const t     = pLife[i];
        const fade  = t < 0.12 ? t / 0.12 : t > 0.72 ? (1 - t) / 0.28 : 1.0;
        const turb  = audio.mid * R * 0.038;
        // Euler-integrate position — velocity set at spawn, turbulence from MID
        pPos[i*3]   += pVel[i*3]   * dt * sp + Math.sin(t*6.2 + i*2.1) * turb * dt;
        pPos[i*3+1] += pVel[i*3+1] * dt * sp + Math.cos(t*5.3 + i*1.8) * turb * dt;
        pPos[i*3+2] += pVel[i*3+2] * dt;
        posA.setXYZ(i, pPos[i*3], pPos[i*3+1], pPos[i*3+2]);
        // HIGH: a changing subset of particles brightens
        const spark = audio.high * (Math.sin(i*37.1 + time*6.3) > 0.52 ? 1 : 0);
        paletteMix(pCmix[i], ca, cb, cc, tmpC);
        const br = pBr[i] * (0.42 + gl * 0.58) * fade * (1 + spark * 1.5);
        colA.setXYZ(i, tmpC.r * br, tmpC.g * br, tmpC.b * br);
      }
      posA.needsUpdate = true;
      colA.needsUpdate = true;
      pMat.size = Math.max(1, 3.2 * es);
    },
    onFraming(_nw, _nh, nd) { hd = nd; },
    dispose() {
      hGeo.dispose();      hMat.dispose();
      lEyeGeo.dispose();   lEyeMat.dispose();
      rEyeGeo.dispose();   rEyeMat.dispose();
      lPupilGeo.dispose(); lPupilMat.dispose();
      rPupilGeo.dispose(); rPupilMat.dispose();
      mGeo.dispose();      mMat.dispose();
      pGeo.dispose();      pMat.dispose();
    },
  };
}

export const smilingFaceEmitterTemplate: VisualTemplate = {
  id: "smiling-face-emitter",
  create: build,
};
