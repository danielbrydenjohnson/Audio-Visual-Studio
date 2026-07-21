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
import type { DensityLevel } from "@/types/visualizer";

/**
 * GOLDEN GALAXY — a spiral galaxy of luminous stars moving through golden-ratio
 * space. Two GPU point clouds share one shader:
 *
 *   • STARS — placed on ARM spiral arms. The radial distribution uses the golden
 *     ratio conjugate (fract(i·φ⁻¹) — a true golden/low-discrepancy sequence, the
 *     same math behind the 137.5° golden angle) so arms fill evenly with no
 *     clumping. A subset are "bright nodes" (bigger, brighter). ~16% form the
 *     central bulge/halo.
 *   • DUST  — the same arm math with wider angular scatter, smaller/dimmer
 *     points and faster depth speeds, filling the space between arms with faint
 *     haze.
 *
 * Depth travel (the Laser Lattice feeling): every star/dust mote drifts toward
 * the camera at its own speed and wraps back to the far plane — the viewer
 * travels through the galaxy while the face-on spiral silhouette stays intact,
 * because motion is per-element z only. The root is never rotated or scaled.
 *
 * Differential rotation: each star advances its own angle slowly, inner stars
 * faster than outer ones (like a real galaxy), so the arms shear and flow
 * locally rather than spinning as one rigid object.
 *
 *   LOW  → low-tuned stars swell + brighten and push outward along their local
 *          arm radial; low-tuned dust accelerates through depth
 *   MID  → bending waves travel along the arms (angle offset depends on each
 *          star's own radius, so different arm sections bend differently)
 *   HIGH → a changing subset of stars/dust sparkles and flares independently
 *
 * Hit envelopes (transients) on top, per element:
 *
 *   LOW hit  → a static ~half subset kicks outward + surges through depth
 *              (dust accelerates hardest via its higher aFwd) + size pop
 *   MID hit  → a sharper, faster swirl wave races along the arms
 *   HIGH hit → fast-reshuffling twinkle subset (~24 Hz); bright nodes flare most
 *
 * At 0% influence everything still drifts through depth and flows along the
 * arms — the galaxy is always alive, and reads as a galaxy when audio is paused.
 */

const STAR_COUNTS: Record<DensityLevel, number> = { low: 500,  medium: 1100, high: 2000 };
const DUST_COUNTS: Record<DensityLevel, number> = { low: 800,  medium: 1800, high: 3200 };

const TAU   = Math.PI * 2;
const PHI_C = 0.6180339887498949; // golden ratio conjugate (1/φ)
const ARMS  = 4;
const WIND  = 0.85; // how far each arm winds around the centre (fraction of a turn)

/** Approximate gaussian in [-1, 1] (sum of two uniforms). */
function gauss(): number {
  return (Math.random() + Math.random()) - 1;
}

