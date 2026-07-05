import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  makeMaterial,
  rand,
  randomAffinities,
  setF32,
} from "@/visuals/shared";
import { DENSITY_COUNTS } from "@/types/visualizer";

/**
 * FIBONACCI SPIRAL — a deep 3D phyllotaxis spiral. Points are laid out with the
 * golden angle (~137.5°) across a handful of Fibonacci arms, radius growing with
 * sqrt(index) and z sweeping through the depth volume so the spiral genuinely
 * lives in 3D (paused, it reads as an intentional golden spiral, not a flat
 * disc). Every point carries its own phase, speed, size, brightness, per-band
 * affinity and seed. All motion is GPU-driven from per-vertex attributes.
 *
 *   LOW  → low-tuned points push outward along their own spiral radial + swell
 *   MID  → sections of each arm twist / wave independently (angle depends on the
 *          point's radial position, so the spiral bends locally, never as a whole)
 *   HIGH → a changing subset of high-tuned points sparkles at the arm nodes
 *
 * The root is a single THREE.Points — never rotated or scaled as one object.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad (137.5°)

const VERTEX_BODY = /* glsl */ `
  attribute vec2  aRadial;   // normalized outward xy direction at this point
  attribute float aRadius;   // base radius from the spiral axis (world units)
  attribute float aBaseSize;
  attribute float aBaseBright;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aMoveSpeed;
  attribute vec3  aAff;       // low, mid, high affinity
  attribute float aColorMix;

  void main() {
    float low  = uLow  * aAff.x;
    float mid  = uMid  * aAff.y;
    float high = uHigh * aAff.z;

    vec3 p = position;

    // Resting organic float — each point drifts on its own phase/speed even at
    // 0% influence, so the spiral is always gently alive.
    float t = uTime * aMoveSpeed * uSpeed;
    p += vec3(
      sin(aPhase + t),
      cos(aPhase * 1.3 + t * 0.9),
      sin(aPhase * 0.7 + t * 1.1)
    ) * (uVolume.y * 0.012);

    // MID: local twist — rotate this point around the spiral axis (z) by an angle
    // that depends on its own radius, so inner and outer sections bend by
    // different amounts (waves travel along the arms) rather than spinning as one.
    float twist = sin(aRadius * 0.14 + uTime * 1.3 + aPhase) * mid * 0.6;
    float cs = cos(twist), sn = sin(twist);
    p.xy = mat2(cs, -sn, sn, cs) * p.xy;

    // LOW: push outward along this point's own radial + gentle forward swell.
    p.xy += aRadial * low * (uVolume.x * 0.10);
    p.z  += low * (uVolume.z * 0.10);

    // HIGH: sparkle among a changing subset (own seed + speed decorrelates them).
    float tw = fract(sin(aSeed * 91.17 + uTime * (5.0 + aMoveSpeed * 6.0)) * 43758.5453);
    float sparkle = high * step(0.68, tw);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist   = max(-mv.z, 0.001);
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.12, 1.0);

    float size = aBaseSize * uElementSize * (1.0 + low * 0.9 + sparkle * 1.6);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);
    gl_Position  = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.68 + depthF * 0.55);
    col *= aBaseBright;
    col += col * mid * 0.5;          // MID adds energy
    col += vec3(sparkle) * 0.9;      // HIGH sparkle
    col *= (0.8 + uGlow * 0.8);      // Glow lifts overall brightness
    vColor = col;
    vOpacity = clamp(aBaseBright * depthF + low * 0.22 + sparkle * 0.8, 0.0, 1.0);
  }
`;

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const count = DENSITY_COUNTS[density];
  // A few Fibonacci arms so the phyllotaxis reads as distinct spiral limbs.
  const arms = 3;

  const position   = new Float32Array(count * 3);
  const radialA    = new Float32Array(count * 2);
  const radiusA    = new Float32Array(count);
  const baseSize   = new Float32Array(count);
  const baseBright = new Float32Array(count);
  const seed       = new Float32Array(count);
  const phase      = new Float32Array(count);
  const moveSpeed  = new Float32Array(count);
  const affA       = new Float32Array(count * 3);
  const colorMix   = new Float32Array(count);

  // Radius grows with sqrt(index) (phyllotaxis); scale so the outer ring fills
  // the frame. Depth sweeps the full volume so the spiral is genuinely 3D.
  const maxR    = Math.min(halfW, halfH) * 0.94;
  const radScale = maxR / Math.sqrt(Math.max(1, count - 1));

  for (let i = 0; i < count; i++) {
    const arm = i % arms;
    const r   = radScale * Math.sqrt(i);
    // Golden-angle progression, offset per arm so the arms interleave evenly.
    const ang = i * GOLDEN_ANGLE + (arm / arms) * Math.PI * 2;
    const cx  = Math.cos(ang), cy = Math.sin(ang);

    // z ramps along the spiral (normalized index) with a slight per-point jitter
    // so the arms sweep front-to-back through the depth volume.
    const zt  = i / Math.max(1, count - 1);
    const z   = (zt * 2 - 1) * halfD * 0.85 + rand(-halfD * 0.06, halfD * 0.06);

    position[i * 3 + 0] = cx * r;
    position[i * 3 + 1] = cy * r;
    position[i * 3 + 2] = z;

    radialA[i * 2 + 0] = cx;
    radialA[i * 2 + 1] = cy;
    radiusA[i] = r;

    baseSize[i]   = rand(0.9, 2.4);
    baseBright[i] = rand(0.55, 1.0);
    seed[i]       = rand(0, 1000);
    phase[i]      = rand(0, Math.PI * 2);
    moveSpeed[i]  = rand(0.3, 1.1);
    colorMix[i]   = zt; // colour ramps along the spiral for a coherent gradient

    const [l, m, h] = randomAffinities();
    affA[i * 3 + 0] = l; affA[i * 3 + 1] = m; affA[i * 3 + 2] = h;
  }

  const geometry = new THREE.BufferGeometry();
  setF32(geometry, "position",    position,   3);
  setF32(geometry, "aRadial",     radialA,    2);
  setF32(geometry, "aRadius",     radiusA,    1);
  setF32(geometry, "aBaseSize",   baseSize,   1);
  setF32(geometry, "aBaseBright", baseBright, 1);
  setF32(geometry, "aSeed",       seed,       1);
  setF32(geometry, "aPhase",      phase,      1);
  setF32(geometry, "aMoveSpeed",  moveSpeed,  1);
  setF32(geometry, "aAff",        affA,       3);
  setF32(geometry, "aColorMix",   colorMix,   1);

  const material = makeMaterial(VERTEX_BODY, shared);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    root: points,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export const fibonacciSpiralTemplate: VisualTemplate = {
  id: "fibonacci-spiral",
  create: build,
};
