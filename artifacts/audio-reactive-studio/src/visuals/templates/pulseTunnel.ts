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
 * PULSE TUNNEL — particles fill a long cylindrical volume down the -z axis and
 * stream toward the camera at individual speeds, recycling to the far end via a
 * shader mod() wrap. Distribution is organic (no rigid rings). Reactions are
 * per-particle: LOW accelerates + swells + nudges radius, MID adds individual
 * lateral wave / twist, HIGH sparkles + brief forward streaks.
 *
 * Tunnel length + depth follow uVolume.z (the Depth control), read live so no
 * rebuild is needed when Depth changes.
 */

const VERTEX_BODY = /* glsl */ `
  attribute float aAngle;
  attribute float aRadius;
  attribute float aZ;          // base position along tunnel, 0..1
  attribute float aForward;    // forward speed factor
  attribute float aPhase;
  attribute float aWave;       // lateral wave amount
  attribute float aRadialSign; // +1 / -1 for LOW radial impulse
  attribute vec4  aMisc;       // x=moveSpeed, y=seed, z=baseSize, w=baseOpacity
  attribute vec3  aAff;        // x=low, y=mid, z=high band affinity
  attribute float aSparkleThresh;
  attribute float aColorMix;

  void main() {
    // Unpack scalars packed into vectors (keeps vertex-attribute count ≤ GPU max).
    float aMoveSpeed   = aMisc.x;
    float aSeed        = aMisc.y;
    float aBaseSize    = aMisc.z;
    float aBaseOpacity = aMisc.w;
    float aLowAff  = aAff.x;
    float aMidAff  = aAff.y;
    float aHighAff = aAff.z;

    float halfLen = uVolume.z;
    float low = uLow * aLowAff;
    float mid = uMid * aMidAff;

    // Forward travel toward the camera (+z), wrapped so particles recycle to the
    // far end once they pass. LOW gives individual acceleration.
    float z = aZ * 2.0 * halfLen - halfLen;
    z += uTime * (6.0 + aForward * 12.0) * uSpeed;
    z += low * (10.0 + aForward * 22.0);
    z = mod(z + halfLen, 2.0 * halfLen) - halfLen;

    // Radius — LOW gives a small individual radial impulse.
    float rad = aRadius * (1.0 + low * aRadialSign * 0.25);

    // MID: individual lateral wave / twist using each particle's phase.
    float ang = aAngle + mid * aWave * 0.5 * sin(uTime * 1.5 + aPhase);
    vec2 base = vec2(cos(ang), sin(ang)) * rad;
    base += vec2(
      sin(aPhase + z * 0.05 + uTime * 1.3),
      cos(aPhase * 1.2 + z * 0.05 + uTime * 1.1)
    ) * mid * aWave * (aRadius * 0.5);

    vec3 p = vec3(base, z);

    // HIGH: sparkle subset + brief forward streak.
    float tw = fract(sin(aSeed * 91.17 + uTime * (6.0 + aMoveSpeed * 6.0)) * 43758.5453);
    float sparkle = uHigh * aHighAff * step(aSparkleThresh, tw);
    p.z += sparkle * 14.0;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);
    float depthF = clamp((halfLen * 2.0 + CAM_NEAR - dist) / (halfLen * 2.0), 0.1, 1.0);

    float size = aBaseSize * uElementSize * (1.0 + low * 0.9 + sparkle * 1.8);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.55 + depthF * 0.6);
    col += col * mid * 0.5;
    col += vec3(sparkle) * 0.9;
    vColor = col;
    vOpacity = clamp(aBaseOpacity * depthF + low * 0.2 + sparkle * 0.8, 0.0, 1.0);
  }
`;

function build({ density, halfW, halfH, shared }: TemplateCreateArgs): TemplateRuntime {
  const count = DENSITY_COUNTS[density];
  // Tunnel radius scales with the smaller cross-section half-extent.
  const rMax = Math.min(halfW, halfH) * 0.85;

  const angle      = new Float32Array(count);
  const radius     = new Float32Array(count);
  const zPos       = new Float32Array(count);
  const forward    = new Float32Array(count);
  const phase      = new Float32Array(count);
  const wave       = new Float32Array(count);
  const radialSign = new Float32Array(count);
  const misc       = new Float32Array(count * 4); // moveSpeed, seed, baseSize, baseOpacity
  const aff        = new Float32Array(count * 3); // low, mid, high affinity
  const sparkleTh  = new Float32Array(count);
  const colorMix   = new Float32Array(count);
  const position   = new Float32Array(count * 3); // required attribute; shader-driven

  for (let i = 0; i < count; i++) {
    angle[i]      = rand(0, Math.PI * 2);
    // sqrt() weighting fills the disc area organically (denser toward the rim,
    // not clustered at the centre) with a hollow-ish core.
    radius[i]     = (0.22 + 0.78 * Math.sqrt(Math.random())) * rMax;
    zPos[i]       = Math.random();
    forward[i]    = rand(0.4, 1.6);
    phase[i]      = rand(0, Math.PI * 2);
    wave[i]       = rand(0.4, 1.4);
    radialSign[i] = Math.random() < 0.5 ? -1 : 1;
    misc[i * 4 + 0] = rand(0.3, 1.2); // moveSpeed
    misc[i * 4 + 1] = rand(0, 1000);  // seed
    misc[i * 4 + 2] = rand(0.7, 2.2); // baseSize
    misc[i * 4 + 3] = rand(0.4, 0.9); // baseOpacity
    sparkleTh[i]  = rand(0.6, 0.94);
    colorMix[i]   = Math.random();
    const [l, m, h] = randomAffinities();
    aff[i * 3 + 0] = l; aff[i * 3 + 1] = m; aff[i * 3 + 2] = h;
  }

  const geometry = new THREE.BufferGeometry();
  setF32(geometry, "position",       position,   3);
  setF32(geometry, "aAngle",         angle,      1);
  setF32(geometry, "aRadius",        radius,     1);
  setF32(geometry, "aZ",             zPos,       1);
  setF32(geometry, "aForward",       forward,    1);
  setF32(geometry, "aPhase",         phase,      1);
  setF32(geometry, "aWave",          wave,       1);
  setF32(geometry, "aRadialSign",    radialSign, 1);
  setF32(geometry, "aMisc",          misc,       4);
  setF32(geometry, "aAff",           aff,        3);
  setF32(geometry, "aSparkleThresh", sparkleTh,  1);
  setF32(geometry, "aColorMix",      colorMix,   1);

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

export const pulseTunnelTemplate: VisualTemplate = {
  id: "pulse-tunnel",
  create: build,
};
