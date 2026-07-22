import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  rand,
  randomAffinities,
  paletteMix,
  wrap,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * CUBE SWARM — a field of individually reactive cubes rendered with ONE
 * THREE.InstancedMesh (never one Mesh per cube). Each cube has stable per-instance
 * attributes (position, velocity, rotation + rotation speed, base scale, band
 * affinities, seed, phase). Matrices and colours are updated CPU-side each frame
 * into the instance buffers — cheap at these counts and fully per-instance:
 *
 *   LOW  → low-affinity cubes swell + get a short impulse along their own velocity
 *   MID  → mid-affinity cubes tumble faster + drift on curved local paths
 *   HIGH → a changing subset flickers brighter + snaps into sharp extra rotation
 *
 * Hit envelopes (transients) act on top, always per-cube and bounded:
 *
 *   LOW hit  → a static ~half subset jumps further along its velocity + a scale punch
 *   MID hit  → per-cube angular-velocity burst (accumulated, so no back-rotation)
 *   HIGH hit → fast-changing subset (~24 Hz reshuffle) glints bright with a size pop
 *
 * Lambert shading + lights make the cubes read as solid 3D geometry (not sprites).
 * The whole swarm never scales or rotates as one object, and no hit ever
 * flashes the full scene.
 */

const COUNTS: Record<DensityLevel, number> = { low: 250, medium: 600, high: 1000 };

function fract(x: number): number { return x - Math.floor(x); }

