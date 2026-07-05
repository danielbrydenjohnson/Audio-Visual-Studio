import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AudioGraphHandle } from "@/hooks/useFrequencyAnalysis";
import type { LiveRecordingAudio } from "@/hooks/useLiveInputAnalysis";
import type { AudioSourceMode } from "@/types/audioSource";
import {
  type OutputFormatId,
  type AspectRatioId,
  type ResolutionId,
  getOutputDimensions,
  getRecordingBitrate,
  pickMimeTypeForFormat,
  isFormatSupported,
  containerFromMime,
} from "@/types/output";

export type RecordingStatus = "idle" | "starting" | "recording" | "recorded" | "error";

/** Metadata describing a produced recording, derived from the REAL recorder output. */
export interface RecordedInfo {
  /** True container derived from the recorder's real MIME type. */
  container:   OutputFormatId;
  /** The exact MIME type MediaRecorder produced. */
  mimeType:    string;
  aspectRatio: AspectRatioId;
  resolution:  ResolutionId;
  width:       number;
  height:      number;
  frameRate:   number;
  /** The bitrate passed to the MediaRecorder constructor. */
  requestedVideoBps: number;
  /**
   * The actual bitrate the browser committed to, from recorder.videoBitsPerSecond.
   * May be 0 if the browser does not report it.
   */
  actualVideoBps: number;
}

export interface RecorderState {
  status:      RecordingStatus;
  elapsedMs:   number;
  videoUrl:    string | null;
  error:       string | null;
  /** True when a recording can be started (canvas + audio + browser support). */
  canRecord:   boolean;
  /** True when the SELECTED output format can be natively recorded in this browser. */
  formatSupported: boolean;
  /** Metadata about the last produced recording, or null before one exists. */
  recorded:    RecordedInfo | null;
  start:       () => void;
  stop:        () => void;
  clear:       () => void;
  download:    () => void;
}

export interface UseRecorderArgs {
  audioRef:         RefObject<HTMLAudioElement | null>;
  canvas:           HTMLCanvasElement | null;
  ensureAudioGraph: () => AudioGraphHandle | null;
  /** Active audio source mode — governs the recording audio path + start flow. */
  mode:             AudioSourceMode;
  /** Live-mode audio accessor: the active mic ctx + audio tracks, or null. */
  getLiveAudio?:    () => LiveRecordingAudio | null;
  /** True when live input is active (enables recording in live mode). */
  liveActive?:      boolean;
  fileName:         string | null;
  /** Frames per second for canvas capture (e.g. 30 or 60). */
  frameRate:        number;
  /** Format label baked into the download filename, e.g. "1080p-landscape". */
  formatLabel:      string;
  /** Selected recording container. MP4 requires native browser support. */
  format:           OutputFormatId;
  /** Selected aspect ratio — recorded into the file metadata for display. */
  aspectRatio:      AspectRatioId;
  /** Selected resolution — recorded into the file metadata for display. */
  resolution:       ResolutionId;
}

const TIMER_INTERVAL_MS = 250; // ~4 updates/sec

function mediaRecorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined";
}

function captureStreamSupported(canvas: HTMLCanvasElement | null): boolean {
  return !!canvas && typeof canvas.captureStream === "function";
}

/**
 * Build "<track-name>-visual-<format>.<ext>". The extension is derived from the
 * REAL recorder MIME type (via containerFromMime), never from the user's
 * selection — so the extension always matches the bytes inside the Blob.
 */
function makeDownloadName(fileName: string | null, formatLabel: string, ext: string): string {
  const base   = (fileName ?? "recording").replace(/\.[^/.]+$/, "");
  const suffix = formatLabel ? `-${formatLabel}` : "";
  return `${base || "recording"}-visual${suffix}.${ext}`;
}

/**
 * Browser-side recording of the live Three.js canvas + the playing audio into a
 * downloadable WebM, via canvas.captureStream() + Web Audio MediaStream tap +
 * MediaRecorder. No server, no FFmpeg, no storage.
 */
