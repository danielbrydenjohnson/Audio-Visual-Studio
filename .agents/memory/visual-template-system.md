---
name: Audio Reactive Studio — visual template system
description: How multi-template 3D visuals share one renderer/canvas, the <=16 vertex-attribute limit, the GLSL1 uniform-array gotcha, the captureStream post-processing rule, fixed recording resolution (DPR kept out of the buffer) with a letterboxed preview, the 60fps-frame-ref/30Hz-state audio routing, and hit-transient mapping rules.
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

## Fully GPU-computed geometry still needs a `position` attribute
A template whose vertex shader computes position ENTIRELY from custom attributes
(e.g. Lissajous Lattice builds each point from a param + strand freq/phase/amp) must
STILL register a `position` BufferAttribute — set a zero-filled `Float32Array(verts*3)`.
Three.js uses `position` to infer draw range / vertex count; omit it and the object
draws nothing (or throws). The shader can ignore its value.

## Fragment-shader float precision MUST be highp (matches vertex default)
Any shared fragment shader that declares a uniform ALSO declared in the vertex
stage (via GLSL_HEADER — e.g. `uGlow`) must use `precision highp float;`, not
`mediump`. Vertex shaders default float precision to **highp** (guaranteed in GLSL
ES), so a `mediump` fragment declaring the same uniform makes its precision differ
across stages → the program fails VALIDATE_STATUS with "Precisions of uniform 'X'
differ between VERTEX and FRAGMENT shaders" → the material renders **nothing**
(silent blank, only visible in the browser console).

**Why:** this made the point-sprite template (Fibonacci Spiral — the only one using
the point-sprite FRAGMENT_SHADER) render blank while line templates were unaffected
(their fragment shader didn't redeclare `uGlow`). highp fragment precision is always
available under WebGL2 (three ≥ r163), so there's no downside.
**How to apply:** keep ALL shared fragment shaders (`FRAGMENT_SHADER`,
`LINE_FRAGMENT_SHADER`) at `highp` for parity; never mix `mediump` fragment with a
`highp`-default vertex uniform.

## Final composite: one RT → one shader for BOTH modes
Both normal AND kaleidoscope modes render scene → persistent `WebGLRenderTarget` →
ONE fullscreen shader → canvas. The shader branches the kaleidoscope fold on a
`uKaleidoscope` uniform (no rebuild), then ALWAYS applies global brightness
`out = 1 - pow(1 - c, uBrightness)` (uBrightness = brightness/100, c clamped 0..1).
The final draw MUST target `renderer.domElement` (null RT), because `captureStream`
records that canvas — if the last render lands on an RT, recording captures nothing.

**Why routing the previously-direct normal path through the RT is safe (no color shift):**
`THREE.ColorManagement.enabled = false` is set globally (so palette hex renders as
authored under additive blending). With color management OFF, three does NO
linear/sRGB conversion on output, so raw colors are written identically whether the
bound target is the canvas or an 8-bit (default `UnsignedByteType`) RT cleared to the
same clear color; additive overflow clamps to 1.0 in both. Hence scene→RT→passthrough
is pixel-identical to scene→canvas, and brightness `1-pow(1-c,1)` is exact identity at
100% — so unifying the two paths preserves the previous default look. Do NOT add a
linear→sRGB / gamma output pass here; it would double-darken since nothing upstream
encoded to sRGB.

**MSAA:** rendering through an RT loses the renderer's `antialias:true` (that applies
only to the default framebuffer), so add `samples: 4` to the `WebGLRenderTarget` to
restore edge AA on the off-screen pass. three ≥ r163 is WebGL2-only (WebGL1 removed),
so RT multisampling is always available wherever the app actually renders — no WebGL1
fallback to guard.

**How to apply:** resize the RT in `applyFraming` to the exact output dims (buffer NOT
multiplied by DPR); set RT texture wrap to MirroredRepeat so radial samples outside
[0,1] fold seamlessly; per-frame updates are plain uniform writes
(uKaleidoscope/uSegments/uBrightness) — no shader rebuild, no per-frame allocation;
dispose RT/quad geo/material only at unmount, never on toggle.

