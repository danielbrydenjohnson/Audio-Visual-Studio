import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  makeMaterial,
  rand,
  randomAffinities,
  setF32,
  LINE_FRAGMENT_SHADER,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * LASER LATTICE — a deep 3D field of independent line segments (THREE.LineSegments,
 * one draw call, two vertices per segment). The segments themselves are the visual
 * — not connectors between particles. Everything is GPU-driven from per-vertex
 * attributes; both endpoints of a segment share segment data and differ only by an
 * endpoint sign (aEnd = ±0.5), so the shader places them around a moving midpoint.
 *
 *   LOW  → individual segments lengthen + accelerate through depth (brighter/longer,
 *          since reliable WebGL line width isn't available)
 *   MID  → per-segment endpoint bend / local directional waves (no global rotation)
 *   HIGH → a changing subset flashes + gets a brief forward length streak
 *
 * Hit envelopes (transients) on top, always per-segment:
 *
 *   LOW hit  → all segments pulse brighter/longer; a static ~half subset also
 *              surges forward through depth for an instant
 *   MID hit  → sharp higher-frequency kink in the bend direction (local snap)
 *   HIGH hit → fast-reshuffling subset (~24 Hz) flickers hard with a tip streak
 */

// Deliberately sparser defaults than other templates: line segments read as
// clutter much faster than points, so low/medium load with far fewer elements
// for a cleaner look, while "high" keeps the old dense ceiling for users who
// want it. Only the counts change — movement, hit reactions, kaleidoscope and
// recording behaviour are untouched.
const COUNTS: Record<DensityLevel, number> = { low: 150, medium: 380, high: 1500 };

const VERTEX_BODY = /* glsl */ `
  attribute vec3  aDir;
  attribute float aEnd;   // -0.5 / +0.5 endpoint sign
  attribute float aLen;   // base length
  attribute float aFwd;   // forward speed factor
  attribute float aPhase;
  attribute vec3  aAff;   // low, mid, high affinity
  attribute vec3  aMisc;  // x=seed, y=baseBright, z=colorMix

  void main() {
    float seed       = aMisc.x;
    float baseBright = aMisc.y;
    float low  = uLow  * aAff.x;
    float mid  = uMid  * aAff.y;
    float high = uHigh * aAff.z;
    float lowHit  = uLowHit  * aAff.x;
    float midHit  = uMidHit  * aAff.y;
    float highHit = uHighHit * aAff.z;

    float halfLen = uVolume.z;

    // Midpoint drifts toward the camera (+z) and wraps in depth. LOW accelerates.
    // LOW hits surge a static ~half subset forward for an instant — the envelope
    // eases the surge back out, so layers snap on the kick and settle after.
    vec3 m = position;
    m.z += uTime * (7.0 + aFwd * 15.0) * uSpeed;
    m.z += low * (12.0 + aFwd * 24.0);
    float surgeGate = step(0.5, fract(seed * 0.517));
    m.z += lowHit * surgeGate * (7.0 + aFwd * 12.0);
    m.z = mod(m.z + halfLen, 2.0 * halfLen) - halfLen;

    // Length grows with LOW level; LOW hits pulse it (longer reads as thicker
    // under additive glow, the closest thing to line width WebGL offers).
    float len = aLen * (0.55 + uElementSize * 0.9) * (1.0 + low * 1.0 + lowHit * 0.45);

    // Direction bends with MID (endpoint movement / local waves); MID hits add
    // a sharper, higher-frequency kink that snaps in and eases out.
    vec3 dir = normalize(aDir + vec3(
      sin(aPhase + uTime * 1.3),
      cos(aPhase * 1.2 + uTime * 1.1),
      sin(aPhase * 0.7 + uTime * 1.5)
    ) * mid * 0.35 + vec3(
      sin(aPhase * 3.1 + m.z * 0.22),
      cos(aPhase * 2.3 - m.z * 0.19),
      0.0
    ) * midHit * 0.4 + vec3(0.0001));

    // HIGH: changing subset flashes + brief forward length streak.
    float tw = fract(sin(seed * 91.17 + uTime * (6.0 + aFwd * 6.0)) * 43758.5453);
    float flash = high * step(0.62, tw);
    // HIGH hit: independent fast-reshuffling subset (~24 Hz) for sharp flicker.
    float twHit = fract(sin(seed * 57.3 + floor(uTime * 24.0) * 13.7) * 43758.5453);
    float flashHit = highHit * step(0.6, twHit);
    len += flash * aLen * 1.4 + flashHit * aLen * 0.8;

    vec3 p = m + dir * (aEnd * len);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float dist   = max(-mv.z, 0.001);
    float depthF = clamp((halfLen * 2.0 + CAM_NEAR - dist) / (halfLen * 2.0), 0.1, 1.0);

    vec3 col = paletteColor(aMisc.z);
    col *= (0.45 + depthF * 0.75);
    col *= baseBright;
    col += col * mid * 0.5;        // MID adds energy
    col *= (1.0 + lowHit * 0.55);  // LOW hit: brightness pulse on the kick
    col += vec3(flash) * 0.9;      // HIGH flash
    col += vec3(flashHit) * 1.0;   // HIGH hit: sharp flicker subset
    col *= (0.75 + uGlow * 0.9);   // Glow lifts overall brightness
    vColor = col;
    vOpacity = clamp(0.4 * depthF + low * 0.35 + lowHit * 0.4 + flash * 0.85 + flashHit * 0.6 + mid * 0.15, 0.0, 1.0);
  }
`;

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const segments = COUNTS[density];
  const verts = segments * 2;

  const position = new Float32Array(verts * 3);
  const dirA   = new Float32Array(verts * 3);
  const endA   = new Float32Array(verts);
  const lenA   = new Float32Array(verts);
  const fwdA   = new Float32Array(verts);
  const phaseA = new Float32Array(verts);
  const affA   = new Float32Array(verts * 3);
  const miscA  = new Float32Array(verts * 3);

  for (let s = 0; s < segments; s++) {
    const mx = rand(-halfW, halfW), my = rand(-halfH, halfH), mz = rand(-halfD, halfD);
    let dx = rand(-1, 1), dy = rand(-1, 1), dz = rand(-1, 1);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const len = rand(6, 22), fwd = rand(0.4, 1.6), ph = rand(0, Math.PI * 2);
    const [l, m, h] = randomAffinities();
    const seed = rand(0, 1000), bright = rand(0.6, 1.0), cmix = Math.random();
    for (let e = 0; e < 2; e++) {
      const vi = s * 2 + e;
      position[vi * 3 + 0] = mx; position[vi * 3 + 1] = my; position[vi * 3 + 2] = mz;
      dirA[vi * 3 + 0] = dx; dirA[vi * 3 + 1] = dy; dirA[vi * 3 + 2] = dz;
      endA[vi] = e === 0 ? -0.5 : 0.5;
      lenA[vi] = len; fwdA[vi] = fwd; phaseA[vi] = ph;
      affA[vi * 3 + 0] = l; affA[vi * 3 + 1] = m; affA[vi * 3 + 2] = h;
      miscA[vi * 3 + 0] = seed; miscA[vi * 3 + 1] = bright; miscA[vi * 3 + 2] = cmix;
    }
  }

  const geometry = new THREE.BufferGeometry();
  setF32(geometry, "position", position, 3);
  setF32(geometry, "aDir",   dirA,   3);
  setF32(geometry, "aEnd",   endA,   1);
  setF32(geometry, "aLen",   lenA,   1);
  setF32(geometry, "aFwd",   fwdA,   1);
  setF32(geometry, "aPhase", phaseA, 1);
  setF32(geometry, "aAff",   affA,   3);
  setF32(geometry, "aMisc",  miscA,  3);

  const material = makeMaterial(VERTEX_BODY, shared, {}, LINE_FRAGMENT_SHADER);
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  return {
    root: lines,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export const laserLatticeTemplate: VisualTemplate = {
  id: "laser-lattice",
  create: build,
};
