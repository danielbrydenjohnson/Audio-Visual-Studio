---
name: WebGL & AudioContext singletons across HMR/remount
description: Patterns for browser resources that must not be re-created on React remount/HMR in this repo
---

# Singleton browser resources across HMR / StrictMode remount

**Rule:** Browser resources that can only be created once per element/page must be
guarded so React StrictMode double-mount and Vite HMR remounts don't re-create them.

- **AudioContext + MediaElementAudioSourceNode:** `createMediaElementSource()` may be
  called AT MOST ONCE per `<audio>` element, ever. Store the `{ctx, source}` pair in a
  module-level `WeakMap<HTMLAudioElement, ...>` (`audioGraphRegistry` in
  `useFrequencyAnalysis.ts`). Unmount cleanup disconnects only the analyser — never
  closes the ctx or clears the registry. WeakMap GCs when the element leaves the DOM.

**Why:** A naive per-hook guard resets to null on remount and calls
`createMediaElementSource` twice → throws "already connected to a different
MediaElementSourceNode".

**How to apply:** For the Three.js `WebGLRenderer`, the effect creates+disposes it in a
single `useEffect([])`; on unmount call `renderer.dispose()` + `forceContextLoss()` and
remove the canvas so remount makes exactly one fresh context. Wrap `new WebGLRenderer()`
in try/catch — headless/screenshot browsers throw "BindToCurrentSequence failed" and the
uncaught throw otherwise crashes the component. Show a fallback instead.

**Note:** The Replit screenshot tool's headless browser cannot create a WebGL context, so
WebGL apps always show the fallback in screenshots — this does NOT mean the app is broken
for real users. Verify GL logic by other means.

## Recording tap on the shared audio graph

- The graph also holds a `MediaStreamAudioDestinationNode` (recording tap) created once
  alongside the source. Recording feeds MediaRecorder from `streamDest.stream` — do NOT
  create a second `MediaElementAudioSourceNode`.
- **Rule:** every time the analyser is rebuilt you call `source.disconnect()` (no args),
  which drops the streamDest connection too. You MUST re-run `source.connect(streamDest)`
  after re-wiring the analyser, or recordings lose audio after any analyser rebuild.
- **Rule:** `MediaRecorder` startup is async (`ctx.resume()`, `audio.play()`), and the
  status only flips to "recording" after it completes. A status-only guard is race-prone —
  a rapid double-click creates two recorders/streams. Use a **synchronous in-flight lock
  ref** set at `start()` entry (plus a monotonic run-id to fence late `onstop`/`onerror`
  callbacks from a superseded/cleared run).
- On stop/clear/unmount, stop the *canvas* `captureStream` tracks but NEVER stop the
  persistent streamDest audio track or close the ctx — they must survive for the next
  recording. Detach recorder handlers before a defensive `stop()` in clear() so a late
  `onstop` can't resurrect cleared state.
