import type { OrderRecord, SimResult } from './sim';

export interface Metrics {
  n: number;
  pickupP50Min: number;
  pickupP95Min: number;
  deliveryP50Min: number;
  deliveryP95Min: number;
  etaMaeMin: number;
  etaP95AbsMin: number;
  latePct: number;
  foodWaitP50Min: number;
  deadheadKm: number;
  deadheadPerOrderKm: number;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

export function computeMetrics(records: OrderRecord[]): Metrics {
  const n = records.length;
  const pickup = records.map((r) => r.tPickup - r.tPlaced).sort((a, b) => a - b);
  const delivery = records.map((r) => r.tDeliver - r.tPlaced).sort((a, b) => a - b);
  const foodWait = records.map((r) => r.tPickup - Math.max(r.tDispatch, r.tPlaced)).sort((a, b) => a - b);
  const absErr = records.map((r) => Math.abs(r.tDeliver - r.promised)).sort((a, b) => a - b);
  const late = records.filter((r) => r.tDeliver > r.promised).length;
  const deadheadKm = records.reduce((s, r) => s + r.leg1Km, 0);
  return {
    n,
    pickupP50Min: percentile(pickup, 50),
    pickupP95Min: percentile(pickup, 95),
    deliveryP50Min: percentile(delivery, 50),
    deliveryP95Min: percentile(delivery, 95),
    etaMaeMin: absErr.reduce((s, x) => s + x, 0) / n,
    etaP95AbsMin: percentile(absErr, 95),
    latePct: (late / n) * 100,
    foodWaitP50Min: percentile(foodWait, 50),
    deadheadKm,
    deadheadPerOrderKm: deadheadKm / n,
  };
}

export interface Delta {
  label: string;
  unit: string;
  before: number;
  after: number;
  pct: number;
  betterIsLower: boolean;
}

export function compareMetrics(before: Metrics, after: Metrics): Delta[] {
  const d = (b: number, a: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
  return [
    { label: 'Pickup wait p50', unit: 'min', before: before.pickupP50Min, after: after.pickupP50Min, pct: d(before.pickupP50Min, after.pickupP50Min), betterIsLower: true },
    { label: 'Pickup wait p95', unit: 'min', before: before.pickupP95Min, after: after.pickupP95Min, pct: d(before.pickupP95Min, after.pickupP95Min), betterIsLower: true },
    { label: 'Delivery p50', unit: 'min', before: before.deliveryP50Min, after: after.deliveryP50Min, pct: d(before.deliveryP50Min, after.deliveryP50Min), betterIsLower: true },
    { label: 'Delivery p95', unit: 'min', before: before.deliveryP95Min, after: after.deliveryP95Min, pct: d(before.deliveryP95Min, after.deliveryP95Min), betterIsLower: true },
    { label: 'ETA error (MAE)', unit: 'min', before: before.etaMaeMin, after: after.etaMaeMin, pct: d(before.etaMaeMin, after.etaMaeMin), betterIsLower: true },
    { label: 'Orders late vs promise', unit: '%', before: before.latePct, after: after.latePct, pct: d(before.latePct, after.latePct), betterIsLower: true },
    { label: 'Deadhead km / order', unit: 'km', before: before.deadheadPerOrderKm, after: after.deadheadPerOrderKm, pct: d(before.deadheadPerOrderKm, after.deadheadPerOrderKm), betterIsLower: true },
  ];
}

export interface BenchRun {
  mode: 'before' | 'after';
  seed: number;
  preset: string;
  orderCount: number;
  provider: string;
  metrics: Metrics;
  simEndMin: number;
  liveCalls: number;
  degraded: boolean;
  ranAt: string;
}

export function summarize(results: BenchRun[]): string {
  const bySeed = new Map<number, BenchRun[]>();
  for (const r of results) {
    if (!bySeed.has(r.seed)) bySeed.set(r.seed, []);
    bySeed.get(r.seed)!.push(r);
  }
  const lines: string[] = [];
  for (const [seed, runs] of bySeed) {
    const b = runs.find((r) => r.mode === 'before');
    const a = runs.find((r) => r.mode === 'after');
    if (!b || !a) continue;
    lines.push(
      `| ${seed} | ${b.orderCount} | ${b.metrics.pickupP50Min.toFixed(1)} | ${a.metrics.pickupP50Min.toFixed(1)} | ${b.metrics.pickupP95Min.toFixed(1)} | ${a.metrics.pickupP95Min.toFixed(1)} | ${b.metrics.etaMaeMin.toFixed(1)} | ${a.metrics.etaMaeMin.toFixed(1)} | ${b.metrics.latePct.toFixed(0)}% | ${a.metrics.latePct.toFixed(0)}% | ${b.metrics.deadheadPerOrderKm.toFixed(2)} | ${a.metrics.deadheadPerOrderKm.toFixed(2)} |`,
    );
  }
  return lines.join('\n');
}

export function simMeta(r: SimResult) {
  return { simEndMin: r.simEndMin, totalDeadheadKm: r.totalDeadheadKm };
}
