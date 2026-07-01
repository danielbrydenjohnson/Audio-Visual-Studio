import type { FrequencyBands } from "@/hooks/useFrequencyAnalysis";

interface MeterConfig {
  key: keyof FrequencyBands;
  label: string;
  range: string;
  colorClass: string;
}

const METERS: MeterConfig[] = [
  { key: "sub",  label: "Sub",  range: "20–80 Hz",   colorClass: "bg-chart-1" },
  { key: "low",  label: "Low",  range: "80–250 Hz",  colorClass: "bg-primary" },
  { key: "mid",  label: "Mid",  range: "250–4k Hz",  colorClass: "bg-chart-2" },
  { key: "high", label: "High", range: "4k–16k Hz",  colorClass: "bg-chart-3" },
];

interface FrequencyMetersProps {
  bands: FrequencyBands;
}

export function FrequencyMeters({ bands }: FrequencyMetersProps) {
  return (
    <div className="flex items-end gap-4 w-full">
      {METERS.map(({ key, label, range, colorClass }) => {
        const value = Math.round(bands[key]);
        return (
          <div key={key} className="flex flex-col items-center gap-1.5 flex-1">
            {/* Label */}
            <span className="text-[10px] font-mono font-medium text-foreground/70 uppercase tracking-wider">
              {label}
            </span>

            {/* Vertical bar track */}
            <div className="relative w-full h-10 bg-muted/30 rounded-sm overflow-hidden">
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-sm ${colorClass} opacity-80 transition-[height] duration-[60ms] ease-out`}
                style={{ height: `${value}%` }}
              />
            </div>

            {/* Numeric value */}
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground w-6 text-center">
              {value}
            </span>

            {/* Frequency range */}
            <span className="text-[9px] font-mono text-muted-foreground/50 whitespace-nowrap">
              {range}
            </span>
          </div>
        );
      })}
    </div>
  );
}
