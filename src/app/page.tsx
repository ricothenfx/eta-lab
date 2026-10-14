'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapView, type MapViewHandle, type CourierSelection } from '@/components/MapView';
import ThemeToggle from '@/components/ThemeToggle';
import { OsrmProvider, loadRecordedData, localStorageStore } from '@/lib/osrm';
import { generateScenario, PRESETS, type PresetKey, type Scenario } from '@/lib/scenario';
import { courierJobs, runSimulation, type Mode, type SimResult } from '@/lib/sim';
import { compareMetrics, computeMetrics, type Metrics } from '@/lib/metrics';

interface RunResult {
  result: SimResult;
  metrics: Metrics;
}

const SPEEDS = [10, 30, 90, 180];

const METRIC_TIPS: Record<string, string> = {
  'Pickup wait p50': 'Median minutes from order placed to courier pickup — half of all orders were picked up faster than this.',
  'Pickup wait p95': 'The slowest 5% of pickups took longer than this many minutes — the worst-wait tail.',
  'Delivery p50': 'Median door-to-door time in minutes from order placed to food delivered.',
  'Delivery p95': '95% of orders arrived within this many minutes — the worst-case tail.',
  'ETA error (MAE)': 'Mean gap in minutes between the promised ETA and the actual arrival. Lower = more honest promises to customers.',
  'Orders late vs promise': 'Share of orders that arrived after the promised ETA.',
  'Deadhead km / order': 'Empty kilometres ridden per order just to reach the restaurant (no food, no customer aboard). Lower = less wasted driving.',
};
const DELTA_TIP =
  'Percent change AFTER vs BEFORE. Green = improvement, red = regression — every metric here is better when lower.';
const BEFORE_TIP =
  'Naive dispatch baseline: nearest idle courier by crow-flies line, FIFO wait when all are busy, and an ETA promised from straight lines at a flat 25 km/h + 10 min prep guess.';
const AFTER_TIP =
  'Smart dispatch: courier chosen by real road travel time (busy couriers count too — soonest arrival wins), with an ETA built from road legs, kitchen prep mean and a small buffer.';
const SEED_TIP =
  'Same seed + same preset always generate the exact same orders, couriers and noise — every run is bit-for-bit reproducible.';
const RESULTS_SEED_TIP =
  'Every number in this table is reproducible: re-run with this seed and preset and you get identical results.';
const CLOCK_TIP =
  'Virtual time of day in the replay. The rush starts at 18:00 and playback runs faster than real time — see the ×speed selector.';
const SPEED_TIP =
  'Replay speed: simulated rush-minutes per real minute (×30 = the 90-minute rush in 3 real minutes).';

