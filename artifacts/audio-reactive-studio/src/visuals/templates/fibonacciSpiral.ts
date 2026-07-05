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
import { DENSITY_COUNTS } from "@/types/visualizer";

/**
 * FIBONACCI SPIRAL — a genuine golden-angle phyllotaxis (sunflower) spiral in 3D.
 *
 * Construction:
 *   • NODES  — `count` points placed with the golden angle (~137.5°) between
 *              consecutive nodes and radius = k·√i (Vogel's model), the canonical
 *              Fibonacci arrangement. z sweeps front-to-back so the disc becomes a
 *              shallow 3D funnel with real depth.
 *   • ARMS   — the visible spiral limbs (parastichies) are drawn as luminous lines
 *              by connecting each node to the one PARASTICHY_STRIDE (13, a Fibonacci
 *              number) ahead. Connecting nodes a Fibonacci number apart is exactly
 *              what traces the naturally-occurring spiral arms, so the arms are the
 *              real mathematical Fibonacci spiral, and every node sits on an arm.
 *
 * Both share IDENTICAL per-node attributes and the SAME GPU displacement function
 * (displaceNode) so each line endpoint tracks its node precisely under motion.
 * All motion is GPU-driven from per-vertex attributes — nothing is scaled or
 * rotated as a whole object.
 *
 *   LOW  → low-tuned nodes push outward along their own radial + swell in size
 *   MID  → local twist about the axis, amount depends on each node's radius, so
 *          inner and outer arm sections bend differently (waves along the arms)
 *   HIGH → a changing subset of high-tuned nodes sparkles at the arm beads/tips
 *
 * At 0% influence every node still drifts on its own phase/speed, so the spiral
 * is always gently alive.
 */

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad (137.5°)
// Fibonacci stride: linking each node to the one this far ahead traces the
// naturally-occurring parastichy arms (13 of them — a Fibonacci number).
const PARASTICHY_STRIDE = 13;

// Per-node displacement, shared VERBATIM by the point and line shaders so a line
// endpoint always lands exactly on its node. Declared before each main().
const DISPLACE_FN = /* glsl */ `
  vec3 displaceNode(
    vec3 basePos, float radius, vec2 radial, float phase,
    float moveSpeed, float seed, vec3 aff,
    out float outLow, out float outMid, out float outSparkle
  ) {
    float low  = uLow  * aff.x;
    float mid  = uMid  * aff.y;
    float high = uHigh * aff.z;

    vec3 p = basePos;

    // Resting organic drift — alive on its own phase/speed even at 0% influence.
    float t = uTime * moveSpeed * uSpeed;
    p += vec3(
      sin(phase + t),
      cos(phase * 1.3 + t * 0.9),
      sin(phase * 0.7 + t * 1.1)
    ) * (uVolume.y * 0.012);

    // MID: local twist about the spiral axis; the angle depends on this node's own
    // radius, so inner and outer arm sections bend by different amounts (waves
    // travel along the arms) rather than the whole spiral spinning as one.
    float twist = sin(radius * 0.14 + uTime * 1.3 + phase) * mid * 0.6;
    float cs = cos(twist), sn = sin(twist);
    p.xy = mat2(cs, -sn, sn, cs) * p.xy;

    // LOW: push outward along this node's own spiral radial + gentle forward swell.
    p.xy += radial * low * (uVolume.x * 0.10);
    p.z  += low * (uVolume.z * 0.10);

    // HIGH: sparkle among a changing subset (own seed + speed decorrelates them).
    float tw = fract(sin(seed * 91.17 + uTime * (5.0 + moveSpeed * 6.0)) * 43758.5453);
    outSparkle = high * step(0.68, tw);
    outLow = low;
    outMid = mid;
    return p;
  }
`;

const POINT_VERTEX = DISPLACE_FN + /* glsl */ `
  attribute vec2  aRadial;    // normalized outward xy direction at this node
  attribute float aRadius;    // base radius from the spiral axis (world units)
  attribute float aBaseSize;
  attribute float aBaseBright;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aMoveSpeed;
  attribute vec3  aAff;        // low, mid, high affinity
  attribute float aColorMix;

  void main() {
    float low, mid, sparkle;
    vec3 p = displaceNode(position, aRadius, aRadial, aPhase, aMoveSpeed, aSeed, aAff, low, mid, sparkle);

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

const LINE_VERTEX = DISPLACE_FN + /* glsl */ `
  attribute vec2  aRadial;
  attribute float aRadius;
  attribute float aBaseBright;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aMoveSpeed;
  attribute vec3  aAff;
  attribute float aColorMix;

  void main() {
    float low, mid, sparkle;
    vec3 p = displaceNode(position, aRadius, aRadial, aPhase, aMoveSpeed, aSeed, aAff, low, mid, sparkle);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist   = max(-mv.z, 0.001);
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.12, 1.0);

    gl_Position = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.55 + depthF * 0.5);
    col *= aBaseBright;
    col += col * mid * 0.5;
    col += vec3(sparkle) * 0.7;
    col *= (0.7 + uGlow * 0.7);
    vColor = col;
    // Arms sit a touch dimmer than nodes, so nodes read as bright beads on the arms.
    vOpacity = clamp(aBaseBright * depthF * 0.6 + low * 0.18 + sparkle * 0.5, 0.0, 1.0);
  }
