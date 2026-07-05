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
 * LISSAJOUS LATTICE — a 3D lattice of harmonic curve strands. Each strand is a
 * Lissajous / harmonograph curve traced as a connected polyline (contributed to
 * one shared THREE.LineSegments, one draw call). Every strand owns its frequency
 * ratio (a,b,c), phase triplet, amplitude, z-offset, per-band affinity,
 * brightness and seed, so the strands weave through each other independently.
 * The whole curve is evaluated on the GPU from a per-vertex parameter.
 *
 *   LOW  → low-tuned strands swell in amplitude + brighten (breathing lattice)
 *   MID  → per-strand phase / frequency drift warps the curve shape locally
 *   HIGH → a changing subset of strand segments flashes briefly
 *
 * The root is never rotated or scaled as one — all motion is per-strand/per-vertex.
 */

const STRANDS: Record<DensityLevel, number> = { low: 10, medium: 18, high: 30 };
const SAMPLES = 160; // samples per strand → SAMPLES-1 connected segments

const VERTEX_BODY = /* glsl */ `
  attribute float aParam;    // 0..1 position along the strand's curve
  attribute vec3  aFreq;     // harmonic frequency ratios (x,y,z)
  attribute vec3  aPhase;    // per-axis phase offset
  attribute vec3  aAmp;      // per-axis amplitude (world units)
  attribute float aZoff;     // strand centre depth
  attribute vec3  aAff;      // low, mid, high affinity
  attribute vec3  aMisc;     // x=seed, y=baseBright, z=colorMix

  const float TWO_PI = 6.28318530718;
  const float CYCLES = 2.0;  // how many curve cycles fit along the strand

  void main() {
    float seed       = aMisc.x;
    float baseBright = aMisc.y;
    float low  = uLow  * aAff.x;
    float mid  = uMid  * aAff.y;
    float high = uHigh * aAff.z;

    // Curve parameter sweeps through CYCLES cycles; a slow uTime term keeps the
    // lattice drifting even at 0% audio influence (resting animation).
    float u = aParam * TWO_PI * CYCLES;
    float drift = uTime * uSpeed * 0.6;

    // MID warps the curve locally: a small per-axis frequency + phase wobble that
    // travels along the strand (depends on aParam) rather than moving it rigidly.
    vec3 midWobble = vec3(
      sin(aParam * 9.0 + uTime * 1.4 + seed),
      cos(aParam * 7.0 + uTime * 1.2 + seed * 1.3),
      sin(aParam * 8.0 + uTime * 1.6 + seed * 0.7)
    ) * mid * 0.9;

    // LOW swells amplitude (breathing) for low-tuned strands.
    vec3 amp = aAmp * (0.85 + uElementSize * 0.6) * (1.0 + low * 0.5);

    vec3 p;
    p.x = amp.x * sin(aFreq.x * u + aPhase.x + drift + midWobble.x);
    p.y = amp.y * sin(aFreq.y * u + aPhase.y + drift * 1.1 + midWobble.y);
    p.z = amp.z * sin(aFreq.z * u + aPhase.z + drift * 0.9 + midWobble.z) + aZoff;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float dist   = max(-mv.z, 0.001);
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.1, 1.0);

    // HIGH: changing subset of segments flashes briefly.
    float tw = fract(sin(seed * 91.17 + aParam * 12.0 + uTime * 6.0) * 43758.5453);
    float flash = high * step(0.7, tw);

    vec3 col = paletteColor(aMisc.z);
    col *= (0.5 + depthF * 0.7);
    col *= baseBright;
    col += col * mid * 0.45;         // MID adds energy
    col += vec3(flash) * 0.9;        // HIGH flash
    col *= (0.78 + uGlow * 0.85);    // Glow lifts overall brightness
    vColor = col;
    vOpacity = clamp(0.42 * depthF + low * 0.35 + flash * 0.85 + mid * 0.12, 0.0, 1.0);
  }
`;

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const strands = STRANDS[density];
  const segsPerStrand = SAMPLES - 1;
  const verts = strands * segsPerStrand * 2; // LineSegments: 2 verts per segment

  const param = new Float32Array(verts);
  const freqA = new Float32Array(verts * 3);
  const phaseA = new Float32Array(verts * 3);
  const ampA  = new Float32Array(verts * 3);
  const zoffA = new Float32Array(verts);
  const affA  = new Float32Array(verts * 3);
  const miscA = new Float32Array(verts * 3);

  // Small integer harmonic ratios keep the curves musical / legible.
  const RATIOS = [1, 2, 3, 4, 5];
  const pick = () => RATIOS[Math.floor(Math.random() * RATIOS.length)];

  let vi = 0;
  for (let s = 0; s < strands; s++) {
    const fx = pick(), fy = pick(), fz = pick();
    const px = rand(0, Math.PI * 2), py = rand(0, Math.PI * 2), pz = rand(0, Math.PI * 2);
    const ax = halfW * rand(0.4, 0.85);
    const ay = halfH * rand(0.4, 0.85);
    const az = halfD * rand(0.3, 0.7);
    const zoff = rand(-halfD * 0.6, halfD * 0.6);
    const [l, m, h] = randomAffinities();
    const seed = rand(0, 1000), bright = rand(0.55, 1.0), cmix = Math.random();

    for (let i = 0; i < segsPerStrand; i++) {
      const t0 = i / segsPerStrand;
      const t1 = (i + 1) / segsPerStrand;
      for (let e = 0; e < 2; e++) {
        param[vi] = e === 0 ? t0 : t1;
        freqA[vi * 3 + 0] = fx; freqA[vi * 3 + 1] = fy; freqA[vi * 3 + 2] = fz;
        phaseA[vi * 3 + 0] = px; phaseA[vi * 3 + 1] = py; phaseA[vi * 3 + 2] = pz;
        ampA[vi * 3 + 0] = ax; ampA[vi * 3 + 1] = ay; ampA[vi * 3 + 2] = az;
        zoffA[vi] = zoff;
        affA[vi * 3 + 0] = l; affA[vi * 3 + 1] = m; affA[vi * 3 + 2] = h;
        miscA[vi * 3 + 0] = seed; miscA[vi * 3 + 1] = bright; miscA[vi * 3 + 2] = cmix;
        vi++;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  // A tiny position attribute is required by three even though the shader ignores
  // it (all positions are computed from aParam + strand attributes).
  setF32(geometry, "position", new Float32Array(verts * 3), 3);
  setF32(geometry, "aParam", param,  1);
  setF32(geometry, "aFreq",  freqA,  3);
  setF32(geometry, "aPhase", phaseA, 3);
  setF32(geometry, "aAmp",   ampA,   3);
  setF32(geometry, "aZoff",  zoffA,  1);
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

export const lissajousLatticeTemplate: VisualTemplate = {
  id: "lissajous-lattice",
  create: build,
};
