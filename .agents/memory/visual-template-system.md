---
name: Audio Reactive Studio — visual template system
description: How multi-template 3D visuals share one renderer, and the GLSL ES 1.0 uniform-array indexing gotcha.
---

# Visual template system (Audio Reactive Studio)

Multiple distinct 3D looks ("templates") share ONE WebGLRenderer/scene/camera/RAF/
ResizeObserver/canvas. Only the `THREE.Points` (geometry + material) is hot-swapped
on template OR density change: remove from scene, dispose old geo+material, create
new, re-add. Never create a second renderer/context/loop/observer.

**Why:** a new WebGL context on switch would interrupt audio playback and break the
MediaRecorder canvas-capture stream (recording taps the persistent canvas). The
single-run `useEffect([])` reads props via refs so it never restarts.

**How to apply:** shared uniform *objects* (`createSharedUniforms`) are spread by
reference into every template material via `makeMaterial`, so palette/speed/size/
glow/depth propagate to whichever template is active. Templates implement a
`VisualTemplate` interface (create → `{ points, onFrame?, onFraming?, dispose }`).
Depth is reinterpreted per template from `uVolume.z`.

## GLSL ES 1.0 uniform-array indexing gotcha
Three.js `ShaderMaterial` defaults to GLSL ES 1.00, which forbids indexing a
uniform array with a **non-constant** expression (e.g. an attribute-derived int).
Orbital Swarm needs `uAttractors[perParticleIndex]` — so it selects via a
constant-bound loop instead: `for (int i=0;i<MAX;i++){ if (i==idx) att=uAttractors[i]; }`.

**Why:** dynamic indexing compiles fine in WebGL2/GLSL3 but errors under the default
GLSL1 path; switching the material to `GLSL3` would force rewriting all shaders
(in/out, texture()). The loop keeps every template on the default path.
