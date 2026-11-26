import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { CipherScene3D, type CameraMode } from './scene/CipherScene3D';
import {
  DURATION,
  SCENES,
  STEPS,
  evaluateSimulationSnapshot,
  type SimulationSnapshot,
} from './simulation/cipherSimulation';

const SPEEDS = [0.5, 1, 1.5] as const;

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<CipherScene3D | null>(null);

  const [snapshot, setSnapshot] = useState<SimulationSnapshot>(() =>
    evaluateSimulationSnapshot(0)
  );
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const [cameraMode, setCameraMode] = useState<CameraMode>('auto');
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  useEffect(() => {
    const mount = canvasMountRef.current;
    if (!mount) return;

    const controller = new CipherScene3D(mount, {
      onSnapshot: (nextSnap, playing) => {
        setSnapshot(nextSnap);
        setIsPlaying(playing);
      },
      onCameraModeChange: (mode) => {
        setCameraMode(mode);
      },
      onContextLost: (lost) => {
        setContextLost(lost);
      },
    });
    sceneRef.current = controller;

    return () => {
      controller.dispose();
      sceneRef.current = null;
    };
  }, []);

  const handleTogglePlay = useCallback(() => {
    sceneRef.current?.togglePlay();
  }, []);

  const handleReplay = useCallback(() => {
    sceneRef.current?.replay();
  }, []);

  const handleSeek = useCallback((timeSeconds: number, pause = true) => {
    sceneRef.current?.seek(timeSeconds, pause);
  }, []);

  const handleStepBit = useCallback((delta: -1 | 1) => {
    const currentIdx = snapshot.latestArrivedIdx;
    const targetIdx = Math.max(0, Math.min(STEPS.length - 1, currentIdx + delta));
    const targetTime = Math.min(DURATION, STEPS[targetIdx].arrive + 0.08);
    sceneRef.current?.seek(targetTime, true);
  }, [snapshot.latestArrivedIdx]);

  const handleSpeedChange = useCallback((nextSpeed: number) => {
    setSpeed(nextSpeed);
    sceneRef.current?.setSpeed(nextSpeed);
  }, []);

  const handleCameraMode = useCallback((mode: CameraMode) => {
    setCameraMode(mode);
    sceneRef.current?.setCameraMode(mode);
  }, []);

  // Keyboard shortcuts: Space (Play/Pause), R (Replay), H (Hide/Show Dock), Left/Right (Step Bit)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        handleReplay();
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setDockCollapsed((prev) => !prev);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        handleStepBit(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        handleStepBit(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleReplay, handleStepBit, handleTogglePlay]);

  const progressPct = (snapshot.time / DURATION) * 100;
  const dStep = snapshot.displayStep;
  const isDesynced = snapshot.syncKind === 'desynced';
  const isRestoredOrFlushed =
    snapshot.syncKind === 'flushed' || snapshot.syncKind === 'restored';

  const statusBorderClass = isDesynced
    ? 'border-red-500/55'
    : isRestoredOrFlushed
      ? 'border-emerald-400/55'
      : 'border-sky-400/40';

  const statusTextClass = isDesynced
    ? 'text-red-400'
    : isRestoredOrFlushed
      ? 'text-emerald-400'
      : 'text-sky-300';

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#080d18] text-slate-100 select-none">
      {/* Isolated WebGL Canvas Mount */}
      <div
        ref={canvasMountRef}
        className="fixed inset-0 w-full h-full cursor-grab active:cursor-grabbing"
        aria-label="Interactive 3D Self-Synchronizing Stream Cipher Visualization"
      />

      {/* Graceful WebGL Context Loss Fallback */}
      {contextLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#080d18]/95 p-6">
          <div className="max-w-md border border-slate-700 bg-[#0d1526] p-6 text-center rounded-xl">
            <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
            <h2 className="text-base font-semibold text-slate-100">
              WebGL Rendering Context Paused
            </h2>
            <p className="text-sm text-slate-400 mt-2">
              The browser suspended the 3D graphics context. Reload to restore the interactive
              stream cipher animation.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap"
            >
              Reload Scene
            </button>
          </div>
        </div>
      )}

      {/* Top Minimal Unobstructive HUD Bar */}
      <header className="fixed top-3 left-3 right-3 z-20 pointer-events-none flex flex-wrap lg:flex-nowrap items-start justify-between gap-3">
        {/* Top-Left: Clean Title & Cipher Rule */}
        <div className="pointer-events-auto bg-[#0b1221]/92 border border-slate-800 rounded-xl px-4 py-2.5 max-w-[330px]">
          <h1 className="text-sm font-bold tracking-tight text-slate-50 leading-snug">
            Self-Synchronizing Stream Cipher
          </h1>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400 font-mono-tabular">
            <span>z = f(K, R) = R₀⊕R₁⊕R₂⊕R₃⊕1</span>
            <span aria-hidden="true">·</span>
            <span>IV 1010</span>
          </div>
        </div>

        {/* Top-Center: Active Scene & Dual-Coded Synchronization State */}
        <div
          className={`pointer-events-auto bg-[#0b1221]/94 border ${statusBorderClass} rounded-xl px-4 py-2.5 text-center min-w-[300px] max-w-[460px] flex-1 transition-colors duration-200`}
        >
          <div className="flex items-center justify-center gap-2 text-[11px] font-medium text-slate-400">
            <span>{snapshot.sceneMeta.title}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">{snapshot.sceneMeta.rangeLabel}</span>
          </div>
          <div
            className={`mt-1 flex items-center justify-center gap-2 text-sm font-bold tracking-wide ${statusTextClass}`}
          >
            {isDesynced ? (
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : snapshot.syncKind === 'flushed' ? (
              <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span>{snapshot.syncHeading}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-300 leading-snug truncate">
            {snapshot.syncSubtitle}
          </p>
        </div>

        {/* Top-Right: Compact Live Cryptographic State Comparison */}
        <div className="pointer-events-auto hidden md:block bg-[#0b1221]/92 border border-slate-800 rounded-xl px-3.5 py-2.5 min-w-[265px] text-[11px]">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-center">
            <span className="text-slate-400">Channel</span>
            <span
              className={`font-mono-tabular font-semibold text-right ${
                dStep.isCorruptBit ? 'text-red-400' : 'text-sky-300'
              }`}
            >
              Tx {dStep.cTx} → Rx {dStep.cRx}
              {dStep.isCorruptBit ? ' FLIPPED' : ''}
            </span>

            <span className="text-slate-400">Keystream z</span>
            <span
              className={`font-mono-tabular font-semibold text-right ${
                dStep.keyMatch ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              S:{dStep.zS} · R:{dStep.zR} {dStep.keyMatch ? 'MATCH' : 'DIFF'}
            </span>

            <span className="text-slate-400">Plaintext p</span>
            <span
              className={`font-mono-tabular font-semibold text-right ${
                dStep.decCorrect ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              Sent {dStep.p} · Dec {dStep.pDec} {dStep.decCorrect ? '✓' : '✗'}
            </span>

            <span className="text-slate-400 pt-0.5 border-t border-slate-800/80">Registers</span>
            <div className="pt-0.5 border-t border-slate-800/80 flex items-center justify-end gap-2 font-mono-tabular font-semibold">
              <span className="text-sky-300">S[{snapshot.activeSReg.join('')}]</span>
              <span className="text-slate-500">/</span>
              <span className="inline-flex items-center">
                <span className="text-teal-300">R[</span>
                {snapshot.activeRReg.map((bit, idx) => (
                  <span
                    key={idx}
                    className={
                      snapshot.corruptPos === idx
                        ? 'text-red-400 underline decoration-red-400 underline-offset-2'
                        : snapshot.syncRestored
                          ? 'text-emerald-400'
                          : 'text-teal-300'
                    }
                  >
                    {bit}
                  </span>
                ))}
                <span className="text-teal-300">]</span>
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Collapsible Unified Bottom Control Dock */}
      <div
        className={`fixed bottom-3 left-1/2 z-20 w-[min(940px,calc(100vw-24px))] transition-transform duration-200 ease-out ${
          dockCollapsed
            ? '-translate-x-1/2 translate-y-[calc(100%-26px)]'
            : '-translate-x-1/2 translate-y-0'
        }`}
      >
        {/* Collapse / Expand Handle */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-[#0b1221]/95 border border-b-0 border-slate-800 rounded-t-lg transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-sky-400"
            aria-expanded={!dockCollapsed}
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Show Controls (H)</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Hide Controls (H)</span>
              </>
            )}
          </button>
        </div>

        {/* Main Dock Panel */}
        <div className="bg-[#0b1221]/95 border border-slate-800 rounded-xl px-4 py-3 flex flex-col gap-2.5 shadow-2xl">
          {/* Row 1: Transport, Bit Stepping, Speed, Camera Mode & Timestamp */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Transport Group */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleTogglePlay}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-sky-400 hover:bg-sky-300 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-sky-300"
              >
                {isPlaying ? (
                  <>
                    <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{snapshot.time >= DURATION - 0.01 ? 'Replay' : 'Play'}</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleReplay}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/70 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-sky-400"
                title="Replay from 0.0s (R)"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Replay</span>
              </button>

              <div className="h-4 w-px bg-slate-800 mx-0.5" aria-hidden="true" />

              <button
                type="button"
                onClick={() => handleStepBit(-1)}
                disabled={snapshot.latestArrivedIdx <= 0}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed bg-slate-800/70 hover:bg-slate-700/80 border border-slate-700/60 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-sky-400"
                title="Previous bit step (Left Arrow)"
              >
                <SkipBack className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Prev Bit</span>
              </button>

              <button
                type="button"
                onClick={() => handleStepBit(1)}
                disabled={snapshot.latestArrivedIdx >= STEPS.length - 1}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed bg-slate-800/70 hover:bg-slate-700/80 border border-slate-700/60 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-sky-400"
                title="Next bit step (Right Arrow)"
              >
                <span className="hidden sm:inline">Next Bit</span>
                <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Speed, Camera Mode & Time Readout */}
            <div className="flex items-center gap-2">
              {/* Speed Segmented Control */}
              <div
                className="inline-flex items-center p-0.5 bg-slate-900 border border-slate-800 rounded-lg"
                role="group"
                aria-label="Playback Speed"
              >
                {SPEEDS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => handleSpeedChange(sp)}
                    className={`px-2 py-1 text-[11px] font-mono-tabular font-semibold rounded-md transition-colors whitespace-nowrap ${
                      speed === sp
                        ? 'bg-slate-700 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {sp}×
                  </button>
                ))}
              </div>

              {/* Camera Mode Segmented Control */}
              <div
                className="inline-flex items-center p-0.5 bg-slate-900 border border-slate-800 rounded-lg"
                role="group"
                aria-label="Camera Mode"
              >
                <button
                  type="button"
                  onClick={() => handleCameraMode('auto')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    cameraMode === 'auto'
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Camera className="w-3 h-3" aria-hidden="true" />
                  <span>Auto Cam</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCameraMode('orbit')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    cameraMode === 'orbit'
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Orbit className="w-3 h-3" aria-hidden="true" />
                  <span>Free Orbit</span>
                </button>
              </div>

              <div className="font-mono-tabular text-xs font-semibold text-slate-200 min-w-[84px] text-right">
                {snapshot.time.toFixed(1)}s / {DURATION.toFixed(1)}s
              </div>
            </div>
          </div>

          {/* Row 2: Multi-Scene Proportional Timeline Scrubber */}
          <div className="relative pt-1">
            {/* Background colored scene bands */}
            <div className="pointer-events-none absolute top-[11px] left-0 right-0 h-1.5 rounded-full overflow-hidden flex bg-slate-800">
              <div className="w-[25%] bg-sky-500/35 border-r border-slate-950" />
              <div className="w-[20%] bg-red-500/45 border-r border-slate-950" />
              <div className="w-[35%] bg-amber-400/35 border-r border-slate-950" />
              <div className="w-[20%] bg-emerald-500/40" />
            </div>
            {/* Active progress fill */}
            <div
              className="pointer-events-none absolute top-[11px] left-0 h-1.5 rounded-full bg-sky-400/90"
              style={{ width: `${progressPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={DURATION}
              step={0.02}
              value={Number(snapshot.time.toFixed(2))}
              onChange={(e) => handleSeek(parseFloat(e.target.value), true)}
              aria-label="Animation timeline scrubber in seconds"
              className="cipher-scrubber relative z-10"
            />
          </div>

          {/* Row 3: Clickable Scene Jump Controls */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {SCENES.map((sc) => {
              const active = snapshot.sceneIdx === sc.id;
              return (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => handleSeek(sc.startTime + 0.05, false)}
                  className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11px] transition-colors border text-left whitespace-nowrap ${
                    active
                      ? sc.id === 1
                        ? 'bg-red-500/15 border-red-500/50 text-red-200 font-semibold'
                        : sc.id === 3
                          ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-200 font-semibold'
                          : 'bg-sky-500/15 border-sky-500/50 text-sky-200 font-semibold'
                      : 'bg-slate-900/70 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                  }`}
                >
                  <span className="truncate">
                    {sc.id + 1}. {sc.shortLabel}
                  </span>
                  <span className="font-mono-tabular text-[10px] opacity-80 shrink-0">
                    {sc.rangeLabel}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Row 4: Interactive 17-Bit Transmitted Stream Ribbon */}
          <div className="hidden sm:flex items-center gap-2 pt-1 border-t border-slate-800/80">
            <span className="text-[10px] font-medium text-slate-400 whitespace-nowrap shrink-0">
              Ciphertext Bits:
            </span>
            <div className="flex items-center gap-1 flex-1 overflow-x-auto">
              {STEPS.map((st) => {
                const arrived = snapshot.time >= st.arrive;
                const inFlight = snapshot.time >= st.launch && snapshot.time < st.arrive;
                const isCurrent = snapshot.displayStep.index === st.index;
                const showCorrupt = st.isCorruptBit && snapshot.time >= (st.launch + st.arrive) * 0.5;

                let cellStyle = 'bg-slate-900 text-slate-500 border-slate-800';
                if (showCorrupt) {
                  cellStyle = 'bg-red-950/90 text-red-300 border-red-500/70';
                } else if (arrived) {
                  cellStyle = st.decCorrect
                    ? st.index >= 13
                      ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/50'
                      : 'bg-sky-950/80 text-sky-200 border-sky-500/45'
                    : 'bg-amber-950/80 text-amber-300 border-amber-500/50';
                } else if (inFlight) {
                  cellStyle = 'bg-sky-900/70 text-white border-sky-400';
                }

                return (
                  <button
                    key={st.index}
                    type="button"
                    onClick={() => handleSeek(st.arrive + 0.05, true)}
                    title={`Bit ${st.index + 1} (${st.arrive.toFixed(1)}s): Tx ${st.cTx} → Rx ${st.cRx} · Plaintext ${st.p} → Dec ${st.pDec}`}
                    className={`h-6 min-w-[26px] flex-1 font-mono-tabular text-[11px] font-semibold rounded border transition-colors ${cellStyle} ${
                      isCurrent ? 'ring-1 ring-white/80' : ''
                    }`}
                  >
                    {showCorrupt ? `${st.cRx}!` : st.cTx}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
