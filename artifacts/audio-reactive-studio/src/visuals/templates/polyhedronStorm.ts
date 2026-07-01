import * as THREE from "three";
import {
  type VisualTemplate,
  type TemplateCreateArgs,
  type TemplateRuntime,
  type SharedUniforms,
  rand,
  randomAffinities,
  paletteMix,
  wrap,
} from "@/visuals/shared";
import type { DensityLevel } from "@/types/visualizer";

/**
 * POLYHEDRON STORM — angular shapes (tetrahedra, octahedra, icosahedra) tumbling
 * through turbulent 3D space. Efficient: exactly THREE InstancedMesh children (one
 * per geometry type) share one Lambert material; every instance is driven CPU-side.
 * Different geometry types drift at slightly different speeds. Per-instance:
 *
 *   LOW  → heavy scale pulses + directional impulse; a subset surges toward camera
 *   MID  → stronger individual tumbling + curved, phase-based position distortion
 *   HIGH → a changing subset sparkles: sharp extra rotation + brightness spike
 *
 * The root group is never rotated or scaled as the primary motion.
 */

const TOTALS: Record<DensityLevel, number> = { low: 180, medium: 450, high: 800 };

function fract(x: number): number { return x - Math.floor(x); }

interface InstGroup {
  mesh:     THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  count:    number;
  speedF:   number;               // per-geometry-type speed factor
  baseX: Float32Array; baseY: Float32Array; baseZ: Float32Array;
  velX:  Float32Array; velY:  Float32Array; velZ:  Float32Array;
  rotX:  Float32Array; rotY:  Float32Array; rotZ:  Float32Array;
  rotSX: Float32Array; rotSY: Float32Array; rotSZ: Float32Array;
  scale: Float32Array; seed:  Float32Array; phase: Float32Array;
  lowAff: Float32Array; midAff: Float32Array; highAff: Float32Array;
  toCam: Float32Array; cmix: Float32Array; baseColor: Float32Array;
}

function makeGroup(
  geometry: THREE.BufferGeometry, count: number, speedF: number,
  halfW: number, halfH: number, halfD: number, material: THREE.Material,
): InstGroup {
  const g: InstGroup = {
    mesh: new THREE.InstancedMesh(geometry, material, count),
    geometry, count, speedF,
    baseX: new Float32Array(count), baseY: new Float32Array(count), baseZ: new Float32Array(count),
    velX:  new Float32Array(count), velY:  new Float32Array(count), velZ:  new Float32Array(count),
    rotX:  new Float32Array(count), rotY:  new Float32Array(count), rotZ:  new Float32Array(count),
    rotSX: new Float32Array(count), rotSY: new Float32Array(count), rotSZ: new Float32Array(count),
    scale: new Float32Array(count), seed:  new Float32Array(count), phase: new Float32Array(count),
    lowAff: new Float32Array(count), midAff: new Float32Array(count), highAff: new Float32Array(count),
    toCam: new Float32Array(count), cmix: new Float32Array(count), baseColor: new Float32Array(count * 3),
  };
  g.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  g.mesh.frustumCulled = false;
  const tmp = new THREE.Color();
  for (let i = 0; i < count; i++) {
    g.baseX[i] = rand(-halfW, halfW);
    g.baseY[i] = rand(-halfH, halfH);
    g.baseZ[i] = rand(-halfD, halfD);
    const vx = rand(-1, 1), vy = rand(-1, 1), vz = rand(-1, 1);
    const vl = Math.hypot(vx, vy, vz) || 1;
    const vs = rand(1.4, 5.0);
    g.velX[i] = (vx / vl) * vs; g.velY[i] = (vy / vl) * vs; g.velZ[i] = (vz / vl) * vs;
    g.rotX[i] = rand(0, Math.PI * 2); g.rotY[i] = rand(0, Math.PI * 2); g.rotZ[i] = rand(0, Math.PI * 2);
    g.rotSX[i] = rand(-1.1, 1.1); g.rotSY[i] = rand(-1.1, 1.1); g.rotSZ[i] = rand(-1.1, 1.1);
    g.scale[i] = rand(1.6, 4.2);
    g.seed[i] = rand(0, 1000);
    g.phase[i] = rand(0, Math.PI * 2);
    g.toCam[i] = Math.random() < 0.4 ? 1 : 0;
    g.cmix[i] = Math.random();
    const [l, m, h] = randomAffinities();
    g.lowAff[i] = l; g.midAff[i] = m; g.highAff[i] = h;
    g.mesh.setColorAt(i, tmp.setRGB(1, 1, 1));
  }
  return g;
}

// Module-scope reused temporaries (updates run sequentially per group).
const dummy  = new THREE.Object3D();
const velDir = new THREE.Vector3();
const tmpCol = new THREE.Color();

function refreshGroupColors(g: InstGroup, shared: SharedUniforms): void {
  const a = shared.uColorA.value, b = shared.uColorB.value, c = shared.uColorC.value;
  for (let i = 0; i < g.count; i++) {
    paletteMix(g.cmix[i], a, b, c, tmpCol);
    g.baseColor[i * 3 + 0] = tmpCol.r;
    g.baseColor[i * 3 + 1] = tmpCol.g;
    g.baseColor[i * 3 + 2] = tmpCol.b;
  }
}