export function useRecorder({
  audioRef, canvas, ensureAudioGraph, mode, getLiveAudio, liveActive,
  fileName, frameRate, formatLabel,
  format, aspectRatio, resolution,
}: UseRecorderArgs): RecorderState {
  const [status,    setStatus]    = useState<RecordingStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [videoUrl,  setVideoUrl]  = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);
  const [recorded,  setRecorded]  = useState<RecordedInfo | null>(null);

  // Imperative handles — never trigger renders, safe to touch from callbacks.
  const recorderRef     = useRef<MediaRecorder | null>(null);
  const chunksRef       = useRef<Blob[]>([]);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const timerRef        = useRef<number | null>(null);
  const startTimeRef    = useRef(0);
  const videoUrlRef     = useRef<string | null>(null);
  const statusRef       = useRef<RecordingStatus>("idle");
  const endedHandlerRef = useRef<(() => void) | null>(null);
  // Synchronous in-flight lock: prevents a second start() from entering while
  // the async setup of the first is still running (status only flips later).
  const busyRef         = useRef(false);
  // Monotonic session id: fences late callbacks from a superseded recorder.
  const runIdRef        = useRef(0);

  // Keep refs in sync with state for use inside stable callbacks.
  videoUrlRef.current = videoUrl;
  statusRef.current   = status;

  // Latest args via refs so callbacks can stay stable.
  const canvasRef           = useRef(canvas);
  const fileNameRef         = useRef(fileName);
  const ensureAudioGraphRef = useRef(ensureAudioGraph);
  const frameRateRef        = useRef(frameRate);
  const formatLabelRef      = useRef(formatLabel);
  const formatRef           = useRef(format);
  const aspectRatioRef      = useRef(aspectRatio);
  const resolutionRef       = useRef(resolution);
  const modeRef             = useRef(mode);
  const getLiveAudioRef     = useRef(getLiveAudio);
  canvasRef.current           = canvas;
  fileNameRef.current         = fileName;
  ensureAudioGraphRef.current = ensureAudioGraph;
  frameRateRef.current        = frameRate;
  formatLabelRef.current      = formatLabel;
  formatRef.current           = format;
  aspectRatioRef.current      = aspectRatio;
  resolutionRef.current       = resolution;
  modeRef.current             = mode;
  getLiveAudioRef.current     = getLiveAudio;

  // Real MIME type the recorder produced + a metadata snapshot taken at start.
  const recordedMimeRef = useRef<string>("");
  const metaRef = useRef<{
    aspectRatio: AspectRatioId; resolution: ResolutionId;
    width: number; height: number; frameRate: number;
    requestedVideoBps: number; actualVideoBps: number;
  } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Stop the canvas capture tracks (NOT the persistent audio tap). */
  const stopCanvasTracks = useCallback(() => {
    if (canvasStreamRef.current) {
      for (const track of canvasStreamRef.current.getTracks()) track.stop();
      canvasStreamRef.current = null;
    }
  }, []);

  const detachEndedHandler = useCallback(() => {
    const audio = audioRef.current;
    if (audio && endedHandlerRef.current) {
      audio.removeEventListener("ended", endedHandlerRef.current);
    }
    endedHandlerRef.current = null;
  }, [audioRef]);

  const stop = useCallback(() => {
    if (statusRef.current !== "recording") return;
    clearTimer();
    detachEndedHandler();

    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch { /* onstop still fires / already stopped */ }
    }
    // Pause the audio (auto-stop path may already be at the end).
    const audio = audioRef.current;
    if (audio && !audio.paused) audio.pause();
  }, [audioRef, clearTimer, detachEndedHandler]);

  const startTimer = useCallback(() => {
    clearTimer();
    startTimeRef.current = performance.now();
    setElapsedMs(0);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startTimeRef.current);
    }, TIMER_INTERVAL_MS);
  }, [clearTimer]);

  const start = useCallback(() => {
    // Synchronous re-entry guard — blocks concurrent starts during async setup.
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setStatus("starting");

    const fail = (message: string) => {
      busyRef.current = false;
      setError(message);
      setStatus("error");
    };

    const canvasEl   = canvasRef.current;
    const audio      = audioRef.current;
    const activeMode = modeRef.current;

    if (!mediaRecorderSupported()) {
      fail("Recording isn't supported in this browser (MediaRecorder unavailable).");
      return;
    }
    if (!captureStreamSupported(canvasEl)) {
      fail("Canvas capture isn't supported in this browser.");
      return;
    }
    if (!isFormatSupported(formatRef.current)) {
      const alt = formatRef.current === "mp4" ? "WebM" : "MP4";
      fail(`Native ${formatRef.current.toUpperCase()} recording isn’t supported by this browser. Switch the output format to ${alt}.`);
      return;
    }

    // Acquire the recording audio (context + tracks) for the active source mode.
    // Uploaded: the WeakMap-guarded MediaElement graph. Live: the mic stream from
    // the live-input hook (same stream that feeds analysis — no second capture).
    let audioCtx:    AudioContext;
    let audioTracks: MediaStreamTrack[];
    if (activeMode === "live-input") {
      const live = getLiveAudioRef.current?.() ?? null;
      if (!live) {
        fail("Start Live Input before recording.");
        return;
      }
      audioCtx    = live.ctx;
      audioTracks = live.audioTracks;
    } else {
      if (!audio) {
        fail("Load an audio file before recording.");
        return;
      }
      const graph = ensureAudioGraphRef.current();
      if (!graph) {
        fail("Audio isn't ready to record yet.");
        return;
      }
      audioCtx    = graph.ctx;
      audioTracks = graph.stream.getAudioTracks();
    }
    if (audioTracks.length === 0) {
      fail("No audio recording track is available.");
      return;
    }

    // This start owns run id `myRun`; late callbacks from older runs are ignored.
    const myRun = ++runIdRef.current;

    // True while this run is still the active one (not superseded by clear()).
    const isCurrentRun = () => runIdRef.current === myRun;

    // Async setup: resume ctx → seek to 0 → capture → combine → recorder → play.
    void (async () => {
      try {
        if (audioCtx.state === "suspended") await audioCtx.resume();

        // Superseded (e.g. cleared) during the await — abort quietly.
        if (!isCurrentRun()) { busyRef.current = false; return; }

        // Uploaded track restarts from the beginning; live input has no timeline.
        if (activeMode === "uploaded-track") audio!.currentTime = 0;

        const fps = frameRateRef.current > 0 ? frameRateRef.current : 60;

        // Snapshot the output metadata for this recording. Output is locked while
        // recording, so these values can't change mid-capture.
        const dims = getOutputDimensions(aspectRatioRef.current, resolutionRef.current);
        const { videoBitsPerSecond: requestedBps, audioBitsPerSecond } =
          getRecordingBitrate(resolutionRef.current, fps);
        metaRef.current = {
          aspectRatio:       aspectRatioRef.current,
          resolution:        resolutionRef.current,
          width:             dims.width,
          height:            dims.height,
          frameRate:         fps,
          requestedVideoBps: requestedBps,
          actualVideoBps:    0, // filled in after recorder is constructed
        };

        const canvasStream = canvasEl!.captureStream(fps);
        const videoTracks  = canvasStream.getVideoTracks();
        if (videoTracks.length === 0) {
          canvasStream.getTracks().forEach(t => t.stop());
          fail("Couldn't capture the visual canvas.");
          return;
        }
        canvasStreamRef.current = canvasStream;

        const combined = new MediaStream([...videoTracks, ...audioTracks]);

        // Concrete, genuinely-supported MIME for the SELECTED format. Guarded
        // synchronously above; re-checked here. We never cross containers.
        const mimeType = pickMimeTypeForFormat(formatRef.current);
        if (!mimeType) {
          stopCanvasTracks();
          fail(`Native ${formatRef.current.toUpperCase()} recording isn’t supported by this browser.`);
          return;
        }
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(combined, {
            mimeType,
            videoBitsPerSecond: requestedBps,
            audioBitsPerSecond,
          });
        } catch {
          stopCanvasTracks();
          fail("Recording failed to start (recorder could not be created).");
          return;
        }
        // Read the actual bitrate the browser committed to (may differ from requested,
        // or be 0 if the browser doesn't report it).
        if (metaRef.current) {
          metaRef.current.actualVideoBps = recorder.videoBitsPerSecond;
        }

        chunksRef.current = [];

        recorder.ondataavailable = (e: BlobEvent) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.onerror = () => {
          if (!isCurrentRun()) return;
          busyRef.current = false;
          clearTimer();
          detachEndedHandler();
          stopCanvasTracks();
          setError("Recording failed.");
          setStatus("error");
        };

        recorder.onstop = () => {
          const chunks = chunksRef.current;
          chunksRef.current = [];
          stopCanvasTracks();

          // Superseded by clear()/newer run — discard without touching state.
          if (!isCurrentRun()) return;

          busyRef.current = false;
          if (chunks.length === 0) {
            setError("The recorder stopped without producing any video data.");
            setStatus("error");
            return;
          }
          // The REAL MIME type the recorder produced — the single source of truth
          // for the Blob type, the file extension and the displayed format.
          const realMime = recorder.mimeType || mimeType;
          const blob = new Blob(chunks, { type: realMime });
          if (blob.size === 0) {
            setError("The recorder stopped without producing any video data.");
            setStatus("error");
            return;
          }
          recordedMimeRef.current = realMime;
          // Revoke a previous preview before replacing it.
          if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
          const url = URL.createObjectURL(blob);
          videoUrlRef.current = url;
          setVideoUrl(url);
          const meta = metaRef.current;
          setRecorded({
            container:         containerFromMime(realMime),
            mimeType:          realMime,
            aspectRatio:       meta?.aspectRatio ?? aspectRatioRef.current,
            resolution:        meta?.resolution ?? resolutionRef.current,
            width:             meta?.width ?? 0,
            height:            meta?.height ?? 0,
            frameRate:         meta?.frameRate ?? frameRateRef.current,
            requestedVideoBps: meta?.requestedVideoBps ?? 0,
            actualVideoBps:    meta?.actualVideoBps ?? 0,
          });
          setStatus("recorded");
        };

        recorderRef.current = recorder;

        if (activeMode === "uploaded-track") {
          // Auto-stop when the track reaches its end — same path as manual Stop.
          const onEnded = () => stop();
          endedHandlerRef.current = onEnded;
          audio!.addEventListener("ended", onEnded);

          try {
            await audio!.play();
          } catch {
            detachEndedHandler();
            stopCanvasTracks();
            recorder.ondataavailable = null;
            recorder.onstop = null;
            recorder.onerror = null;
            recorderRef.current = null;
            fail("The browser blocked audio playback for the recording.");
            return;
          }

          if (!isCurrentRun()) { busyRef.current = false; return; }
        }
        // Live input has no seek/play and never auto-stops — it runs until the
        // user presses Stop (or the mic stream ends unexpectedly).

        recorder.start();
        startTimer();
        setStatus("recording");
      } catch {
        clearTimer();
        detachEndedHandler();
        stopCanvasTracks();
        fail("Recording failed to start.");
      }
    })();
  }, [audioRef, clearTimer, detachEndedHandler, startTimer, stop, stopCanvasTracks]);

  const clear = useCallback(() => {
    // Invalidate any pending recorder callbacks from the current/previous run.
    runIdRef.current++;
    busyRef.current = false;

    // Defensive: detach handlers first so a resulting onstop can't resurrect
    // state, then stop anything still running.
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try { recorder.stop(); } catch { /* ignore */ }
      }
    }
    recorderRef.current = null;
    clearTimer();
    detachEndedHandler();
    stopCanvasTracks();
    chunksRef.current = [];

    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }
    setVideoUrl(null);
    setRecorded(null);
    recordedMimeRef.current = "";
    setElapsedMs(0);
    setError(null);
    setStatus("idle");
  }, [clearTimer, detachEndedHandler, stopCanvasTracks]);

  const download = useCallback(() => {
    const url = videoUrlRef.current;
    if (!url) return;
    // Extension is derived from the REAL recorded MIME type, so it always matches
    // the Blob's contents (a WebM Blob is never handed a .mp4 name, or vice-versa).
    const ext = containerFromMime(recordedMimeRef.current || "video/webm");
    const a = document.createElement("a");
    a.href = url;
    a.download = makeDownloadName(fileNameRef.current, formatLabelRef.current, ext);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try { recorder.stop(); } catch { /* ignore */ }
      }
      recorderRef.current = null;
      if (timerRef.current !== null) clearInterval(timerRef.current);
      timerRef.current = null;
      const audio = audioRef.current;
      if (audio && endedHandlerRef.current) {
        audio.removeEventListener("ended", endedHandlerRef.current);
      }
      endedHandlerRef.current = null;
      if (canvasStreamRef.current) {
        for (const t of canvasStreamRef.current.getTracks()) t.stop();
        canvasStreamRef.current = null;
      }
      chunksRef.current = [];
      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRecord =
    !!canvas && mediaRecorderSupported() && captureStreamSupported(canvas) &&
    (mode === "live-input" ? !!liveActive : fileName !== null);
  const formatSupported = isFormatSupported(format);

  return {
    status, elapsedMs, videoUrl, error, canRecord, formatSupported, recorded,
    start, stop, clear, download,
  };
}