const VERTEX_BODY = /* glsl */ `
  attribute float aAngle;      // base polar angle on the spiral arm
  attribute float aRadius;     // base radius from the galactic axis
  attribute float aBaseSize;
  attribute float aBaseBright;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aOmega;      // differential angular velocity (inner = faster)
  attribute float aFwd;        // depth travel speed factor
  attribute vec3  aAff;        // low, mid, high affinity
  attribute float aColorMix;

  void main() {
    float low  = uLow  * aAff.x;
    float mid  = uMid  * aAff.y;
    float high = uHigh * aAff.z;
    float lowHit  = uLowHit  * aAff.x;
    float midHit  = uMidHit  * aAff.y;
    float highHit = uHighHit * aAff.z;

    // Differential rotation — each star advances its own angle; arms shear and
    // flow locally instead of the whole galaxy spinning as one object.
    float ang = aAngle + uTime * uSpeed * aOmega;

    // MID: bending waves along the arms. The offset depends on this star's own
    // radius, so inner and outer arm sections bend by different amounts.
    // MID hits add a sharper, faster swirl that races along the arms briefly.
    ang += sin(aRadius * 0.15 - uTime * 1.2 + aPhase) * mid * 0.30;
    ang += sin(aRadius * 0.32 - uTime * 2.6 + aPhase * 1.7) * midHit * 0.22;

    // LOW: push outward along the local arm radial. LOW hits kick a static
    // ~half subset further out for an instant (arms ripple, disc stays intact).
    float kickGate = step(0.5, fract(aSeed * 0.517));
    float r = aRadius + low * (uVolume.x * 0.07) + lowHit * kickGate * (uVolume.x * 0.05);

    vec3 p;
    p.x = cos(ang) * r;
    p.y = sin(ang) * r;

    // Depth travel: drift toward the camera on this element's own speed and
    // wrap to the far plane. LOW gives low-tuned dust/stars an extra kick;
    // LOW hits surge the gated subset (dust hardest — higher aFwd) briefly.
    float halfLen = uVolume.z;
    float z = position.z + uTime * uSpeed * (3.0 + aFwd * 9.0) + low * aFwd * 5.0
            + lowHit * kickGate * aFwd * 7.0;
    p.z = mod(z + halfLen, 2.0 * halfLen) - halfLen;

    // Resting micro-drift — alive even at 0% influence.
    p.x += sin(aPhase + uTime * 0.55) * 0.30;
    p.y += cos(aPhase * 1.31 + uTime * 0.47) * 0.30;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist   = max(-mv.z, 0.001);
    float depthF = clamp((halfLen * 2.0 + CAM_NEAR - dist) / (halfLen * 2.0), 0.10, 1.0);

    // HIGH: independent sparkle in a changing subset (seed + speed decorrelate).
    float tw = fract(sin(aSeed * 91.17 + uTime * (4.0 + aFwd * 5.0)) * 43758.5453);
    float sparkle = high * step(0.70, tw);
    // HIGH hit: fast-reshuffling twinkle subset (~24 Hz); bright nodes flare
    // hardest (aBaseBright weights the flare).
    float twHit = fract(sin(aSeed * 41.9 + floor(uTime * 24.0) * 9.71) * 43758.5453);
    float sparkleHit = highHit * step(0.62, twHit) * (0.6 + aBaseBright * 0.7);

    float size = aBaseSize * uElementSize
               * (1.0 + low * 0.85 + lowHit * kickGate * 0.5 + sparkle * 1.7 + sparkleHit * 1.4);
    gl_PointSize = clamp(size * uPixelScale / dist, 1.0, 64.0);
    gl_Position  = projectionMatrix * mv;

    vec3 col = paletteColor(aColorMix);
    col *= (0.55 + depthF * 0.65);   // nearer = brighter (depth cue)
    col *= aBaseBright;
    col += col * mid * 0.45;         // MID adds energy
    col *= (1.0 + lowHit * kickGate * 0.35); // LOW hit: brightness punch
    col += vec3(sparkle) * 0.95;     // HIGH flare
    col += vec3(sparkleHit) * 1.0;   // HIGH hit twinkle
    col *= (0.75 + uGlow * 0.85);    // Glow lifts luminosity
    vColor   = col;
    vOpacity = clamp(aBaseBright * (0.35 + depthF * 0.65) + low * 0.20 + lowHit * kickGate * 0.30 + sparkle * 0.85 + sparkleHit * 0.70, 0.0, 1.0);
  }
`;

interface CloudSpec {
  count:      number;
  /** Angular scatter around the arm centreline (radians·factor). */
  spread:     number;
  sizeMin:    number; sizeMax:   number;
  brightMin:  number; brightMax: number;
  fwdMin:     number; fwdMax:    number;
  /** Fraction routed to the central bulge/halo instead of an arm. */
  haloFrac:   number;
  /** Every Nth star becomes a bright node (0 = none). */
  nodeEvery:  number;
}

