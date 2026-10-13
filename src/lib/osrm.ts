import { haversineKm, type LngLat } from './geo';

export interface RouteResult {
  distanceM: number;
  durationS: number;
  coords: LngLat[];
  source: 'cache' | 'osrm' | 'recorded' | 'estimate';
}

export interface RoutingProvider {
  route(a: LngLat, b: LngLat): Promise<RouteResult>;
  /** Minutes matrix: srcs x dsts. */
  tableMinutes(srcs: LngLat[], dsts: LngLat[]): Promise<number[][]>;
  /** True once any request fell back to recorded/estimate data. */
  degraded: boolean;
  readonly liveCalls: number;
}

interface StoredRoute {
  d: number;
  t: number;
  c: LngLat[];
}

export interface RecordedData {
  version: 1;
  generatedAt: string;
  routes: Record<string, StoredRoute>;
  tables: Record<string, number[][]>;
}

export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
const coordKey = (c: LngLat) => `${round5(c[0])},${round5(c[1])}`;
export const routeKey = (a: LngLat, b: LngLat) => `R|${coordKey(a)}|${coordKey(b)}`;
export const tableKey = (s: LngLat[], d: LngLat[]) =>
  `T|${s.map(coordKey).join(';')}|${d.map(coordKey).join(';')}`;

/** Naive but honest last-resort estimate: crow distance * detour factor at 28 km/h. */
function estimateRoute(a: LngLat, b: LngLat): RouteResult {
  const km = haversineKm(a, b) * 1.35;
  return { distanceM: km * 1000, durationS: (km / 28) * 3600, coords: [a, b], source: 'estimate' };
}

export class OsrmProvider implements RoutingProvider {
  degraded = false;
  liveCalls = 0;

  private cache = new Map<string, RouteResult | number[][]>();
  private inflight = 0;
  private readonly maxInflight: number;
  private readonly attempts: number;
  private readonly baseUrl: string;
  private readonly storage: KVStore | null;
  private readonly recorded: RecordedData | null;

  constructor(opts?: {
    baseUrl?: string;
    storage?: KVStore | null;
    recorded?: RecordedData | null;
    concurrency?: number;
    attempts?: number;
  }) {
    this.baseUrl = opts?.baseUrl ?? 'https://router.project-osrm.org';
    this.storage = opts?.storage ?? null;
    this.recorded = opts?.recorded ?? null;
    this.maxInflight = opts?.concurrency ?? 4;
    this.attempts = opts?.attempts ?? 3;
    if (this.storage) this.loadPersistentCache();
  }

  private async acquire() {
    while (this.inflight >= this.maxInflight) await new Promise((r) => setTimeout(r, 25));
    this.inflight++;
  }

  private release() {
    this.inflight--;
  }

  private loadPersistentCache() {
    try {
      const raw = this.storage!.getItem('etalab-cache-v1');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { routes?: Record<string, StoredRoute> };
      for (const [k, v] of Object.entries(parsed.routes ?? {})) {
        this.cache.set(k, { distanceM: v.d, durationS: v.t, coords: v.c, source: 'cache' });
      }
    } catch {
      /* corrupted cache — ignore */
    }
  }

  /** Everything learned so far, for writing recorded-*.json snapshots. */
  exportCache(): { routes: Record<string, StoredRoute>; tables: Record<string, number[][]> } {
    const routes: Record<string, StoredRoute> = {};
    const tables: Record<string, number[][]> = {};
    for (const [k, v] of this.cache.entries()) {
      if (k.startsWith('R|') && 'coords' in (v as RouteResult)) {
        const r = v as RouteResult;
        routes[k] = { d: r.distanceM, t: r.durationS, c: r.coords };
      } else if (k.startsWith('T|')) {
        tables[k] = v as number[][];
      }
    }
    return { routes, tables };
  }

