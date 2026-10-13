'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type MapViewHandle } from '@/components/MapView';
import { OsrmProvider, loadRecordedData, localStorageStore } from '@/lib/osrm';
import { generateScenario, PRESETS, type PresetKey, type Scenario } from '@/lib/scenario';
import { runSimulation, type Mode, type SimResult } from '@/lib/sim';
import { compareMetrics, computeMetrics, type Metrics } from '@/lib/metrics';

interface RunResult {
  result: SimResult;
  metrics: Metrics;
}

const SPEEDS = [10, 30, 90, 180];

export default function Home() {
  const [presetKey, setPresetKey] = useState<PresetKey>('rush');
  const [seed, setSeed] = useState(7);
  const [scenario, setScenario] = useState<Scenario | null>(() =>
    generateScenario({ seed: 7, ...PRESETS.rush }),
  );
  const [mode, setMode] = useState<Mode>('before');
  const [results, setResults] = useState<Partial<Record<Mode, RunResult>>>({});
  const [resultsSig, setResultsSig] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [time, setTime] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const providerRef = useRef<OsrmProvider | null>(null);
  const mapRef = useRef<MapViewHandle>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const timeRef = useRef(0);

  const setVirtualTime = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
    mapRef.current?.setTime(t);
  }, []);

  // animation loop
  useEffect(() => {
    if (!playing || !results[mode]) return;
    const simEnd = results[mode]!.result.simEndMin;
    const step = (ts: number) => {
      if (lastTickRef.current == null) lastTickRef.current = ts;
      const dt = ((ts - lastTickRef.current) / 1000) * (speed / 60); // virtual min
      lastTickRef.current = ts;
      let t = timeRef.current + dt;
      if (t > simEnd) {
        t = simEnd;
        setPlaying(false);
      }
      setVirtualTime(t);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTickRef.current = null;
    };
  }, [playing, speed, mode, results, setVirtualTime]);

  const getProvider = useCallback(async () => {
    if (!providerRef.current) {
      const recorded = await loadRecordedData();
      providerRef.current = new OsrmProvider({
        storage: localStorageStore() ?? null,
        recorded,
        concurrency: 4,
      });
    }
    return providerRef.current;
  }, []);

  const runComparison = useCallback(async () => {
    if (running || !scenario) return;
    setRunning(true);
    setPlaying(false);
    setAiText(null);
    setResults({});
    setMode('before');
    setVirtualTime(0);
    try {
      const provider = await getProvider();
      const out: Partial<Record<Mode, RunResult>> = {};
      for (const m of ['before', 'after'] as const) {
        setProgress(
          m === 'before'
            ? 'Simulating naive dispatch (crow-flies)…'
            : 'Simulating smart dispatch (road network)…',
        );
        const result = await runSimulation(m, scenario, provider, (done, total) =>
          setProgress(`${m === 'before' ? 'BEFORE' : 'AFTER'}: ${done}/${total} orders routed`),
        );
        provider.persist();
        out[m] = { result, metrics: computeMetrics(result.records) };
        setResults({ ...out });
      }
      setResultsSig(`${scenario.seed}:${scenario.orderCount}`);
      setDegraded(provider.degraded);
      setProgress('Done — replay the rush on the map or compare the numbers.');
      setMode('after');
    } catch (e) {
      setProgress(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [running, scenario, getProvider, setVirtualTime]);

  const applyScenario = useCallback((p: PresetKey, s: number) => {
    setPresetKey(p);
    setSeed(s);
    const sc = generateScenario({ seed: s, ...PRESETS[p] });
    setScenario(sc);
    setResults({});
    setResultsSig(null);
    setPlaying(false);
    setProgress('');
    setAiText(null);
    setVirtualTime(0);
    setMode('before');
  }, [setVirtualTime]);

  const before = results.before;
  const after = results.after;
  const deltas = useMemo(
    () => (before && after ? compareMetrics(before.metrics, after.metrics) : []),
    [before, after],
  );
  const active = mode === 'before' ? before : after;
  const currentSig = scenario ? `${scenario.seed}:${scenario.orderCount}` : '';
  const dirty = Boolean(before && resultsSig && resultsSig !== currentSig);

  const exportJson = useCallback(() => {
    if (!before || !after || !scenario) return;
    const payload = {
      project: 'eta-lab',
      scenario: { seed: scenario.seed, preset: presetKey, orderCount: scenario.orderCount },
      generatedAt: new Date().toISOString(),
      before: { metrics: before.metrics, simEndMin: before.result.simEndMin, deadheadKm: before.result.totalDeadheadKm },
      after: { metrics: after.metrics, simEndMin: after.result.simEndMin, deadheadKm: after.result.totalDeadheadKm },
      deltas,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eta-lab-seed${scenario.seed}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [before, after, scenario, presetKey, deltas]);

  const explainWithAi = useCallback(async () => {
    if (!before || !after) return;
    setAiBusy(true);
    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          before: before.metrics,
          after: after.metrics,
          deltas,
          scenario: { seed: scenario?.seed, preset: presetKey, orderCount: scenario?.orderCount },
        }),
      });
      const json = (await res.json()) as { text?: string; error?: string };
      setAiText(res.ok ? json.text ?? null : `AI not available: ${json.error ?? res.status}`);
    } catch (e) {
      setAiText(`AI not available: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAiBusy(false);
    }
  }, [before, after, deltas, scenario, presetKey]);

  const clockLabel = useMemo(() => {
    if (!scenario) return '';
    const total = Math.round(scenario.startMin + time);
    const hh = (18 + Math.floor(total / 60)) % 24;
    const mm = total % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }, [scenario, time]);

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-4 py-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">
            eta-lab{' '}
            <span className={`ml-1 rounded px-2 py-0.5 text-xs font-bold text-white ${mode === 'before' ? 'bg-[var(--before)]' : 'bg-[var(--after)]'}`}>
              {mode === 'before' ? 'BEFORE — naive' : 'AFTER — smart'}
            </span>
          </h1>
          <p className="text-xs text-[var(--muted)]">
            Courier dispatch &amp; ETA on real Berlin roads (OSRM) — every number reproducible
          </p>
        </div>
        <nav className="flex items-center gap-3 text-xs">
          {degraded && (
            <span className="rounded bg-[#fdf1d6] px-2 py-1 text-[#8a6100]">
              offline mode — recorded/estimated routes
            </span>
          )}
          <a className="text-[var(--accent)] underline" href="/methodology">
            Methodology
          </a>
          <a className="text-[var(--accent)] underline" href="https://github.com/ricothenfx/eta-lab" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        <MapView ref={mapRef} scenario={scenario} result={active?.result ?? null} mode={mode} />

        <aside className="flex w-[350px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--line)] bg-[var(--panel)] p-3 text-[13px]">
          {/* scenario */}
          <section className="rounded-lg border border-[var(--line)] p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Scenario — Berlin dinner rush</h2>
            <label className="mb-2 block">
              <span className="text-[var(--muted)]">Demand</span>
              <select
                className="mt-1 w-full rounded border border-[var(--line)] bg-white px-2 py-1"
                value={presetKey}
                onChange={(e) => applyScenario(e.target.value as PresetKey, seed)}
                disabled={running}
              >
                {Object.entries(PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label} — {v.orderCount} orders / {v.courierCount} couriers
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="text-[var(--muted)]">Seed (deterministic)</span>
                <input
                  type="number"
                  className="mt-1 w-full rounded border border-[var(--line)] px-2 py-1"
                  value={seed}
                  min={1}
                  max={9999}
                  onChange={(e) => applyScenario(presetKey, Number(e.target.value) || 1)}
                  disabled={running}
                />
              </label>
              <button
                className="mt-4 rounded border border-[var(--line)] px-2 py-1 hover:bg-gray-50"
                title="random seed"
                onClick={() => applyScenario(presetKey, 1 + Math.floor(Math.random() * 9999))}
                disabled={running}
              >
                🎲
              </button>
            </div>
          </section>

          {/* run */}
          <section className="rounded-lg border border-[var(--line)] p-3">
            <button
              className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50"
              onClick={runComparison}
              disabled={running || !scenario}
            >
              {running ? 'Running…' : before && after ? 'Re-run comparison' : 'Run BEFORE vs AFTER'}
            </button>
            {progress && <p className="mt-2 text-xs text-[var(--muted)]">{progress}</p>}
            {dirty && !running && (
              <p className="mt-2 text-xs text-[#8a6100]">Scenario changed — re-run to refresh numbers.</p>
            )}
          </section>

          {/* playback */}
          {active && (
            <section className="rounded-lg border border-[var(--line)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Replay</h2>
                <span className="font-mono text-sm">{clockLabel}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded border border-[var(--line)] px-3 py-1 hover:bg-gray-50"
                  onClick={() => setPlaying((p) => !p)}
                >
                  {playing ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  className="rounded border border-[var(--line)] px-3 py-1 hover:bg-gray-50"
                  onClick={() => {
                    setPlaying(false);
                    setVirtualTime(0);
                  }}
                >
                  ⏮
                </button>
                <select
                  className="ml-auto rounded border border-[var(--line)] px-1 py-1"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      ×{s}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="range"
                className="mt-2 w-full"
                min={0}
                max={active.result.simEndMin}
                step={0.1}
                value={time}
                onChange={(e) => {
                  setPlaying(false);
                  setVirtualTime(Number(e.target.value));
                }}
              />
              <div className="mt-1 flex gap-3 text-xs text-[var(--muted)]">
                <ModeTab m="before" mode={mode} setMode={setMode} label="BEFORE" />
                <ModeTab m="after" mode={mode} setMode={setMode} label="AFTER" />
              </div>
            </section>
          )}

          {/* numbers */}
          {before && after && (
            <section className="rounded-lg border border-[var(--line)] p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Results — seed {scenario?.seed}
              </h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
                    <th className="py-1">metric</th>
                    <th className="py-1 text-right text-[var(--before)]">BEFORE</th>
                    <th className="py-1 text-right text-[var(--after)]">AFTER</th>
                    <th className="py-1 text-right">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {deltas.map((d) => (
                    <tr key={d.label} className="border-t border-[var(--line)]">
                      <td className="py-1">{d.label}</td>
                      <td className="py-1 text-right font-mono">{d.before.toFixed(1)}</td>
                      <td className="py-1 text-right font-mono">{d.after.toFixed(1)}</td>
                      <td className={`py-1 text-right font-mono font-semibold ${isBetter(d) ? 'text-[var(--after)]' : 'text-[var(--before)]'}`}>
                        {d.pct > 0 ? '+' : ''}
                        {d.pct.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex gap-2">
                <button className="flex-1 rounded border border-[var(--line)] px-2 py-1 hover:bg-gray-50" onClick={exportJson}>
                  Export JSON
                </button>
                <button
                  className="flex-1 rounded border border-[var(--line)] px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
                  onClick={explainWithAi}
                  disabled={aiBusy}
                >
                  {aiBusy ? 'Thinking…' : '✨ Explain with AI'}
                </button>
              </div>
              {aiText && (
                <p className="mt-2 whitespace-pre-wrap rounded bg-[#f2f5ff] p-2 text-xs leading-relaxed">{aiText}</p>
              )}
            </section>
          )}

          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            Road data © OpenStreetMap contributors · routing by OSRM · both modes drive the same
            real roads with the same seeded orders — only the dispatch rule and the ETA model differ.
          </p>
        </aside>
      </div>
    </main>
  );
}

function isBetter(d: { pct: number; betterIsLower: boolean }): boolean {
  return d.betterIsLower ? d.pct < 0 : d.pct > 0;
}

function ModeTab({
  m,
  mode,
  setMode,
  label,
}: {
  m: Mode;
  mode: Mode;
  setMode: (m: Mode) => void;
  label: string;
}) {
  return (
    <button
      className={`rounded px-2 py-0.5 font-semibold ${mode === m ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
      onClick={() => setMode(m)}
    >
      {label}
    </button>
  );
}
