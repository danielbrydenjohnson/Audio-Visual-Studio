import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AudioGraphHandle } from "@/hooks/useFrequencyAnalysis";

export type RecordingStatus = "idle" | "starting" | "recording" | "recorded" | "error";

export interface RecorderState {
  status:      RecordingStatus;
  elapsedMs:   number;
  videoUrl:    string | null;
  error:       string | null;
  /** True when a recording can be started (canvas + audio + browser support). */
  canRecord:   boolean;
  start:       () => void;
  stop:        () => void;
  clear:       () => void;
  download:    () => void;
}

export interface UseRecorderArgs {
  audioRef:         RefObject<HTMLAudioElement | null>;
  canvas:           HTMLCanvasElement | null;
  ensureAudioGraph: () => AudioGraphHandle | null;
  fileName:         string | null;
  /** Frames per second for canvas capture (e.g. 30 or 60). */
  frameRate:        number;
  /** Format label baked into the download filename, e.g. "1080p-landscape". */
  formatLabel:      string;
}

// Preferred WebM MIME types, most-capable first.
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const TIMER_INTERVAL_MS = 250; // ~4 updates/sec

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return ""; // let the browser choose its default
}

function mediaRecorderSupported(): boolean {
  return typeof MediaRecorder !== "undefined";
}

function captureStreamSupported(canvas: HTMLCanvasElement | null): boolean {
  return !!canvas && typeof canvas.captureStream === "function";
}

/** Build "<track-name>-visual-<format>.webm" from the file name + output format. */
function makeDownloadName(fileName: string | null, formatLabel: string): string {
  const base   = (fileName ?? "recording").replace(/\.[^/.]+$/, "");
  const suffix = formatLabel ? `-${formatLabel}` : "";
  return `${base || "recording"}-visual${suffix}.webm`;
}

/**
 * Browser-side recording of the live Three.js canvas + the playing audio into a
 * downloadable WebM, via canvas.captureStream() + Web Audio MediaStream tap +
 * MediaRecorder. No server, no FFmpeg, no storage.
 */
export function useRecorder({
  audioRef, canvas, ensureAudioGraph, fileName, frameRate, formatLabel,
}: UseRecorderArgs): RecorderState {
  const [status,    setStatus]    = useState<RecordingStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [videoUrl,  setVideoUrl]  = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

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
  canvasRef.current           = canvas;
  fileNameRef.current         = fileName;
  ensureAudioGraphRef.current = ensureAudioGraph;
  frameRateRef.current        = frameRate;
  formatLabelRef.current      = formatLabel;

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

    const canvasEl = canvasRef.current;
    const audio    = audioRef.current;

    if (!mediaRecorderSupported()) {
      fail("Recording isn't supported in this browser (MediaRecorder unavailable).");
      return;
    }
    if (!captureStreamSupported(canvasEl)) {
      fail("Canvas capture isn't supported in this browser.");
      return;
    }
    if (!audio) {
      fail("Load an audio file before recording.");
      return;
    }

    const graph = ensureAudioGraphRef.current();
    if (!graph) {
      fail("Audio isn't ready to record yet.");
      return;
    }

    const audioTracks = graph.stream.getAudioTracks();
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
        if (graph.ctx.state === "suspended") await graph.ctx.resume();

        // Superseded (e.g. cleared) during the await — abort quietly.
        if (!isCurrentRun()) { busyRef.current = false; return; }

        audio.currentTime = 0;

        const fps = frameRateRef.current > 0 ? frameRateRef.current : 60;
        const canvasStream = canvasEl!.captureStream(fps);
        const videoTracks  = canvasStream.getVideoTracks();
        if (videoTracks.length === 0) {
          canvasStream.getTracks().forEach(t => t.stop());
          fail("Couldn't capture the visual canvas.");
          return;
        }
        canvasStreamRef.current = canvasStream;

        const combined = new MediaStream([...videoTracks, ...audioTracks]);

        const mimeType = pickMimeType();
        let recorder: MediaRecorder;
        try {
          recorder = mimeType
            ? new MediaRecorder(combined, { mimeType })
            : new MediaRecorder(combined);
        } catch {
          stopCanvasTracks();
          fail("Recording failed to start (recorder could not be created).");
          return;
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
          const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
          if (blob.size === 0) {
            setError("The recorder stopped without producing any video data.");
            setStatus("error");
            return;
          }
          // Revoke a previous preview before replacing it.
          if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
          const url = URL.createObjectURL(blob);
          videoUrlRef.current = url;
          setVideoUrl(url);
          setStatus("recorded");
        };

        recorderRef.current = recorder;

        // Auto-stop when the track reaches its end — same path as manual Stop.
        const onEnded = () => stop();
        endedHandlerRef.current = onEnded;
        audio.addEventListener("ended", onEnded);

        try {
          await audio.play();
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
    setElapsedMs(0);
    setError(null);
    setStatus("idle");
  }, [clearTimer, detachEndedHandler, stopCanvasTracks]);

  const download = useCallback(() => {
    const url = videoUrlRef.current;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = makeDownloadName(fileNameRef.current, formatLabelRef.current);
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
    !!canvas && mediaRecorderSupported() && captureStreamSupported(canvas) && fileName !== null;

  return { status, elapsedMs, videoUrl, error, canRecord, start, stop, clear, download };
}
