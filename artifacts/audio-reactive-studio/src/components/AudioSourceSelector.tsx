import { type AudioSourceMode, AUDIO_SOURCE_OPTIONS } from "@/types/audioSource";

interface AudioSourceSelectorProps {
  value:     AudioSourceMode;
  disabled?: boolean;
  onChange:  (mode: AudioSourceMode) => void;
}

/**
 * Two-way segmented control choosing between an uploaded track and live
 * microphone input. Locked while recording so the source can't switch
 * mid-capture.
 */
export function AudioSourceSelector({ value, disabled = false, onChange }: AudioSourceSelectorProps) {
  return (
    <div className={`space-y-1.5 ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-muted-foreground">Audio Source</span>
        {disabled && (
          <span className="text-[9px] font-mono text-amber-400/80 uppercase tracking-wider">
            Locked while recording
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {AUDIO_SOURCE_OPTIONS.map(opt => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(opt.value)}
              className={`rounded-md border px-2 py-2 text-[11px] font-mono text-center transition-colors disabled:cursor-not-allowed ${
                selected
                  ? "border-primary/70 bg-primary/15 text-primary"
                  : "border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
