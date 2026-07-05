import type { LiveInputStatus, LiveInputDevice } from "@/hooks/useLiveInputAnalysis";

interface LiveInputPanelProps {
  status:           LiveInputStatus;
  error:            string | null;
  devices:          LiveInputDevice[];
  selectedDeviceId: string;
  isActive:         boolean;
  /** True while a recording is in progress — used to lock device selection. */
  recording:        boolean;
  onSelectDevice:   (id: string) => void;
  onStart:          () => void;
  onStop:           () => void;
}

const STATUS_TEXT: Record<LiveInputStatus, string> = {
  idle:       "Live input idle",
  requesting: "Requesting microphone…",
  active:     "Live input active",
  stopped:    "Live input stopped",
  error:      "Live input error",
};

export function LiveInputPanel({
  status, error, devices, selectedDeviceId, isActive, recording,
  onSelectDevice, onStart, onStop,
}: LiveInputPanelProps) {
  const requesting     = status === "requesting";
  const deviceDisabled = isActive || requesting || recording;
  const dotClass       = isActive
    ? "bg-red-500 animate-pulse"
    : status === "error"
      ? "bg-amber-500"
      : requesting
        ? "bg-primary animate-pulse"
        : "bg-muted-foreground/40";

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Status */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
        <span className="text-xs font-mono text-foreground/80 truncate">
          {STATUS_TEXT[status]}
        </span>
      </div>

      {/* Input device selector */}
      <div className="space-y-1.5">
        <span className="text-[11px] font-mono text-muted-foreground">Input Device</span>
        <select
          value={selectedDeviceId}
          disabled={deviceDisabled}
          onChange={e => onSelectDevice(e.target.value)}
          className="w-full text-[11px] font-mono bg-muted/40 border border-border/60
            rounded-md px-2.5 py-1.5 text-foreground cursor-pointer
            hover:border-border focus:outline-none focus:ring-1 focus:ring-primary/40
            appearance-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center" }}
          aria-label="Live input device"
        >
          <option value="">Default input</option>
          {devices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Start / Stop */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={isActive || requesting}
          className="flex items-center justify-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-[11px] font-mono text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-primary/10"
          title="Start capturing microphone / live audio input"
        >
          <span className="w-2 h-2 rounded-full bg-primary" />
          Start Input
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={!isActive}
          className="flex items-center justify-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] font-mono text-foreground/80 transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-muted/40"
          title={recording ? "Stops live input and the current recording" : "Stop live input and release the microphone"}
        >
          <span className="w-2 h-2 rounded-sm bg-foreground/70" />
          Stop Input
        </button>
      </div>

      {/* Permission / error area */}
      {error && (
        <p className="text-[10px] font-mono leading-relaxed text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-2.5 py-2">
          {error}
        </p>
      )}

      {/* Privacy note */}
      <p className="text-[10px] font-mono leading-relaxed text-muted-foreground/60">
        Live Input uses your browser microphone. Audio is analysed locally in real
        time — never uploaded or stored. Nothing is captured until you press Start
        Recording.
      </p>
    </div>
  );
}
