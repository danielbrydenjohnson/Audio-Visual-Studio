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
 * ORBITAL SWARM — several invisible attractors drift through 3D space, each with
 * its own cloud of particles orbiting on individually inclined planes (so the
 * orbits never share one flat plane). Reactions are per-particle: LOW gives
 * radial in/out impulses, MID bends curvature + adds turbulence, HIGH sparkles a
 * changing subset. The attractors themselves are never drawn.
 */

const MAX_ATTRACTORS = 5;

const VERTEX_BODY = /* glsl */ `
  uniform vec3  uAttractors[${MAX_ATTRACTORS}];

  attribute float aAttractor;   // index into uAttractors
  attribute float aRadius;      // orbital radius
  attribute float aOrbitSpeed;
  attribute float aDir;         // +1 / -1 orbit direction
  attribute float aIncl;        // orbit-plane inclination
  attribute float aNode;        // orbit-plane node angle
  attribute float aPhase;
  attribute float aRadialSign;  // +1 / -1 for LOW impulse direction
  attribute float aMoveSpeed;
  attribute float aSeed;
  attribute float aBaseSize;
  attribute float aBaseOpacity;
  attribute float aLowAff;
  attribute float aMidAff;
  attribute float aHighAff;
  attribute float aSparkleThresh;
  attribute float aColorMix;

  void main() {
    // Resolve this particle's attractor (constant-index loop — GLSL ES 1.0 safe).
    int idx = int(aAttractor + 0.5);
    vec3 att = vec3(0.0);
    for (int i = 0; i < ${MAX_ATTRACTORS}; i++) {
      if (i == idx) att = uAttractors[i];
    }

    float mid = uMid * aMidAff;
    float low = uLow * aLowAff;

    // Orbit angle — MID adds individual curvature / phase change.
    float a = aPhase + uTime * uSpeed * aOrbitSpeed * aDir;
    a += mid * 1.1 * sin(uTime * 0.8 + aSeed);

    // Per-particle orbit plane from inclination + node (planes differ → not flat).
    vec3 n = vec3(sin(aIncl) * cos(aNode), sin(aIncl) * sin(aNode), cos(aIncl));
    vec3 ref = abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 u = normalize(cross(n, ref));
    vec3 v = cross(n, u);

    float rad = aRadius * (1.0 + mid * 0.14 * sin(uTime * 1.3 + aSeed));
    vec3 orbit = rad * (cos(a) * u + sin(a) * v);
    vec3 p = att + orbit;

    // MID: local turbulence, each particle bending its own way.
    p += vec3(
      sin(aSeed + uTime * 1.7),
      cos(aSeed * 1.3 + uTime * 1.5),
      sin(aSeed * 0.7 + uTime * 1.9)
    ) * mid * (aRadius * 0.18);

    // LOW: short radial impulse toward / away from the attractor.
    vec3 rdir = normalize(orbit + vec3(0.0001));
    p += rdir * low * aRadialSign * (aRadius * 0.55);

    // HIGH: sparkle subset + restrained velocity disturbance.
    float tw = fract(sin(aSeed * 91.17 + uTime * (6.0 + aMoveSpeed * 6.0)) * 43758.5453);
    float sparkle = uHigh * aHighAff * step(aSparkleThresh, tw);
    p += vec3(
      sin(aSeed * 12.9 + uTime * 20.0),
      cos(aSeed * 7.7 + uTime * 22.0),
      sin(aSeed * 5.3 + uTime * 18.0)
    ) * sparkle * (aRadius * 0.14);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = max(-mv.z, 0.001);
    float depthF = clamp((uVolume.z * 2.0 + CAM_NEAR - dist) / (uVolume.z * 2.0), 0.12, 1.0);

    float size = aBaseSize * uParticleSize * (1.0 + low * 0.8 + sparkle * 1.6);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.7 + depthF * 0.5);
    col += col * mid * 0.5;
    col += vec3(sparkle) * 0.85;
    vColor = col;
    vOpacity = clamp(aBaseOpacity * depthF + low * 0.2 + sparkle * 0.75, 0.0, 1.0);
  }
`;

interface AttractorParam {
  cx: number; cy: number; cz: number; // normalized centre (-1..1)
  ax: number; ay: number; az: number; // normalized drift amplitude
  fx: number; fy: number; fz: number; // drift frequency
  px: number; py: number; pz: number; // drift phase
}

