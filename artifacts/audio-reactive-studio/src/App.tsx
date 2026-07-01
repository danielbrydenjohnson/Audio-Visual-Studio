import { useState, useRef, useCallback, useEffect } from "react";
import { AudioUpload } from "@/components/AudioUpload";
import { AudioPlayer } from "@/components/AudioPlayer";

function App() {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Track the current object URL so we can revoke it when replaced or on unmount
  const currentUrlRef = useRef<string | null>(null);

  // Revoke the object URL when the component unmounts
  useEffect(() => {
    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, []);

  const handleFile = useCallback((file: File) => {
    // Revoke the previous object URL to avoid memory leaks
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    currentUrlRef.current = url;
    setAudioUrl(url);
    setFileName(file.name);
  }, []);

  const handleChangeFile = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
    setAudioUrl(null);
    setFileName(null);
  }, []);

  return (
    <div className="h-[100dvh] w-full bg-background text-foreground flex flex-col overflow-hidden font-sans selection:bg-primary/30">
      {/* Header */}
      <header className="h-14 border-b border-border/60 flex items-center px-6 shrink-0 bg-background z-20">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/50 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          </div>
          <h1 className="font-semibold text-sm tracking-wide text-foreground">
            Audio Reactive Studio
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Left column: preview + transport */}
        <section className="flex-1 flex flex-col bg-muted/10 p-6 gap-4 relative isolate overflow-hidden">
          {/* Subtle grid background */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] -z-10" />

          {/* Canvas preview — takes remaining space */}
          <div className="flex-1 border border-border/40 rounded-xl bg-black/40 shadow-2xl flex items-center justify-center relative overflow-hidden backdrop-blur-sm min-h-0">
            {/* Corner accents */}
            <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary/40 rounded-tl-lg" />
            <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary/40 rounded-tr-lg" />
            <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary/40 rounded-bl-lg" />
            <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary/40 rounded-br-lg" />

            <div className="flex flex-col items-center gap-3 opacity-60">
              <span className="text-muted-foreground font-mono text-sm uppercase tracking-[0.2em]">
                Canvas Preview
              </span>
              <span className="text-[10px] text-muted-foreground/60 font-mono">
                1920 × 1080
              </span>
            </div>
          </div>

          {/* Transport strip — fixed height below preview */}
          <div className="h-20 rounded-xl border border-border/40 bg-card/60 backdrop-blur-sm px-5 flex items-center shrink-0">
            {audioUrl && fileName ? (
              <AudioPlayer
                src={audioUrl}
                fileName={fileName}
                onChangeFile={handleChangeFile}
              />
            ) : (
              <AudioUpload onFile={handleFile} />
            )}
          </div>
        </section>

        {/* Controls Panel */}
        <aside className="w-[300px] border-l border-border/60 bg-card flex flex-col shrink-0 overflow-hidden relative z-10 shadow-xl">
          <div className="h-14 border-b border-border/60 flex items-center px-5 shrink-0 bg-card">
            <h2 className="font-medium text-[11px] tracking-[0.15em] uppercase text-muted-foreground">
              Controls
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-8">
            {/* Visualizer Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-primary/70 rounded-full" />
                <h3 className="text-sm font-medium text-foreground">Visualizer</h3>
              </div>
              <div className="h-28 rounded-lg border border-border/40 bg-muted/20 flex flex-col items-center justify-center gap-2">
                <div className="flex items-end gap-1 h-6">
                  <div className="w-1 h-3 bg-muted-foreground/30 rounded-full" />
                  <div className="w-1 h-5 bg-muted-foreground/30 rounded-full" />
                  <div className="w-1 h-2 bg-muted-foreground/30 rounded-full" />
                  <div className="w-1 h-6 bg-muted-foreground/30 rounded-full" />
                  <div className="w-1 h-4 bg-muted-foreground/30 rounded-full" />
                </div>
                <span className="text-[11px] text-muted-foreground font-medium">
                  Shape & Geometry
                </span>
              </div>
            </div>

            {/* Color Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-chart-2/70 rounded-full" />
                <h3 className="text-sm font-medium text-foreground">Color & Post</h3>
              </div>
              <div className="h-36 rounded-lg border border-border/40 bg-muted/20 flex flex-col items-center justify-center gap-2">
                <div className="flex gap-2">
                  <div className="w-4 h-4 rounded-full bg-chart-1 shadow-sm" />
                  <div className="w-4 h-4 rounded-full bg-chart-2 shadow-sm" />
                  <div className="w-4 h-4 rounded-full bg-chart-3 shadow-sm" />
                </div>
                <span className="text-[11px] text-muted-foreground font-medium mt-1">
                  Palette & Effects
                </span>
              </div>
            </div>

            {/* Output Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-1 h-3 bg-chart-3/70 rounded-full" />
                <h3 className="text-sm font-medium text-foreground">Output</h3>
              </div>
              <div className="h-20 rounded-lg border border-border/40 bg-muted/20 flex items-center justify-center">
                <span className="text-[11px] text-muted-foreground font-medium">
                  Resolution & Export
                </span>
              </div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