export default function Home() {
  const [presetKey, setPresetKey] = useState<PresetKey>('rush');
  const [seed, setSeed] = useState(7);
  const [scenario, setScenario] = useState<Scenario | null>(() =>
    generateScenario({ seed: 7, ...PRESETS.rush }),
  );
  const [view, setView] = useState<'before' | 'after' | 'both'>('before');
  const [results, setResults] = useState<Partial<Record<Mode, RunResult>>>({});
  const [resultsSig, setResultsSig] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [time, setTime] = useState(0);
  const [courierSel, setCourierSel] = useState<CourierSelection | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const providerRef = useRef<OsrmProvider | null>(null);
  const beforeMapRef = useRef<MapViewHandle>(null);
  const afterMapRef = useRef<MapViewHandle>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const timeRef = useRef(0);

  const setVirtualTime = useCallback((t: number) => {
    timeRef.current = t;
    setTime(t);
    beforeMapRef.current?.setTime(t);
    afterMapRef.current?.setTime(t);
  }, []);

  const before = results.before;
  const after = results.after;
  const activeResults = useMemo(() => {
    if (view === 'before') return before ? [before] : [];
    if (view === 'after') return after ? [after] : [];
    return [before, after].filter((r): r is RunResult => r != null);
  }, [view, before, after]);
  const simEndMin = activeResults.length
    ? Math.max(...activeResults.map((r) => r.result.simEndMin))
    : 0;

  // animation loop
  useEffect(() => {
    if (!playing || !activeResults.length) return;
    const simEnd = simEndMin;
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
  }, [playing, speed, activeResults, simEndMin, setVirtualTime]);

  // In BOTH view, pan/zoom on one map is mirrored onto the other so the
  // comparison stays apple-to-apple.
  useEffect(() => {
    if (view !== 'both') return;
    const a = beforeMapRef.current?.getMap();
    const b = afterMapRef.current?.getMap();
    if (!a || !b) return;
    let locked = false;
    const wire = (src: MapLibreMap, dst: MapLibreMap) => () => {
      if (locked) return;
      locked = true;
      dst.jumpTo({
        center: src.getCenter(),
        zoom: src.getZoom(),
        bearing: src.getBearing(),
        pitch: src.getPitch(),
      });
      locked = false;
    };
    const aToB = wire(a, b);
    const bToA = wire(b, a);
    a.on('move', aToB);
    b.on('move', bToA);
    return () => {
      a.off('move', aToB);
      b.off('move', bToA);
    };
  }, [view, before, after]);

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
    setCourierSel(null);
    setView('before');
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
      setView('both');
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
    setCourierSel(null);
    setVirtualTime(0);
    setView('before');
  }, [setVirtualTime]);

  const deltas = useMemo(
    () => (before && after ? compareMetrics(before.metrics, after.metrics) : []),
    [before, after],
  );
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

  const clockLabel = useMemo(
    () => (scenario ? fmtClock(scenario.startMin, time) : ''),
    [scenario, time],
  );

  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-4 py-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">
            eta-lab{' '}
            <span
              className={`ml-1 rounded px-2 py-0.5 text-xs font-bold text-white ${
                view === 'both'
                  ? 'bg-gradient-to-r from-[var(--before)] to-[var(--after)]'
                  : view === 'before'
                    ? 'bg-[var(--before)]'
                    : 'bg-[var(--after)]'
              }`}
            >
              {view === 'both' ? 'BEFORE vs AFTER' : view === 'before' ? 'BEFORE — naive' : 'AFTER — smart'}
            </span>
          </h1>
          <p className="text-xs text-[var(--muted)]">
            Courier dispatch &amp; ETA on real Berlin roads (OSRM) — every number reproducible
          </p>
        </div>
        <nav className="flex items-center gap-3 text-xs">
          {degraded && (
            <span className="rounded bg-[var(--warn-bg)] px-2 py-1 text-[var(--warn-ink)]">
              offline mode — recorded/estimated routes
            </span>
          )}
          <Link className="text-[var(--accent)] underline" href="/qa">
            Q&amp;A
          </Link>
          <Link className="text-[var(--accent)] underline" href="/methodology">
            Methodology
          </Link>
          <a className="text-[var(--accent)] underline" href="https://github.com/ricothenfx/eta-lab" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <ThemeToggle />
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        {view === 'both' ? (
          <>
            <MapView
              ref={beforeMapRef}
              scenario={scenario}
              result={before?.result ?? null}
              mode="before"
              time={time}
              selection={courierSel}
              onSelectCourier={setCourierSel}
              className="min-h-0 flex-1"
            />
            <div
              aria-hidden
              className="w-1 shrink-0 bg-gradient-to-b from-[var(--before)] to-[var(--after)]"
            />
            <MapView
              ref={afterMapRef}
              scenario={scenario}
              result={after?.result ?? null}
              mode="after"
              time={time}
              selection={courierSel}
              onSelectCourier={setCourierSel}
            />
          </>
        ) : (
          <MapView
            ref={view === 'before' ? beforeMapRef : afterMapRef}
            scenario={scenario}
            result={(view === 'before' ? before : after)?.result ?? null}
            mode={view}
            time={time}
            selection={courierSel}
            onSelectCourier={setCourierSel}
          />
        )}

        <aside className="flex w-[350px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--line)] bg-[var(--panel)] p-3 text-[13px]">
          {/* scenario */}
          <section className="rounded-lg border border-[var(--line)] p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Scenario — Berlin dinner rush</h2>
            <label className="mb-2 block">
              <span className="text-[var(--muted)]">Demand</span>
              <select
                className="mt-1 w-full rounded border border-[var(--line)] bg-[var(--panel)] px-2 py-1"
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
                <span className="tip tip-b tip-l text-[var(--muted)]" tabIndex={0} data-tip={SEED_TIP}>Seed (deterministic)</span>
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
                className="mt-4 rounded border border-[var(--line)] px-2 py-1 hover:bg-[var(--hover)]"
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
              className="w-full rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50"
              onClick={runComparison}
              disabled={running || !scenario}
            >
              {running ? 'Running…' : before && after ? 'Re-run comparison' : 'Run BEFORE vs AFTER'}
            </button>
            {progress && <p className="mt-2 text-xs text-[var(--muted)]">{progress}</p>}
            {dirty && !running && (
              <p className="mt-2 text-xs text-[var(--warn-ink)]">Scenario changed — re-run to refresh numbers.</p>
            )}
          </section>

          {/* playback */}
          {activeResults.length > 0 && (
            <section className="rounded-lg border border-[var(--line)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Replay</h2>
                <span className="font-mono text-sm">
                  <span className="tip tip-r" tabIndex={0} data-tip={CLOCK_TIP}>{clockLabel}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded border border-[var(--line)] px-3 py-1 hover:bg-[var(--hover)]"
                  onClick={() => setPlaying((p) => !p)}
                >
                  {playing ? '⏸ Pause' : '▶ Play'}
                </button>
                <button
                  className="rounded border border-[var(--line)] px-3 py-1 hover:bg-[var(--hover)]"
                  onClick={() => {
                    setPlaying(false);
                    setVirtualTime(0);
                  }}
                >
                  ⏮
                </button>
                <span className="tip tip-r ml-auto" tabIndex={0} data-tip={SPEED_TIP}>
                  <select
                    className="rounded border border-[var(--line)] px-1 py-1"
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                  >
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        ×{s}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
              <input
                type="range"
                className="mt-2 w-full"
                min={0}
                max={simEndMin}
                step={0.1}
                value={time}
                onChange={(e) => {
                  setPlaying(false);
                  setVirtualTime(Number(e.target.value));
                }}
              />
              <div className="mt-1 flex gap-2 text-xs text-[var(--muted)]">
                <ViewTab v="before" view={view} setView={setView} label="BEFORE" />
                <ViewTab v="both" view={view} setView={setView} label="BOTH" />
                <ViewTab v="after" view={view} setView={setView} label="AFTER" />
              </div>
            </section>
          )}

          {/* courier activity */}
          {courierSel && scenario && <CourierPanel sel={courierSel} scenario={scenario} before={before} after={after} time={time} onClear={() => setCourierSel(null)} />}

          {/* numbers */}
          {before && after && (
            <section className="rounded-lg border border-[var(--line)] p-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                Results —{' '}
                <span className="tip tip-l" tabIndex={0} data-tip={RESULTS_SEED_TIP}>seed {scenario?.seed}</span>
              </h2>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--muted)]">
                    <th className="py-1">metric</th>
                    <th className="py-1 text-right text-[var(--before)]">
                      <span className="tip" tabIndex={0} data-tip={BEFORE_TIP}>BEFORE</span>
                    </th>
                    <th className="py-1 text-right text-[var(--after)]">
                      <span className="tip tip-r" tabIndex={0} data-tip={AFTER_TIP}>AFTER</span>
                    </th>
                    <th className="py-1 text-right">
                      <span className="tip tip-r" tabIndex={0} data-tip={DELTA_TIP}>Δ</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {deltas.map((d) => (
                    <tr key={d.label} className="border-t border-[var(--line)]">
                      <td className="py-1">
                        <span className="tip tip-l" tabIndex={0} data-tip={METRIC_TIPS[d.label] ?? ''}>{d.label}</span>
                      </td>
                      <td className="py-1 text-right font-mono">
                        <span className="tip" tabIndex={0} data-tip={METRIC_TIPS[d.label] ?? ''}>{d.before.toFixed(1)}</span>
                      </td>
                      <td className="py-1 text-right font-mono">
                        <span className="tip tip-r" tabIndex={0} data-tip={METRIC_TIPS[d.label] ?? ''}>{d.after.toFixed(1)}</span>
                      </td>
                      <td className={`py-1 text-right font-mono font-semibold ${isBetter(d) ? 'text-[var(--after)]' : 'text-[var(--before)]'}`}>
                        <span className="tip tip-r" tabIndex={0} data-tip={DELTA_TIP}>
                          {d.pct > 0 ? '+' : ''}
                          {d.pct.toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex gap-2">
                <button className="flex-1 rounded border border-[var(--line)] px-2 py-1 hover:bg-[var(--hover)]" onClick={exportJson}>
                  Export JSON
                </button>
                <button
                  className="flex-1 rounded border border-[var(--line)] px-2 py-1 hover:bg-[var(--hover)] disabled:opacity-50"
                  onClick={explainWithAi}
                  disabled={aiBusy}
                >
                  {aiBusy ? 'Thinking…' : '✨ Explain with AI'}
                </button>
              </div>
              {aiText && (
                <p className="mt-2 whitespace-pre-wrap rounded bg-[var(--accent-soft)] p-2 text-xs leading-relaxed">{aiText}</p>
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

function fmtClock(startMin: number, tMin: number): string {
  const total = Math.round(startMin + tMin);
  const hh = (18 + Math.floor(total / 60)) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function CourierPanel({
  sel,
  scenario,
  before,
  after,
  time,
  onClear,
}: {
  sel: CourierSelection;
  scenario: Scenario;
  before?: RunResult;
  after?: RunResult;
  time: number;
  onClear: () => void;
}) {
  const run = sel.mode === 'before' ? before : after;
  const jobs = run ? courierJobs(run.result.records, sel.courierId) : [];
  const segs = run?.result.trails.get(sel.courierId) ?? [];

  let status = '';
  if (!run) {
    status = 'Run the comparison to see this courier’s jobs.';
  } else {
    const active = segs.find((s) => time >= s.t0 && time <= s.t1);
    const next = segs.find((s) => s.t0 > time);
    const done = segs.length > 0 && time > segs[segs.length - 1].t1;
    if (active)
      status =
        active.kind === 'pickup'
          ? `Riding to ${scenario.orders[active.orderId].resto.name} for order #${active.orderId}`
          : `Delivering order #${active.orderId} to the customer`;
    else if (!segs.length) status = 'Idle at hotspot — waiting for first dispatch';
    else if (next)
      status =
        next.kind === 'pickup'
          ? `Idle — order #${next.orderId} dispatches at ${fmtClock(scenario.startMin, next.t0)}`
          : `Waiting at the restaurant for order #${next.orderId}`;
    else if (done) status = 'Shift complete — idle at the last customer';
  }

  return (
    <section className="rounded-lg border border-[var(--line)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Courier #{sel.courierId}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold text-white ${
              sel.mode === 'before' ? 'bg-[var(--before)]' : 'bg-[var(--after)]'
            }`}
          >
            {sel.mode === 'before' ? 'BEFORE' : 'AFTER'}
          </span>
        </h2>
        <button
          className="rounded px-1.5 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--hover)]"
          title="Deselect courier"
          onClick={onClear}
        >
          ✕
        </button>
      </div>
      {status && <p className="mb-2 text-xs">{status}</p>}
      {run && jobs.length === 0 && <p className="text-xs text-[var(--muted)]">No jobs assigned in this run.</p>}
      {jobs.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {jobs.map((r) => {
            const st =
              time >= r.tDeliver ? 'delivered' : time >= r.tPickup ? 'on the way' : time >= r.tDispatch ? 'to pickup' : 'queued';
            const isNow = time >= r.tDispatch && time < r.tDeliver;
            return (
              <li
                key={r.id}
                className={`rounded border px-2 py-1 ${isNow ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--line)]'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Order #{r.id}</span>
                  <span className={`text-[11px] ${st === 'delivered' ? 'text-[var(--muted)]' : 'font-semibold text-[var(--accent)]'}`}>
                    {st}
                  </span>
                </div>
                <div className="text-[11px] text-[var(--muted)]">
                  {scenario.orders[r.id].resto.name} · {fmtClock(scenario.startMin, r.tPickup)} →{' '}
                  {fmtClock(scenario.startMin, r.tDeliver)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">
        Solid trail = ridden · dashed = planned. Click the courier again or the map background to deselect.
      </p>
    </section>
  );
}

function ViewTab({
  v,
  view,
  setView,
  label,
}: {
  v: 'before' | 'after' | 'both';
  view: 'before' | 'after' | 'both';
  setView: (v: 'before' | 'after' | 'both') => void;
  label: string;
}) {
  return (
    <button
      className={`rounded px-2 py-0.5 font-semibold ${view === v ? 'bg-[var(--ink)] text-[var(--panel)]' : 'bg-[var(--chip)] text-[var(--muted)] hover:bg-[var(--hover)]'}`}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  );
}