## GLSL ES 1.0 uniform-array indexing gotcha
Three.js `ShaderMaterial` defaults to GLSL ES 1.00, which forbids indexing a
uniform array with a **non-constant** expression (e.g. an attribute-derived int).
Orbital Swarm needs `uAttractors[perParticleIndex]` — so it selects via a
constant-bound loop instead: `for (int i=0;i<MAX;i++){ if (i==idx) att=uAttractors[i]; }`.

**Why:** dynamic indexing compiles fine in WebGL2/GLSL3 but errors under the default
GLSL1 path; switching the material to `GLSL3` would force rewriting all shaders
(in/out, texture()). The loop keeps every template on the default path.

## Fixed recording resolution + letterboxed preview
Output format (aspect ratio / resolution / frame rate) is strongly typed in
`src/types/output.ts` with a central exact-dimension table; the renderer records those
EXACT pixels. To guarantee that: `renderer.setPixelRatio(1)` + `setSize(outW, outH,
false)` so the drawing buffer equals the selected output size, and the RT + post
`uResolution` also use the output dims. DPR is kept OUT of the buffer on purpose.

**Why:** `captureStream` records the drawing buffer, so any DPR multiply silently
inflates the recording (accidental 2x/4K, dropped frames). DPR should only ever affect
the *displayed* size, never the recorded pixels.

**How to apply:** letterbox the PREVIEW with JS-computed contain-fit CSS on the canvas
element (`style.width/height` in px) inside an `absolute inset-0` flex-centered dark
wrapper — not CSS `aspect-ratio`, and not a ResizeObserver on the canvas (both risk
feedback loops). A browser resize then only rescales CSS, never the recorded pixels.
World volume width tracks the frame via `halfW = BASE_HALF_H * outputAspect`, so all
templates fill all 3 aspects with ONE responsive calc (no per-aspect code). Rebuild the
template root only on ASPECT change (templates without `onFraming` won't redistribute
otherwise); resolution-only changes just resize the buffer/RT. Any perf-warning FPS
threshold must scale to the SELECTED target fps (e.g. 75% of it), or 30 fps mode
false-warns against a 60 fps-oriented constant.

## Audio signals: 60 fps mutable frame ref + 30 Hz React state
The analysis engine writes per-band `{level, hit}` into ONE mutable `AnalysisFrame`
(stable identity, lazily created in a ref). The renderer reads it inside its own rAF
via a ref-of-ref (the prop is the RefObject; a render-updated ref holds the prop).
React `bands` state is emitted at ~30 Hz for the meters only, with hit values
PEAK-HELD between emissions (max, not last sample) so 1-frame spikes stay visible.

**Why:** pushing 60 fps audio through React state re-renders the app every frame and
blurs 2–5 ms transients; the frame-ref path keeps hits crisp, and hit sliders stay
editable mid-recording because settings flow through a render-updated ref (`hitRef`)
instead of analyser-effect deps (the audio graph never restarts on tweaks).

## Hit (transient) mapping rule: integrate, never scale accumulated rotation
Rotation expressed as `angle = rate * time` must NEVER get its rate multiplied by a
transient envelope — when the envelope decays, the angle snaps back (rubber-band
back-rotation). Map hits as angular-velocity bursts integrated separately:
`hitAngle = (hitAngle + hit * dt * k) % TAU`, added onto the base angle and
sign-matched to the element's own spin direction. Scale/brightness/position punches
may ride the raw envelope directly (easing back is the point). Keep hit reactions
per-element: static seed gates for "some elements respond" (bass-punch subsets),
`floor(time*24)`-hashed reshuffling subsets for sparkle/glint — never whole-root
transforms or full-scene flashes, and independent hash constants per subset so
level-flicker and hit-glint groups don't correlate.