  /** Persist routes (not tables — too big) for instant re-runs. */
  persist() {
    if (!this.storage) return;
    try {
      const routes: Record<string, StoredRoute> = {};
      for (const [k, v] of this.cache.entries()) {
        if (k.startsWith('R|') && 'coords' in v) routes[k] = { d: v.distanceM, t: v.durationS, c: v.coords };
      }
      this.storage.setItem('etalab-cache-v1', JSON.stringify({ routes }));
    } catch {
      /* quota — ignore */
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as unknown;
      } catch (e) {
        lastErr = e;
        if (attempt < this.attempts - 1) await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  async route(a: LngLat, b: LngLat): Promise<RouteResult> {
    const key = routeKey(a, b);
    const hit = this.cache.get(key);
    if (hit && 'coords' in (hit as RouteResult)) return hit as RouteResult;

    await this.acquire();
    try {
      const url = `${this.baseUrl}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`;
      const json = (await this.fetchJson(url)) as {
        code?: string;
        routes?: Array<{ distance: number; duration: number; geometry: { coordinates: LngLat[] } }>;
      };
      this.liveCalls++;
      const r = json.routes?.[0];
      if (json.code === 'Ok' && r) {
        const out: RouteResult = {
          distanceM: r.distance,
          durationS: r.duration,
          coords: r.geometry.coordinates,
          source: 'osrm',
        };
        this.cache.set(key, out);
        return out;
      }
      throw new Error(`OSRM code=${json.code}`);
    } catch {
      this.degraded = true;
      const rec = this.recorded?.routes[key];
      if (rec) {
        const out: RouteResult = { distanceM: rec.d, durationS: rec.t, coords: rec.c, source: 'recorded' };
        this.cache.set(key, out);
        return out;
      }
      const out = estimateRoute(a, b);
      this.cache.set(key, out);
      return out;
    } finally {
      this.release();
    }
  }

  async tableMinutes(srcs: LngLat[], dsts: LngLat[]): Promise<number[][]> {
    if (srcs.length === 0 || dsts.length === 0) return srcs.map(() => dsts.map(() => NaN));
    const key = tableKey(srcs, dsts);
    const hit = this.cache.get(key);
    if (hit && Array.isArray(hit)) return hit as number[][];

    const SRC_CHUNK = 16;
    const DST_CHUNK = 16;
    const out: number[][] = Array.from({ length: srcs.length }, () => Array(dsts.length).fill(NaN));

    const jobs: Array<{ si: number[]; di: number[] }> = [];
    for (let s = 0; s < srcs.length; s += SRC_CHUNK)
      for (let d = 0; d < dsts.length; d += DST_CHUNK)
        jobs.push({
          si: srcs.slice(s, s + SRC_CHUNK).map((_, k) => s + k),
          di: dsts.slice(d, d + DST_CHUNK).map((_, k) => d + k),
        });

    await Promise.all(
      jobs.map(async (job) => {
        await this.acquire();
        try {
          const all = [...job.si.map((i) => srcs[i]), ...job.di.map((i) => dsts[i])];
          const coordStr = all.map((c) => `${c[0]},${c[1]}`).join(';');
          const srcIdx = job.si.map((_, k) => k).join(';');
          const dstIdx = job.di.map((_, k) => job.si.length + k).join(';');
          const url = `${this.baseUrl}/table/v1/driving/${coordStr}?sources=${srcIdx}&destinations=${dstIdx}`;
          const json = (await this.fetchJson(url)) as { code?: string; durations?: (number | null)[][] };
          this.liveCalls++;
          if (json.code === 'Ok' && json.durations) {
            job.si.forEach((si, i) =>
              job.di.forEach((di, j) => {
                const v = json.durations![i][j];
                out[si][di] = v == null ? NaN : v / 60;
              }),
            );
            return;
          }
          throw new Error(`OSRM table code=${json.code}`);
        } catch {
          this.degraded = true;
          const rec = this.recorded?.tables[key];
          if (rec) {
            job.si.forEach((si, i) => job.di.forEach((di, j) => (out[si][di] = rec[i]?.[j] ?? NaN)));
            return;
          }
          // crow-flies fallback at 28 km/h — flagged in the UI
          job.si.forEach((si, i) =>
            job.di.forEach((di, j) => {
              out[si][di] = (haversineKm(srcs[si], dsts[di]) / 28) * 60;
            }),
          );
        } finally {
          this.release();
        }
      }),
    );
    this.cache.set(key, out);
    return out;
  }
}

/** Browser convenience: a KVStore backed by localStorage. */
export function localStorageStore(): KVStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

export async function loadRecordedData(url = '/data/recorded-routes.json'): Promise<RecordedData | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as RecordedData;
  } catch {
    return null;
  }
}