`;

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const count = DENSITY_COUNTS[density];

  // ── Per-node arrays (golden-angle phyllotaxis nodes) ──
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

  // Radius grows with √index (Vogel's model); scale so the outer ring fills the
  // frame. Depth sweeps most of the volume so the spiral is a genuine 3D funnel.
  const maxR     = Math.min(halfW, halfH) * 0.94;
  const radScale = maxR / Math.sqrt(Math.max(1, count - 1));

  for (let i = 0; i < count; i++) {
    const r   = radScale * Math.sqrt(i);
    const ang = i * GOLDEN_ANGLE;              // pure 137.5° step → clean sunflower
    const cx  = Math.cos(ang), cy = Math.sin(ang);

    const zt = i / Math.max(1, count - 1);
    const z  = (zt * 2 - 1) * halfD * 0.7 + rand(-halfD * 0.05, halfD * 0.05);

    position[i * 3 + 0] = cx * r;
    position[i * 3 + 1] = cy * r;
    position[i * 3 + 2] = z;

    radialA[i * 2 + 0] = cx;
    radialA[i * 2 + 1] = cy;
    radiusA[i] = r;

    baseSize[i]   = rand(1.0, 2.6);
    baseBright[i] = rand(0.55, 1.0);
    seed[i]       = rand(0, 1000);
    phase[i]      = rand(0, Math.PI * 2);
    moveSpeed[i]  = rand(0.3, 1.1);
    colorMix[i]   = Math.sqrt(zt); // colour ramps outward for a coherent gradient

    const [l, m, h] = randomAffinities();
    affA[i * 3 + 0] = l; affA[i * 3 + 1] = m; affA[i * 3 + 2] = h;
  }

  // ── Node points ──
  const pointGeo = new THREE.BufferGeometry();
  setF32(pointGeo, "position",    position,   3);
  setF32(pointGeo, "aRadial",     radialA,    2);
  setF32(pointGeo, "aRadius",     radiusA,    1);
  setF32(pointGeo, "aBaseSize",   baseSize,   1);
  setF32(pointGeo, "aBaseBright", baseBright, 1);
  setF32(pointGeo, "aSeed",       seed,       1);
  setF32(pointGeo, "aPhase",      phase,      1);
  setF32(pointGeo, "aMoveSpeed",  moveSpeed,  1);
  setF32(pointGeo, "aAff",        affA,       3);
  setF32(pointGeo, "aColorMix",   colorMix,   1);
  const pointMat = makeMaterial(POINT_VERTEX, shared);
  const points = new THREE.Points(pointGeo, pointMat);
  points.frustumCulled = false;

  // ── Spiral arm lines (parastichies): node i ↔ node i+PARASTICHY_STRIDE ──
  const segs = Math.max(0, count - PARASTICHY_STRIDE);
  const lineVerts = segs * 2;
  const lPos    = new Float32Array(lineVerts * 3);
  const lRadial = new Float32Array(lineVerts * 2);
  const lRadius = new Float32Array(lineVerts);
  const lBright = new Float32Array(lineVerts);
  const lSeed   = new Float32Array(lineVerts);
  const lPhase  = new Float32Array(lineVerts);
  const lSpeed  = new Float32Array(lineVerts);
  const lAff    = new Float32Array(lineVerts * 3);
  const lColor  = new Float32Array(lineVerts);

  let v = 0;
  const copyNode = (src: number) => {
    lPos[v * 3 + 0] = position[src * 3 + 0];
    lPos[v * 3 + 1] = position[src * 3 + 1];
    lPos[v * 3 + 2] = position[src * 3 + 2];
    lRadial[v * 2 + 0] = radialA[src * 2 + 0];
    lRadial[v * 2 + 1] = radialA[src * 2 + 1];
    lRadius[v] = radiusA[src];
    lBright[v] = baseBright[src];
    lSeed[v]   = seed[src];
    lPhase[v]  = phase[src];
    lSpeed[v]  = moveSpeed[src];
    lAff[v * 3 + 0] = affA[src * 3 + 0];
    lAff[v * 3 + 1] = affA[src * 3 + 1];
    lAff[v * 3 + 2] = affA[src * 3 + 2];
    lColor[v]  = colorMix[src];
    v++;
  };
  for (let i = 0; i < segs; i++) { copyNode(i); copyNode(i + PARASTICHY_STRIDE); }

  const lineGeo = new THREE.BufferGeometry();
  setF32(lineGeo, "position",    lPos,    3);
  setF32(lineGeo, "aRadial",     lRadial, 2);
  setF32(lineGeo, "aRadius",     lRadius, 1);
  setF32(lineGeo, "aBaseBright", lBright, 1);
  setF32(lineGeo, "aSeed",       lSeed,   1);
  setF32(lineGeo, "aPhase",      lPhase,  1);
  setF32(lineGeo, "aMoveSpeed",  lSpeed,  1);
  setF32(lineGeo, "aAff",        lAff,    3);
  setF32(lineGeo, "aColorMix",   lColor,  1);
  const lineMat = makeMaterial(LINE_VERTEX, shared, {}, LINE_FRAGMENT_SHADER);
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;

  // Single root Object3D (a Group): arms drawn first, bright node beads on top.
  const root = new THREE.Group();
  root.add(lines);
  root.add(points);

  return {
    root,
    dispose() {
      pointGeo.dispose();
      pointMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    },
  };
}

export const fibonacciSpiralTemplate: VisualTemplate = {
  id: "fibonacci-spiral",
  create: build,
};