function build({ count, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const attractorCount = 3 + Math.floor(Math.random() * 3); // 3–5

  const params: AttractorParam[] = [];
  for (let i = 0; i < attractorCount; i++) {
    params.push({
      cx: rand(-0.55, 0.55), cy: rand(-0.5, 0.5), cz: rand(-0.55, 0.55),
      ax: rand(0.15, 0.4),   ay: rand(0.12, 0.35), az: rand(0.15, 0.4),
      fx: rand(0.05, 0.16),  fy: rand(0.05, 0.16), fz: rand(0.05, 0.16),
      px: rand(0, Math.PI * 2), py: rand(0, Math.PI * 2), pz: rand(0, Math.PI * 2),
    });
  }

  // Uniform array must be full length; unused slots stay at origin.
  const attractorVecs: THREE.Vector3[] = [];
  for (let i = 0; i < MAX_ATTRACTORS; i++) attractorVecs.push(new THREE.Vector3());

  const attractor  = new Float32Array(count);
  const radius     = new Float32Array(count);
  const orbitSpeed = new Float32Array(count);
  const dirArr     = new Float32Array(count);
  const incl       = new Float32Array(count);
  const node       = new Float32Array(count);
  const phase      = new Float32Array(count);
  const radialSign = new Float32Array(count);
  const moveSpeed  = new Float32Array(count);
  const seed       = new Float32Array(count);
  const baseSize   = new Float32Array(count);
  const baseOpac   = new Float32Array(count);
  const lowAff     = new Float32Array(count);
  const midAff     = new Float32Array(count);
  const highAff    = new Float32Array(count);
  const sparkleTh  = new Float32Array(count);
  const colorMix   = new Float32Array(count);
  // position attribute is required by three.js; actual placement is shader-driven.
  const position   = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    attractor[i]  = Math.floor(Math.random() * attractorCount);
    radius[i]     = rand(4, 22);
    orbitSpeed[i] = rand(0.25, 1.1);
    dirArr[i]     = Math.random() < 0.5 ? -1 : 1;
    incl[i]       = rand(0, Math.PI);
    node[i]       = rand(0, Math.PI * 2);
    phase[i]      = rand(0, Math.PI * 2);
    radialSign[i] = Math.random() < 0.5 ? -1 : 1;
    moveSpeed[i]  = rand(0.3, 1.2);
    seed[i]       = rand(0, 1000);
    baseSize[i]   = rand(0.7, 2.2);
    baseOpac[i]   = rand(0.4, 0.9);
    sparkleTh[i]  = rand(0.6, 0.94);
    colorMix[i]   = Math.random();
    const [l, m, h] = randomAffinities();
    lowAff[i] = l; midAff[i] = m; highAff[i] = h;
  }

  const geometry = new THREE.BufferGeometry();
  setF32(geometry, "position",       position,   3);
  setF32(geometry, "aAttractor",     attractor,  1);
  setF32(geometry, "aRadius",        radius,     1);
  setF32(geometry, "aOrbitSpeed",    orbitSpeed, 1);
  setF32(geometry, "aDir",           dirArr,     1);
  setF32(geometry, "aIncl",          incl,       1);
  setF32(geometry, "aNode",          node,       1);
  setF32(geometry, "aPhase",         phase,      1);
  setF32(geometry, "aRadialSign",    radialSign, 1);
  setF32(geometry, "aMoveSpeed",     moveSpeed,  1);
  setF32(geometry, "aSeed",          seed,       1);
  setF32(geometry, "aBaseSize",      baseSize,   1);
  setF32(geometry, "aBaseOpacity",   baseOpac,   1);
  setF32(geometry, "aLowAff",        lowAff,     1);
  setF32(geometry, "aMidAff",        midAff,     1);
  setF32(geometry, "aHighAff",       highAff,    1);
  setF32(geometry, "aSparkleThresh", sparkleTh,  1);
  setF32(geometry, "aColorMix",      colorMix,   1);

  const material = makeMaterial(VERTEX_BODY, shared, {
    uAttractors: { value: attractorVecs },
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  // Current volume extents — attractors drift within these; depth affects spread.
  let hw = halfW, hh = halfH, hd = halfD;

  return {
    points,
    onFrame(time) {
      for (let i = 0; i < attractorCount; i++) {
        const q = params[i];
        attractorVecs[i].set(
          (q.cx + q.ax * Math.sin(q.fx * time + q.px)) * hw * 0.7,
          (q.cy + q.ay * Math.sin(q.fy * time + q.py)) * hh * 0.7,
          (q.cz + q.az * Math.sin(q.fz * time + q.pz)) * hd * 0.75,
        );
      }
    },
    onFraming(nw, nh, nd) {
      hw = nw; hh = nh; hd = nd;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export const orbitalSwarmTemplate: VisualTemplate = {
  id: "orbital-swarm",
  create: build,
};
