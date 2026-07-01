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

/**
 * PARTICLE FIELD — free-floating particles drifting through an open 3D volume.
 * Each particle has an independent velocity, float phase and one dominant band.
 * Ported verbatim (behaviour + look) from the original single-template renderer.
 */

const VERTEX_BODY = /* glsl */ `
  attribute vec3  aVelocity;
  attribute float aBaseSize;
  attribute float aBaseOpacity;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aMoveSpeed;
  attribute float aLowAff;
  attribute float aMidAff;
  attribute float aHighAff;
  attribute float aSparkleThresh;
  attribute float aColorMix;

  void main() {
    // Base drift through 3D space, wrapped into the volume.
    vec3 p = position + aVelocity * uTime * uSpeed;
    p = mod(p + uVolume, 2.0 * uVolume) - uVolume;

    // Organic per-particle float — own phase, speed, direction.
    float t = uTime * aMoveSpeed * uSpeed;
    p += vec3(
      sin(aPhase + t),
      cos(aPhase * 1.3 + t * 0.9),
      sin(aPhase * 0.7 + t * 1.1)
    ) * uVolume * 0.02;

    // LOW: heavy — individual outward push + move toward camera.
    float low = uLow * aLowAff;
    vec3 radial = normalize(p + vec3(0.0001));
    p += radial * low * (uVolume.x * 0.13);
    p.z += low * (uVolume.z * 0.16);

    // MID: fluid curved / side-to-side motion, each with its own phase.
    float mid = uMid * aMidAff;
    float ma = aPhase + uTime * (1.4 + aMoveSpeed * 2.0);
    p.xy += vec2(cos(ma), sin(ma * 1.3)) * mid * (uVolume.x * 0.11);
    p.z  += sin(ma * 0.8) * mid * (uVolume.z * 0.05);

    // HIGH: sparkle among a changing subset.
    float tw = fract(sin(aSeed * 91.17 + uTime * (6.0 + aMoveSpeed * 6.0)) * 43758.5453);
    float sparkle = uHigh * aHighAff * step(aSparkleThresh, tw);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.12, 1.0);

    float size = aBaseSize * uParticleSize * (1.0 + low * 0.9 + sparkle * 1.5);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.7 + depthF * 0.5);
    col += col * mid * 0.55;
    col += vec3(sparkle) * 0.85;
    vColor = col;
    vOpacity = clamp(aBaseOpacity * depthF + low * 0.22 + sparkle * 0.75, 0.0, 1.0);
  }
`;

function build({ count, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const position  = new Float32Array(count * 3);
  const velocity  = new Float32Array(count * 3);
  const baseSize  = new Float32Array(count);
  const baseOpac  = new Float32Array(count);
  const seed      = new Float32Array(count);
  const phase     = new Float32Array(count);
  const moveSpeed = new Float32Array(count);
  const lowAff    = new Float32Array(count);
  const midAff    = new Float32Array(count);
  const highAff   = new Float32Array(count);
  const sparkleTh = new Float32Array(count);
  const colorMix  = new Float32Array(count);

  const dir = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    position[i * 3 + 0] = rand(-halfW, halfW);
    position[i * 3 + 1] = rand(-halfH, halfH);
    position[i * 3 + 2] = rand(-halfD, halfD);

    dir.set(rand(-1, 1), rand(-1, 1), rand(-1, 1));
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(rand(1.4, 4.6));
    velocity[i * 3 + 0] = dir.x;
    velocity[i * 3 + 1] = dir.y;
    velocity[i * 3 + 2] = dir.z;

    baseSize[i]  = rand(0.7, 2.3);
    baseOpac[i]  = rand(0.35, 0.9);
    seed[i]      = rand(0, 1000);
    phase[i]     = rand(0, Math.PI * 2);
    moveSpeed[i] = rand(0.3, 1.2);
    sparkleTh[i] = rand(0.6, 0.94);
    colorMix[i]  = Math.random();

    const [l, m, h] = randomAffinities();
    lowAff[i] = l; midAff[i] = m; highAff[i] = h;
  }

  const geometry = new THREE.BufferGeometry();
  setF32(geometry, "position",       position,  3);
  setF32(geometry, "aVelocity",      velocity,  3);
  setF32(geometry, "aBaseSize",      baseSize,  1);
  setF32(geometry, "aBaseOpacity",   baseOpac,  1);
  setF32(geometry, "aSeed",          seed,      1);
  setF32(geometry, "aPhase",         phase,     1);
  setF32(geometry, "aMoveSpeed",     moveSpeed, 1);
  setF32(geometry, "aLowAff",        lowAff,    1);
  setF32(geometry, "aMidAff",        midAff,    1);
  setF32(geometry, "aHighAff",       highAff,   1);
  setF32(geometry, "aSparkleThresh", sparkleTh, 1);
  setF32(geometry, "aColorMix",      colorMix,  1);

  const material = makeMaterial(VERTEX_BODY, shared);
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export const particleFieldTemplate: VisualTemplate = {
  id: "particle-field",
  create: build,
};