function updateGroup(
  g: InstGroup, time: number, audio: { low: number; mid: number; high: number },
  speed: number, esize: number, glow: number, hw: number, hh: number, hd: number,
): void {
  const gs = speed * g.speedF;
  for (let i = 0; i < g.count; i++) {
    const lowR  = audio.low  * g.lowAff[i];
    const midR  = audio.mid  * g.midAff[i];
    const highR = audio.high * g.highAff[i];

    let px = wrap(g.baseX[i] + g.velX[i] * time * gs, hw);
    let py = wrap(g.baseY[i] + g.velY[i] * time * gs, hh);
    let pz = wrap(g.baseZ[i] + g.velZ[i] * time * gs, hd);

    // LOW: directional impulse; flagged shapes surge toward the camera (+z).
    if (lowR > 0.0001) {
      velDir.set(g.velX[i], g.velY[i], g.velZ[i]).normalize();
      const imp = lowR * 10.0;
      px += velDir.x * imp; py += velDir.y * imp; pz += velDir.z * imp;
      if (g.toCam[i] > 0.5) pz += lowR * 16.0;
    }
    // MID: curved, phase-based position distortion.
    if (midR > 0.0001) {
      const amp = midR * 7.0;
      px += Math.sin(g.phase[i] + time * 1.8) * amp;
      py += Math.cos(g.phase[i] * 1.3 + time * 1.6) * amp;
      pz += Math.sin(g.phase[i] * 0.7 + time * 2.0) * amp;
    }

    const tw = fract(Math.sin(g.seed[i] * 91.17 + time * (5.0 + g.rotSX[i])) * 43758.5453);
    const flick = highR * (tw > 0.72 ? 1 : 0);

    const rs = gs * (1 + midR * 1.8);
    dummy.rotation.set(
      g.rotX[i] + g.rotSX[i] * time * rs + flick * 2.6,
      g.rotY[i] + g.rotSY[i] * time * rs + flick * 1.8,
      g.rotZ[i] + g.rotSZ[i] * time * rs,
    );
    // LOW: heavy scale pulse (per instance; never the whole group).
    const s = g.scale[i] * esize * (1 + lowR * 1.2 + flick * 0.6);
    dummy.position.set(px, py, pz);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    g.mesh.setMatrixAt(i, dummy.matrix);

    const bright = 0.7 + glow * 0.7 + lowR * 0.3 + flick * 1.7;
    tmpCol.setRGB(
      g.baseColor[i * 3 + 0] * bright,
      g.baseColor[i * 3 + 1] * bright,
      g.baseColor[i * 3 + 2] * bright,
    );
    g.mesh.setColorAt(i, tmpCol);
  }
  g.mesh.instanceMatrix.needsUpdate = true;
  if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
}

function build({ density, halfW, halfH, halfD, shared }: TemplateCreateArgs): TemplateRuntime {
  const total = TOTALS[density];
  const c0 = Math.round(total / 3);
  const c1 = Math.round(total / 3);
  const c2 = total - c0 - c1;

  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const geoTetra = new THREE.TetrahedronGeometry(1);
  const geoOcta  = new THREE.OctahedronGeometry(1);
  const geoIcosa = new THREE.IcosahedronGeometry(1);

  const groups: InstGroup[] = [
    makeGroup(geoTetra, c0, 1.2,  halfW, halfH, halfD, material),
    makeGroup(geoOcta,  c1, 1.0,  halfW, halfH, halfD, material),
    makeGroup(geoIcosa, c2, 0.82, halfW, halfH, halfD, material),
  ];

  const root = new THREE.Group();
  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(0.5, 1.0, 0.7);
  const rim = new THREE.DirectionalLight(0xff88cc, 0.35);
  rim.position.set(-0.6, -0.4, -0.7);
  root.add(ambient, key, rim);
  for (const g of groups) root.add(g.mesh);

  for (const g of groups) refreshGroupColors(g, shared);

  let hw = halfW, hh = halfH, hd = halfD;
  let lastHexA = -1, lastHexB = -1, lastHexC = -1;

  return {
    root,
    onFrame(time, _dt, audio) {
      const speed = shared.uSpeed.value;
      const esize = shared.uElementSize.value;
      const glow  = shared.uGlow.value;

      const hexA = shared.uColorA.value.getHex();
      const hexB = shared.uColorB.value.getHex();
      const hexC = shared.uColorC.value.getHex();
      if (hexA !== lastHexA || hexB !== lastHexB || hexC !== lastHexC) {
        lastHexA = hexA; lastHexB = hexB; lastHexC = hexC;
        for (const g of groups) refreshGroupColors(g, shared);
      }

      for (const g of groups) updateGroup(g, time, audio, speed, esize, glow, hw, hh, hd);
    },
    onFraming(nw, nh, nd) {
      hw = nw; hh = nh; hd = nd;
    },
    dispose() {
      material.dispose();
      for (const g of groups) {
        g.geometry.dispose();
        g.mesh.dispose();
      }
    },
  };
}

export const polyhedronStormTemplate: VisualTemplate = {
  id: "polyhedron-storm",
  create: build,
};
