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

## Post pipeline: one persistent EffectComposer for BOTH modes (linear/HDR regime)
Both normal AND kaleidoscope modes render through ONE EffectComposer built once:
RenderPass → kaleidoscope/brightness ShaderPass (always enabled; branches the fold on
a `uKaleidoscope` uniform, then applies brightness `1 - pow(1-c, uBrightness)` on the
CLAMPED 0–1 base while HDR excess >1 is split off and re-added so bloom keeps its
highlights) → UnrealBloomPass (`.enabled/.strength/.radius/.threshold` are per-frame
property writes from a ref) → OutputPass. The last enabled pass renders to
`renderer.domElement`, so `captureStream` records the post-processed canvas — if the
last render lands on an RT, recording captures nothing.

**Colour regime:** `THREE.ColorManagement.enabled = true` + ACES filmic tone mapping.
Palette hex converts sRGB→linear at `.set()` time, the whole chain runs in linear
light, and OutputPass applies ACES + linear→sRGB EXACTLY ONCE (it reads
`renderer.toneMapping` / `toneMappingExposure` each render, so exposure is a live
per-frame write). Custom raw-GLSL template shaders include no tonemapping/colorspace
chunks, and scene materials don't tone-map when rendering to intermediate RTs — so
nothing converts twice. (An older regime had CM disabled with a manual RT+quad; that
advice is obsolete.)

**Composer target:** pass a custom `WebGLRenderTarget(1,1,{type:HalfFloatType,
samples:4})` with MirroredRepeatWrapping to the composer constructor — HalfFloat gives
HDR headroom for additive blending/bloom, samples:4 restores MSAA lost off the default
framebuffer, MirroredRepeat lets the kaleidoscope fold sample outside [0,1] seamlessly
(the composer clones the target for its second buffer, wrap included).

**How to apply:** `composer.setSize(outW,outH)` in framing (exact output dims, DPR
never multiplied in; it fans out to every pass incl. bloom's internal mips); all
per-frame updates are plain uniform/property writes — never rebuild composer or
passes; on unmount dispose each pass AND `composer.dispose()` (frees rt1/rt2).

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

## Low band = physical separation/expansion (design language)
Low (20–100 Hz kick/sub) maps to PHYSICAL space across all templates: elements
separate / push outward from the structure's centre, shapes breathe/expand with
bounded punches — never plain brightness lifts, chaos, or whole-root scaling.
Whole-structure breathing is allowed only where the structure is one coherent form
(Fibonacci Spiral's radial breath). Wireframe Core is a deliberate exception (left
untouched by request). **Why:** user-specified retune (July 2026) after narrowing
Low to 20–100 Hz — kicks should read as pressure/impact, not flash. **How to
apply:** in new templates map Low level → sustained outward/spacing pressure and
Low hit → separation/expansion punch riding the envelope; keep brightness terms
secondary; per-element magnitude variation (seed) so nothing moves as one rigid body.

## Template dispose() must release EVERYTHING the template allocated
`InstancedMesh` needs its own `.dispose()` (frees instanceMatrix/instanceColor GPU
buffers) in addition to geometry/material disposal. Missed once in a line+spheres
template and only a review caught it — leaks accumulate fast here because roots are
rebuilt on every template/density/aspect hot-swap.

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
