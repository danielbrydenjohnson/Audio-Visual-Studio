import type { RecorderState } from "@/hooks/useRecorder";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const STATUS_LABEL: Record<RecorderState["status"], string> = {
  idle:      "Idle",
  starting:  "Starting…",
  recording: "Recording",
  recorded:  "Ready",
  error:     "Error",
};

interface RecordingPanelProps {
  recorder: RecorderState;
}

export function RecordingPanel({ recorder }: RecordingPanelProps) {
  const { status, elapsedMs, videoUrl, error, canRecord, start, stop, clear, download } = recorder;
  const isRecording = status === "recording";
  const isStarting = status === "starting";
  const hasRecording = status === "recorded" && videoUrl !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="w-1 h-3 bg-chart-3/70 rounded-full" />
        <h3 className="text-sm font-medium text-foreground">Output</h3>
      </div>

      {/* Status + timer */}
      <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${isRecording ? "bg-red-500 animate-pulse" : status === "recorded" ? "bg-emerald-500" : status === "error" ? "bg-amber-500" : "bg-muted-foreground/40"}`}
          />
          <span className="text-[11px] font-mono text-muted-foreground">
            {STATUS_LABEL[status]}
          </span>
        </div>
        <span className="text-[11px] font-mono tabular-nums text-foreground/70">
          {formatElapsed(elapsedMs)}
        </span>
      </div>

      {/* Start / Stop */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={start}
          disabled={!canRecord || isRecording || isStarting}
          className="flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] font-mono text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary/10"
          title={!canRecord ? "Load an audio file to enable recording" : "Start recording from the beginning"}
        >
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Start
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={!isRecording}
          className="flex items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] font-mono text-foreground/80 transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-muted/40"
        >
          <span className="w-2 h-2 rounded-sm bg-foreground/70" />
          Stop
        </button>
      </div>

      {/* Error */}
      {error && (
        <p className="text-[10px] font-mono leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-2">
          {error}
        </p>
      )}

      {/* Preview + download + clear */}
      {hasRecording && (
        <div className="space-y-3">
          <div className="rounded-md overflow-hidden border border-border/50 bg-black">
            <video
              src={videoUrl}
              controls
              className="w-full block"
              style={{ maxHeight: 180 }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={download}
              className="flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] font-mono text-primary transition-colors hover:bg-primary/20"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download
            </button>
            <button
              type="button"
              onClick={clear}
              className="flex items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] font-mono text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
