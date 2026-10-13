import { haversineKm, interpolateAlong, type LngLat } from './geo';
import type { RouteResult, RoutingProvider } from './osrm';
import type { Order, Scenario } from './scenario';

export type Mode = 'before' | 'after';

export interface OrderRecord {
  id: number;
  courierId: number;
  tPlaced: number;
  /** When the assigned courier actually departs (== placement, or later if queued/planned). */
  tDispatch: number;
  tPickup: number;
  tDeliver: number;
  promised: number;
  leg1Km: number;
  leg2Km: number;
  leg1Source: RouteResult['source'];
  leg2Source: RouteResult['source'];
}

export interface TrailSeg {
  t0: number;
  t1: number;
  coords: LngLat[];
  kind: 'pickup' | 'deliver';
  orderId: number;
}

export interface SimResult {
  mode: Mode;
  records: OrderRecord[];
  trails: Map<number, TrailSeg[]>;
  simEndMin: number;
  totalDeadheadKm: number;
  avgDispatchLagMin: number;
}

interface CourierState {
  id: number;
  pos: LngLat;
  /** Earliest time the courier can start a new job from `pos`. */
  idleAt: number;
  segs: TrailSeg[];
}

const SERVICE_MIN = 1; // handover at the door
const NAIVE_KMH = 25;
const NAIVE_PREP_MIN = 10;
const SMART_BUFFER_MIN = 2;