function buildCloud(
  spec: CloudSpec, maxR: number, halfD: number,
): THREE.BufferGeometry {
  const n = spec.count;
  const position = new Float32Array(n * 3);
  const angleA   = new Float32Array(n);
  const radiusA  = new Float32Array(n);
  const sizeA    = new Float32Array(n);
  const brightA  = new Float32Array(n);
  const seedA    = new Float32Array(n);
  const phaseA   = new Float32Array(n);
  const omegaA   = new Float32Array(n);
  const fwdA     = new Float32Array(n);
  const affA     = new Float32Array(n * 3);
  const cmixA    = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Golden-sequence radial distribution: fract(i·φ⁻¹) is the classic
    // low-discrepancy golden-ratio sequence — even coverage, organic look.
    const u = (i * PHI_C) % 1;
    const halo = Math.random() < spec.haloFrac;

    let r: number, ang: number, zThick: number;
    if (halo) {
      // Central bulge — concentrated, thicker, any angle.
      r      = maxR * Math.pow(Math.random(), 1.8) * 0.45;
      ang    = rand(0, TAU);
      zThick = 0.30;
    } else {
      // Spiral arm — radius from the golden sequence (denser core), angle winds
      // outward along the arm with gaussian scatter that tightens with radius.
      r = maxR * Math.pow(u, 0.62);
      const arm = i % ARMS;
      ang = arm * (TAU / ARMS)
          + Math.pow(u, 0.62) * WIND * TAU
          + gauss() * spec.spread * (1.15 - (r / maxR) * 0.55);
      zThick = 0.14;
    }

    position[i * 3 + 0] = Math.cos(ang) * r;
    position[i * 3 + 1] = Math.sin(ang) * r;
    position[i * 3 + 2] = gauss() * halfD * zThick + rand(-halfD, halfD) * 0.06;

    angleA[i]  = ang;
    radiusA[i] = r;

    const node = spec.nodeEvery > 0 && i % spec.nodeEvery === 0;
    sizeA[i]   = node ? rand(2.6, 3.6) : rand(spec.sizeMin, spec.sizeMax);
    brightA[i] = node ? rand(0.90, 1.0) : rand(spec.brightMin, spec.brightMax);
    seedA[i]   = rand(0, 1000);
    phaseA[i]  = rand(0, TAU);
    // Differential rotation: inner stars orbit faster; per-star jitter breaks
    // any rigid-body feel. Sign is shared so the flow reads as one galaxy.
    omegaA[i]  = (0.015 + 0.055 * (1 - r / maxR)) * rand(0.7, 1.3);
    fwdA[i]    = rand(spec.fwdMin, spec.fwdMax);

    const [l, m, h] = randomAffinities();
    affA[i * 3 + 0] = l; affA[i * 3 + 1] = m; affA[i * 3 + 2] = h;

    // Colour ramps outward from the core (t=0 → palette colour A at the centre).
    cmixA[i] = Math.min(1, Math.max(0, (r / maxR) * 0.85 + rand(0, 0.15)));
  }

  const geo = new THREE.BufferGeometry();
  setF32(geo, "position",    position, 3);
  setF32(geo, "aAngle",      angleA,   1);
  setF32(geo, "aRadius",     radiusA,  1);
  setF32(geo, "aBaseSize",   sizeA,    1);
  setF32(geo, "aBaseBright", brightA,  1);
  setF32(geo, "aSeed",       seedA,    1);
  setF32(geo, "aPhase",      phaseA,   1);
  setF32(geo, "aOmega",      omegaA,   1);
  setF32(geo, "aFwd",        fwdA,     1);
  setF32(geo, "aAff",        affA,     3);
  setF32(geo, "aColorMix",   cmixA,    1);
  return geo;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const maxR = Math.min(halfW, halfH) * 0.92;

  // Stars: tight on the arms, brighter, with bright-node beads.
  const starGeo = buildCloud({
    count: STAR_COUNTS[density],
    spread: 0.16,
    sizeMin: 1.1, sizeMax: 2.2,
    brightMin: 0.55, brightMax: 1.0,
    fwdMin: 0.2, fwdMax: 1.4,
    haloFrac: 0.16,
    nodeEvery: 17,
  }, maxR, halfD);

  // Dust: wider scatter, smaller, dimmer, faster — inter-arm haze.
  const dustGeo = buildCloud({
    count: DUST_COUNTS[density],
    spread: 0.34,
    sizeMin: 0.5, sizeMax: 1.0,
    brightMin: 0.16, brightMax: 0.42,
    fwdMin: 0.5, fwdMax: 2.2,
    haloFrac: 0.10,
    nodeEvery: 0,
  }, maxR, halfD);

  // One shared shader material drives both clouds.
  const material = makeMaterial(VERTEX_BODY, shared);

  const stars = new THREE.Points(starGeo, material);
  const dust  = new THREE.Points(dustGeo, material);
  stars.frustumCulled = false;
  dust.frustumCulled  = false;

  const root = new THREE.Group();
  root.add(dust);   // haze behind…
  root.add(stars);  // …stars on top

  return {
    root,
    dispose() {
      starGeo.dispose();
      dustGeo.dispose();
      material.dispose();
    },
  };
}

export const goldenGalaxyTemplate: VisualTemplate = {
  id: "golden-galaxy",
  create: build,
};
