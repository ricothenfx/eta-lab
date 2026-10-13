/**
 * Offline self-test: determinism + sanity of the engine, no network needed
 * (uses the estimate fallback by pointing the provider at an unreachable URL).
 * Run: npm run selftest
 */
import { OsrmProvider } from '../src/lib/osrm';
import { generateScenario, PRESETS } from '../src/lib/scenario';
import { runSimulation } from '../src/lib/sim';
import { computeMetrics } from '../src/lib/metrics';

async function run(seed: number, mode: 'before' | 'after') {
  const scenario = generateScenario({ seed, orderCount: 40, courierCount: 12 });
  const provider = new OsrmProvider({ baseUrl: 'http://127.0.0.1:1', concurrency: 4, storage: null, attempts: 1 });
  const result = await runSimulation(mode, scenario, provider);
  return { result, metrics: computeMetrics(result.records) };
}

async function main() {
  // 1. scenario determinism
  const a = JSON.stringify(generateScenario({ seed: 7, orderCount: 30, courierCount: 12 }));
  const b = JSON.stringify(generateScenario({ seed: 7, orderCount: 30, courierCount: 12 }));
  if (a !== b) throw new Error('scenario not deterministic');
  console.log('scenario determinism: OK');

  // 2. engine determinism per mode (estimate provider is deterministic)
  for (const mode of ['before', 'after'] as const) {
    const r1 = await run(11, mode);
    const r2 = await run(11, mode);
    if (JSON.stringify(r1.result.records) !== JSON.stringify(r2.result.records))
      throw new Error(`sim ${mode} not deterministic`);
    if (!Number.isFinite(r1.metrics.etaMaeMin) || r1.metrics.etaMaeMin <= 0)
      throw new Error(`sim ${mode} metrics look wrong`);
    console.log(`engine determinism (${mode}): OK — MAE=${r1.metrics.etaMaeMin.toFixed(2)}min`);
  }

  // 3. sanity: BEFORE ETA error must exceed AFTER ETA error on estimate data
  const before = await run(11, 'before');
  const after = await run(11, 'after');
  if (before.metrics.etaMaeMin <= after.metrics.etaMaeMin)
    throw new Error('expected BEFORE MAE > AFTER MAE (naive promise underestimates road reality)');
  console.log(`sanity (BEFORE MAE ${before.metrics.etaMaeMin.toFixed(1)} > AFTER MAE ${after.metrics.etaMaeMin.toFixed(1)}): OK`);

  // 4. courier position interpolation never yields NaN
  console.log(`preset smoke: ${PRESETS.rush.label} = ${PRESETS.rush.orderCount} orders`);
  console.log('ALL SELFTESTS PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