const TAU = Math.PI * 2;

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const count = COUNTS[density];

  // Per-instance stable attributes.
  const baseX = new Float32Array(count);
  const baseY = new Float32Array(count);
  const baseZ = new Float32Array(count);
  const velX  = new Float32Array(count);
  const velY  = new Float32Array(count);
  const velZ  = new Float32Array(count);
  const rotX  = new Float32Array(count);
  const rotY  = new Float32Array(count);
  const rotZ  = new Float32Array(count);
  const rotSX = new Float32Array(count);
  const rotSY = new Float32Array(count);
  const rotSZ = new Float32Array(count);
  const scale = new Float32Array(count);
  const lowAff  = new Float32Array(count);
  const midAff  = new Float32Array(count);
  const highAff = new Float32Array(count);
  const seed  = new Float32Array(count);
  const phase = new Float32Array(count);
  const cmix  = new Float32Array(count);
  /** Static gate: which cubes respond to LOW hits with a velocity jump (~55 %). */
  const gateLow = new Float32Array(count);
  /** Accumulated MID-hit tumble angle per cube (angular-velocity burst). */
  const hitSpin = new Float32Array(count);
  const baseColor = new Float32Array(count * 3); // palette colour per cube

  for (let i = 0; i < count; i++) {
    baseX[i] = rand(-halfW, halfW);
    baseY[i] = rand(-halfH, halfH);
    baseZ[i] = rand(-halfD, halfD);
    const vx = rand(-1, 1), vy = rand(-1, 1), vz = rand(-1, 1);
    const vl = Math.hypot(vx, vy, vz) || 1;
    const vspeed = rand(1.5, 5.5);
    velX[i] = (vx / vl) * vspeed;
    velY[i] = (vy / vl) * vspeed;
    velZ[i] = (vz / vl) * vspeed;
    rotX[i] = rand(0, Math.PI * 2);
    rotY[i] = rand(0, Math.PI * 2);
    rotZ[i] = rand(0, Math.PI * 2);
    rotSX[i] = rand(-1, 1);
    rotSY[i] = rand(-1, 1);
    rotSZ[i] = rand(-1, 1);
    scale[i] = rand(1.1, 3.0);
    seed[i]  = rand(0, 1000);
    phase[i] = rand(0, Math.PI * 2);
    cmix[i]  = Math.random();
    gateLow[i] = Math.random() < 0.55 ? 1 : 0;
    const [l, m, h] = randomAffinities();
    lowAff[i] = l; midAff[i] = m; highAff[i] = h;
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;

  const root = new THREE.Group();
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(0.6, 1.0, 0.8);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.35);
  rim.position.set(-0.7, -0.3, -0.6);
  root.add(ambient, key, rim, mesh);

  // Seed the instance colour buffer so InstancedMesh.instanceColor exists.
  const tmpColor = new THREE.Color();
  for (let i = 0; i < count; i++) mesh.setColorAt(i, tmpColor.setRGB(1, 1, 1));

  // Reused each frame — no per-frame allocation.
  const dummy = new THREE.Object3D();
  const velDir = new THREE.Vector3();
  let hw = halfW, hh = halfH, hd = halfD;
  let lastHexA = -1, lastHexB = -1, lastHexC = -1;

  function refreshBaseColors(): void {
    const a = shared.uColorA.value, b = shared.uColorB.value, c = shared.uColorC.value;
    for (let i = 0; i < count; i++) {
      paletteMix(cmix[i], a, b, c, tmpColor);
      baseColor[i * 3 + 0] = tmpColor.r;
      baseColor[i * 3 + 1] = tmpColor.g;
      baseColor[i * 3 + 2] = tmpColor.b;
    }
  }
  refreshBaseColors();

  return {
    root,
    onFrame(time, dt, audio) {
      const speed = shared.uSpeed.value;
      const esize = shared.uElementSize.value;
      const glow  = shared.uGlow.value;
      // High-hit glints reshuffle their subset ~24×/s so repeated hits land on
      // different cubes instead of strobing the same ones.
      const glintSlot = Math.floor(time * 24);

      // Recompute palette colours only when the palette actually changes.
      const hexA = shared.uColorA.value.getHex();
      const hexB = shared.uColorB.value.getHex();
      const hexC = shared.uColorC.value.getHex();
      if (hexA !== lastHexA || hexB !== lastHexB || hexC !== lastHexC) {
        lastHexA = hexA; lastHexB = hexB; lastHexC = hexC;
        refreshBaseColors();
      }

      for (let i = 0; i < count; i++) {
        const lowR  = audio.low  * lowAff[i];
        const midR  = audio.mid  * midAff[i];
        const highR = audio.high * highAff[i];
        // Hit reactions weight by the same per-cube affinities, so the influence
        // sliders scale level and hit responses together.
        const lowHitR  = audio.lowHit  * lowAff[i]  * gateLow[i];
        const midHitR  = audio.midHit  * midAff[i];
        const highHitR = audio.highHit * highAff[i];

        // Base drift, wrapped independently per axis (each cube on its own path).
        let px = wrap(baseX[i] + velX[i] * time * speed, hw);
        let py = wrap(baseY[i] + velY[i] * time * speed, hh);
        let pz = wrap(baseZ[i] + velZ[i] * time * speed, hd);

        // LOW: short impulse along this cube's own velocity direction — the
        // sustained level pushes gently, a kick hit shoves the gated subset
        // harder for an instant and eases back with the envelope.
        if (lowR > 0.0001 || lowHitR > 0.0001) {
          velDir.set(velX[i], velY[i], velZ[i]).normalize();
          const imp = lowR * 9.0 + lowHitR * 14.0;
          px += velDir.x * imp;
          py += velDir.y * imp;
          pz += velDir.z * imp;
        }

        // MID: curved local drift using this cube's phase (never a global move).
        if (midR > 0.0001) {
          const amp = midR * 1.5;
          px += Math.sin(phase[i] + time * 1.7) * amp;
          py += Math.cos(phase[i] * 1.3 + time * 1.5) * amp;
          pz += Math.sin(phase[i] * 0.7 + time * 1.9) * amp;
        }

        // HIGH: changing subset flickers + snaps into sharp extra rotation.
        const tw = fract(Math.sin(seed[i] * 91.17 + time * (5.0 + rotSX[i])) * 43758.5453);
        const flick = highR * (tw > 0.7 ? 1 : 0);

        // HIGH hit: an independent, fast-reshuffling subset glints on transients.
        const twHit = fract(Math.sin(seed[i] * 13.7 + glintSlot * 17.31) * 43758.5453);
        const glint = highHitR * (twHit > 0.6 ? 1 : 0);

        // MID hit: bounded direct envelope — reads the current hit envelope each
        // frame so the spin decays naturally with the envelope (no accumulation).
        hitSpin[i] = midHitR * 1.5;

        // Per-cube tumbling; MID speeds it up, HIGH adds a sharp snap.
        const rs = speed * (1 + midR * 0.4);
        const spinDirX = rotSX[i] < 0 ? -1 : 1;
        const spinDirY = rotSY[i] < 0 ? -1 : 1;
        dummy.rotation.set(
          rotX[i] + rotSX[i] * time * rs + flick * 2.2 + hitSpin[i] * spinDirX,
          rotY[i] + rotSY[i] * time * rs + flick * 1.6 + hitSpin[i] * 0.7 * spinDirY,
          rotZ[i] + rotSZ[i] * time * rs,
        );

        // LOW swells the cube (level) and punches it on kicks (hit); the swarm
        // is never scaled as a whole. HIGH-hit glints add a small size pop.
        const s = scale[i] * esize * (1 + lowR * 0.8 + lowHitR * 0.5 + flick * 0.5 + glint * 0.22);
        dummy.position.set(px, py, pz);
        dummy.scale.set(s, s, s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);

        // Colour: palette base × brightness (glow + LOW lift + HIGH flicker +
        // HIGH-hit glint on its own subset).
        const bright = 0.7 + glow * 0.7 + lowR * 0.25 + flick * 1.6 + glint * 1.8;
        tmpColor.setRGB(
          baseColor[i * 3 + 0] * bright,
          baseColor[i * 3 + 1] * bright,
          baseColor[i * 3 + 2] * bright,
        );
        mesh.setColorAt(i, tmpColor);
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    onFraming(nw, nh, nd) {
      hw = nw; hh = nh; hd = nd;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

export const cubeSwarmTemplate: VisualTemplate = {
  id: "cube-swarm",
  create: build,
};