export async function runSimulation(
  mode: Mode,
  scenario: Scenario,
  provider: RoutingProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<SimResult> {
  const couriers = new Map<number, CourierState>();
  for (const c of scenario.couriers)
    couriers.set(c.id, { id: c.id, pos: c.home, idleAt: 0, segs: [] });

  const records: OrderRecord[] = [];
  let deadheadKm = 0;
  let dispatchLagSum = 0;
  let done = 0;

  // Orders processed in placement order; every decision depends only on
  // previous decisions + deterministic route data => reproducible runs.
  for (const order of scenario.orders) {
    let chosen: CourierState;
    let startAt: number;

    if (mode === 'before') {
      // Naive dispatch: nearest by crow-flies among *idle* couriers.
      // If nobody is idle, wait FIFO-style for the soonest-free courier
      // (no road knowledge, no future planning).
      const idle = [...couriers.values()].filter((c) => c.idleAt <= order.tPlacedMin);
      if (idle.length > 0) {
        chosen = idle.reduce((best, c) =>
          haversineKm(c.pos, order.resto.pos) < haversineKm(best.pos, order.resto.pos) ? c : best,
        );
      } else {
        chosen = [...couriers.values()].reduce((best, c) => (c.idleAt < best.idleAt ? c : best));
      }
    } else {
      // Smart dispatch: decide by real road time from the courier's position,
      // including couriers still busy (planned chaining).
      const candidates = [...couriers.values()];
      if (candidates.length === 1) {
        chosen = candidates[0];
      } else {
        const idle = candidates.filter((c) => c.idleAt <= order.tPlacedMin);
        let pool = candidates;
        if (idle.length > 0) {
          // Prefer an idle courier — road time decides which one.
          const minutes = await provider.tableMinutes(idle.map((c) => c.pos), [order.resto.pos]);
          let bestIdx = 0;
          for (let i = 1; i < idle.length; i++)
            if (minutes[i][0] < minutes[bestIdx][0]) bestIdx = i;
          chosen = idle[bestIdx];
        } else {
          // Nobody idle: pick the courier that can arrive soonest (table for
          // busy couriers too, so future positions count).
          const minutes = await provider.tableMinutes(candidates.map((c) => c.pos), [order.resto.pos]);
          let bestIdx = 0;
          let bestArrival = Infinity;
          for (let i = 0; i < candidates.length; i++) {
            const ready = Math.max(candidates[i].idleAt, order.tPlacedMin);
            const road = Number.isFinite(minutes[i][0])
              ? minutes[i][0]
              : (haversineKm(candidates[i].pos, order.resto.pos) / 28) * 60;
            if (ready + road < bestArrival) {
              bestArrival = ready + road;
              bestIdx = i;
            }
          }
          chosen = candidates[bestIdx];
        }
      }
    }

    startAt = Math.max(order.tPlacedMin, chosen.idleAt);
    const dispatchLag = startAt - order.tPlacedMin;
    dispatchLagSum += dispatchLag;

    // Leg 1: courier -> restaurant (on real roads in BOTH modes; only the
    // choice heuristic and planning differ).
    const leg1 = await provider.route(chosen.pos, order.resto.pos);
    const leg1Min = (leg1.durationS / 60) * order.noise.leg1;
    const arrivalAtResto = startAt + leg1Min;
    const tPickup = Math.max(arrivalAtResto, order.tPlacedMin + order.prepActualMin);

    // Leg 2: restaurant -> customer.
    const leg2 = await provider.route(order.resto.pos, order.cust);
    const leg2Min = (leg2.durationS / 60) * order.noise.leg2;
    const tDeliver = tPickup + leg2Min;

    // Promise shown to the customer at placement time.
    let promised: number;
    if (mode === 'before') {
      // Naive apps: straight line at a constant speed, flat prep guess, and
      // the pickup leg + dispatch wait are ignored entirely.
      promised = order.tPlacedMin + (haversineKm(order.resto.pos, order.cust) / NAIVE_KMH) * 60 + NAIVE_PREP_MIN;
    } else {
      promised =
        order.tPlacedMin +
        dispatchLag +
        leg1.durationS / 60 +
        order.resto.prepMeanMin +
        leg2.durationS / 60 +
        SMART_BUFFER_MIN;
    }

    records.push({
      id: order.id,
      courierId: chosen.id,
      tPlaced: order.tPlacedMin,
      tDispatch: startAt,
      tPickup,
      tDeliver,
      promised,
      leg1Km: leg1.distanceM / 1000,
      leg2Km: leg2.distanceM / 1000,
      leg1Source: leg1.source,
      leg2Source: leg2.source,
    });
    deadheadKm += leg1.distanceM / 1000;

    // Timeline: segs for pickup + delivery, then idle at the customer.
    chosen.segs.push({ t0: startAt, t1: arrivalAtResto, coords: leg1.coords, kind: 'pickup', orderId: order.id });
    chosen.segs.push({ t0: tPickup, t1: tDeliver, coords: leg2.coords, kind: 'deliver', orderId: order.id });
    chosen.pos = order.cust;
    chosen.idleAt = tDeliver + SERVICE_MIN;

    done++;
    onProgress?.(done, scenario.orders.length);
  }

  const simEndMin = records.reduce((m, r) => Math.max(m, r.tDeliver), 0);
  return {
    mode,
    records,
    trails: new Map([...couriers.values()].map((c) => [c.id, c.segs])),
    simEndMin,
    totalDeadheadKm: deadheadKm,
    avgDispatchLagMin: dispatchLagSum / records.length,
  };
}

/** Courier position at virtual time t (for map animation). */
export function courierPositionAt(segs: TrailSeg[], courierHome: LngLat, t: number): LngLat {
  let last: LngLat = courierHome;
  for (const s of segs) {
    if (t >= s.t1) {
      last = s.coords[s.coords.length - 1];
      continue;
    }
    if (t >= s.t0) {
      const f = (t - s.t0) / Math.max(1e-9, s.t1 - s.t0);
      return interpolateAlong(s.coords, f);
    }
    break;
  }
  return last;
}

/** Routes visible at virtual time t (polylines currently being ridden). */
export function activeRoutesAt(segs: TrailSeg[], t: number): TrailSeg[] {
  return segs.filter((s) => t >= s.t0 && t <= s.t1);
}
