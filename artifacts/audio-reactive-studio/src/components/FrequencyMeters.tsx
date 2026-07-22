import type { AnalysisFrame } from "@/lib/audioAnalysis";

interface MeterConfig {
  key: keyof AnalysisFrame;
  label: string;
  range: string;
  colorClass: string;
}

const METERS: MeterConfig[] = [
  { key: "low",  label: "Low",  range: "20–100 Hz",   colorClass: "bg-primary" },
  { key: "mid",  label: "Mid",  range: "350–4k Hz",   colorClass: "bg-chart-2" },
  { key: "high", label: "High", range: "4k–16k Hz",   colorClass: "bg-chart-3" },
];

interface FrequencyMetersProps {
  bands: AnalysisFrame;
}

/**
 * Per-band twin meters: LVL (sustained energy, band colour) and HIT (onset
 * envelope, white). The hit value is peak-held by the analysis hooks between
 * React emissions so even one-frame transients register as visible spikes.
 */
export function FrequencyMeters({ bands }: FrequencyMetersProps) {
  return (
    <div className="flex items-end gap-4 w-full">
      {METERS.map(({ key, label, range, colorClass }) => {
        const level = Math.round(bands[key].level);
        const hit   = Math.round(bands[key].hit);
        return (
          <div key={key} className="flex flex-col items-center gap-1.5 flex-1">
            <span className="text-[10px] font-mono font-medium text-foreground/70 uppercase tracking-wider">
              {label}
            </span>

            <div className="flex w-full gap-1">
              <div className="relative flex-1 h-10 bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className={`absolute bottom-0 left-0 right-0 rounded-sm ${colorClass} opacity-80 transition-[height] duration-[60ms] ease-out`}
                  style={{ height: `${level}%` }}
                />
              </div>
              <div className="relative flex-1 h-10 bg-muted/30 rounded-sm overflow-hidden">
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-sm bg-foreground opacity-90 transition-[height] duration-[40ms] ease-out"
                  style={{ height: `${hit}%` }}
                />
              </div>
            </div>

            <div className="flex w-full gap-1 text-[8px] font-mono text-muted-foreground/50 uppercase">
              <span className="flex-1 text-center">Lvl</span>
              <span className="flex-1 text-center">Hit</span>
            </div>

            <div className="flex w-full gap-1 text-[10px] font-mono tabular-nums">
              <span className="flex-1 text-center text-muted-foreground">{level}</span>
              <span className="flex-1 text-center text-foreground/80">{hit}</span>
            </div>

            <span className="text-[9px] font-mono text-muted-foreground/50 whitespace-nowrap">
              {range}
            </span>
          </div>
        );
      })}
    </div>
  );
}
