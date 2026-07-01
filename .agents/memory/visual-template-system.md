---
name: Audio Reactive Studio — visual template system
description: How multi-template 3D visuals share one renderer/canvas, the <=16 vertex-attribute limit, the GLSL1 uniform-array gotcha, and the captureStream post-processing rule.
---

# Visual template system (Audio Reactive Studio)

Multiple distinct 3D looks ("templates") share ONE WebGLRenderer/scene/camera/RAF/
ResizeObserver/canvas. Each template contributes exactly one generic
`THREE.Object3D` **root** (Points, InstancedMesh, LineSegments, or a Group of
children). Only that root is hot-swapped on template OR density change: remove from
scene, `dispose()`, create the new root, re-add. Never create a second
renderer/context/loop/observer/render-target.

**Why:** a new WebGL context on switch would interrupt audio playback and break the
MediaRecorder canvas-capture stream (recording taps the persistent canvas). The
single-run `useEffect([])` reads props via refs so it never restarts.

**How to apply:** shared uniform *objects* (`createSharedUniforms`) are spread by
reference into every template material via `makeMaterial`, so palette/speed/
elementSize/glow/depth propagate to whichever template is active. CPU-driven
templates (InstancedMesh cubes/polyhedra, wireframe Groups) read the same uniform
objects each frame. Templates implement `VisualTemplate` → `{ root, onFrame?,
onFraming?, dispose }`. Density is passed as `DensityLevel`; each template maps it to
its own element count (point counts differ from mesh/line counts). Depth is
reinterpreted per template from `uVolume.z`. CPU InstancedMesh templates parent their
lights UNDER the root (so lights are added/removed with the swap) and seed
`instanceColor` once via `setColorAt` before the first render.

## <=16 vertex attributes per shader (hard limit)
Every shader must use **<= 16 vertex attributes including built-in `position`**, or
`gl.MAX_VERTEX_ATTRIBS` is exceeded, the program silently fails to link, and the
template renders **nothing** (no throw, no obvious error). Pack scalars into vectors
(e.g. `aMisc` vec4, `aAff` vec3) and unpack to locals at the top of `main()`.

**Why:** this cost a full debugging session — Particle Field (12 attrs) worked while
Orbital Swarm (18) and Pulse Tunnel (17) rendered blank until packed down.
**How to apply:** count attributes whenever adding per-vertex data to a template.

## Recorded post-processing must end on the canvas
Kaleidoscope (and any post pass) uses a persistent `WebGLRenderTarget` + fullscreen
fold shader. Off → render scene straight to canvas. On → render scene to the RT, then
render the fullscreen pass to the **default framebuffer (canvas)**. The final draw
MUST target `renderer.domElement`, because `captureStream(60)` records that canvas —
if the last render goes to an RT instead, recording captures nothing.

**Why:** the recorder taps the live canvas, not the scene.
**How to apply:** resize the RT in `applyFraming` (drawing-buffer size = width*dpr);
set RT texture wrap to MirroredRepeat so radial samples outside [0,1] fold seamlessly;
dispose the RT/quad geo/material only at unmount, never on toggle.

## GLSL ES 1.0 uniform-array indexing gotcha
Three.js `ShaderMaterial` defaults to GLSL ES 1.00, which forbids indexing a
uniform array with a **non-constant** expression (e.g. an attribute-derived int).
Orbital Swarm needs `uAttractors[perParticleIndex]` — so it selects via a
constant-bound loop instead: `for (int i=0;i<MAX;i++){ if (i==idx) att=uAttractors[i]; }`.

**Why:** dynamic indexing compiles fine in WebGL2/GLSL3 but errors under the default
GLSL1 path; switching the material to `GLSL3` would force rewriting all shaders
(in/out, texture()). The loop keeps every template on the default path.
