---
name: MediaRecorder container/MIME correctness (MP4 vs WebM)
description: Picking a recording container safely with MediaRecorder — derive extension/blob type from the REAL mimeType, require an explicit isTypeSupported candidate per container, never cross containers.
---

# MediaRecorder container / MIME correctness

When letting the user choose an output container (e.g. MP4 vs WebM) for a
`MediaRecorder` canvas/stream recording:

- **Detect support per container** by probing an ordered list of concrete MIME
  candidates with `MediaRecorder.isTypeSupported(...)`. Require an EXPLICIT supported
  candidate for the chosen container; do NOT treat `""` / browser-default as support.
  Keep MP4 candidates and WebM candidates as separate ordered lists.
- **Never cross containers.** If the selected container has no supported candidate,
  block Start and offer a one-click switch to the other container — never silently
  record the other container.
- **Derive the Blob `type` AND the file extension from the REAL `recorder.mimeType`**
  (read after the recorder exists / in `onstop`), never from the user's selection. A
  browser may produce a different codec/container than requested; the extension must
  match the actual bytes. Renaming a WebM blob to `.mp4` yields a file that won't play.
- Centralize the MIME/format logic in ONE module shared by the UI (support status +
  disabling Start) and the recorder (actual capture) so the two never disagree.

**Why:** cross-container mislabeling (e.g. a `.mp4` name on WebM bytes) creates files
that silently fail to open; the ambiguous "browser default" MIME fallback leads
exactly to that hazard on some browsers (notably Safari).

**How to apply:** guard `start()` synchronously against an unsupported selected format,
re-check the resolved MIME immediately before constructing `MediaRecorder` (fail if
empty), and on stop build both the Blob type and the download extension from
`recorder.mimeType`. Snapshot display metadata (container/resolution/aspect/fps) at
start since output controls are locked during recording.
