/**
 * Reproducible benchmark: BEFORE vs AFTER on identical seeded scenarios.
 *
 *   npm run bench                 — live OSRM, then writes a recorded snapshot
 *   npm run bench -- --recorded   — offline, uses public/data/recorded-routes.json
 *
 * Outputs: reports/bench-<date>.json, reports/bench-<date>.md and (when live)
 * public/data/recorded-routes.json.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { OsrmProvider, type RecordedData } from '../src/lib/osrm';
import { generateScenario, PRESETS } from '../src/lib/scenario';
import { runSimulation } from '../src/lib/sim';
import { computeMetrics, summarize, type BenchRun } from '../src/lib/metrics';

const ROOT = path.resolve(import.meta.dirname, '..');
const USE_RECORDED = process.argv.includes('--recorded');
const SEEDS = [7, 11, 42];
const PRESET_KEY = 'rush' as const;

const RECORDED_PATH = path.join(ROOT, 'public/data/recorded-routes.json');

function loadRecorded(): RecordedData | null {
  if (!USE_RECORDED) return null;
  if (!existsSync(RECORDED_PATH)) throw new Error('recorded snapshot missing — run `npm run bench` first');
  return JSON.parse(readFileSync(RECORDED_PATH, 'utf8')) as RecordedData;
}

async function main() {
  const recorded = loadRecorded();
  const provider = new OsrmProvider({
    concurrency: 4,
    recorded,
    storage: null,
  });
  const preset = PRESETS[PRESET_KEY];
  const runs: BenchRun[] = [];

  for (const seed of SEEDS) {
    const scenario = generateScenario({ seed, orderCount: preset.orderCount, courierCount: preset.courierCount });
    for (const mode of ['before', 'after'] as const) {
      const t0 = Date.now();
      const result = await runSimulation(mode, scenario, provider);
      const metrics = computeMetrics(result.records);
      runs.push({
        mode,
        seed,
        preset: PRESET_KEY,
        orderCount: scenario.orderCount,
        provider: USE_RECORDED ? 'recorded' : 'osrm-live',
        metrics,
        simEndMin: result.simEndMin,
        liveCalls: provider.liveCalls,
        degraded: provider.degraded,
        ranAt: new Date().toISOString(),
      });
      console.log(
        `seed=${seed} ${mode.padEnd(6)} n=${metrics.n} pickupP50=${metrics.pickupP50Min.toFixed(1)}min ` +
          `deliveryP50=${metrics.deliveryP50Min.toFixed(1)}min MAE=${metrics.etaMaeMin.toFixed(1)}min ` +
          `late=${metrics.latePct.toFixed(0)}% deadhead/order=${metrics.deadheadPerOrderKm.toFixed(2)}km ` +
          `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
    }
  }

  const now = new Date().toISOString().slice(0, 10);
  mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  writeFileSync(path.join(ROOT, `reports/bench-${now}.json`), JSON.stringify({ runs }, null, 2));

  const md = `# Benchmark — BEFORE vs AFTER (${now})

- Preset: **${PRESETS[PRESET_KEY].label}** (${preset.orderCount} orders, ${preset.courierCount} couriers, 90 min virtual rush)
- Provider: **${USE_RECORDED ? 'recorded snapshot' : 'OSRM live (router.project-osrm.org)'}**${provider.degraded ? ' — some requests fell back' : ''}
- Deterministic seeds: ${SEEDS.join(', ')} — same order set per seed for both modes
- Reproduce: \`npm run bench -- --recorded\`

| seed | orders | pickup p50 BEFORE | AFTER | pickup p95 BEFORE | AFTER | ETA MAE BEFORE | AFTER | late BEFORE | AFTER | deadhead/order BEFORE | AFTER |
|---|---|---|---|---|---|---|---|---|---|---|---|
${summarize(runs)}
`;
  writeFileSync(path.join(ROOT, `reports/bench-${now}.md`), md);

  if (!USE_RECORDED) {
    mkdirSync(path.join(ROOT, 'public/data'), { recursive: true });
    const cache = provider.exportCache();
    const snapshot: RecordedData = { version: 1, generatedAt: new Date().toISOString(), ...cache };
    writeFileSync(RECORDED_PATH, JSON.stringify(snapshot));
    const kb = Math.round(JSON.stringify(snapshot).length / 1024);
    console.log(`recorded snapshot: ${Object.keys(cache.routes).length} routes, ${Object.keys(cache.tables).length} tables (${kb} KiB)`);
  }
  console.log('done → reports/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
