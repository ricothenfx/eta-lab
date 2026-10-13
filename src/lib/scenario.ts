import type { LngLat } from './geo';
import { expovariate, mulberry32, normal, pick, uniform, type Rng } from './prng';

export interface Restaurant {
  id: string;
  name: string;
  area: string;
  pos: LngLat;
  prepMeanMin: number;
  prepSdMin: number;
}

export interface Courier {
  id: number;
  home: LngLat;
}

export interface Order {
  id: number;
  tPlacedMin: number;
  resto: Restaurant;
  cust: LngLat;
  /** Seeded per-leg speed noise multipliers and the actual prep time. */
  noise: { leg1: number; leg2: number };
  prepActualMin: number;
}

export interface Scenario {
  seed: number;
  orderCount: number;
  startMin: number;
  horizonMin: number;
  restaurants: Restaurant[];
  couriers: Courier[];
  orders: Order[];
}

/**
 * Real Berlin neighborhoods (coordinates are on real streets; the venue names
 * are synthetic — same approach as the OSM-based simulation data policy).
 */
const RESTO_TEMPLATE: Array<Pick<Restaurant, 'name' | 'area'> & { pos: LngLat }> = [
  { name: 'Kotti Kebap Co.', area: 'Kreuzberg', pos: [13.4163, 52.4987] },
  { name: 'Karl-Marx Kitchen', area: 'Neukölln', pos: [13.438, 52.487] },
  { name: 'Boxi Bowl Bar', area: 'Friedrichshain', pos: [13.454, 52.5085] },
  { name: 'Kollwitz Curry', area: 'Prenzlauer Berg', pos: [13.4125, 52.533] },
  { name: 'Rosenthal Ramen', area: 'Mitte', pos: [13.402, 52.5296] },
  { name: 'Leopold Lunch Lab', area: 'Wedding', pos: [13.365, 52.548] },
  { name: 'Nollendorf Noodles', area: 'Schöneberg', pos: [13.356, 52.504] },
  { name: 'Savigny Soups', area: 'Charlottenburg', pos: [13.325, 52.507] },
  { name: 'Turmstraße Teller', area: 'Moabit', pos: [13.348, 52.523] },
  { name: 'Damm Döner Deli', area: 'Tempelhof', pos: [13.39, 52.47] },
  { name: 'Treptow Table', area: 'Treptow', pos: [13.46, 52.49] },
  { name: 'Badstraße Bites', area: 'Gesundbrunnen', pos: [13.386, 52.55] },
];

/** Courier idle hotspots — real Berlin squares. */
const HOTSPOTS: LngLat[] = [
  [13.4132, 52.5219], // Alexanderplatz
  [13.426, 52.489], // Hermannplatz
  [13.449, 52.506], // Warschauer Straße
  [13.332, 52.505], // Zoologischer Garten
  [13.369, 52.525], // Hauptbahnhof
  [13.464, 52.503], // Ostkreuz
];

export interface ScenarioConfig {
  seed: number;
  orderCount: number;
  courierCount: number;
  startMin?: number;
  horizonMin?: number;
}

export const PRESETS = {
  quiet: { label: 'Quiet evening', orderCount: 50, courierCount: 16 },
  rush: { label: 'Dinner rush', orderCount: 100, courierCount: 14 },
  flash: { label: 'Flash-sale surge', orderCount: 160, courierCount: 14 },
} as const;

export type PresetKey = keyof typeof PRESETS;

/** Arrival rate (orders/min) across the virtual rush window. */
export function arrivalRate(tMin: number, horizonMin: number): number {
  const t = tMin / horizonMin;
  // gentle start, heavy peak between 25%–70% of the window, taper after
  const peak = Math.exp(-((t - 0.45) ** 2) / (2 * 0.16 ** 2));
  return 0.18 + 1.05 * peak;
}

function sampleArrivals(rng: Rng, count: number, horizonMin: number): number[] {
  const times: number[] = [];
  let t = 0;
  let maxRate = 0;
  for (let x = 0; x <= horizonMin; x += 1) maxRate = Math.max(maxRate, arrivalRate(x, horizonMin));
  while (times.length < count) {
    t += expovariate(rng, maxRate);
    if (t > horizonMin) break;
    if (rng() < arrivalRate(t, horizonMin) / maxRate) times.push(t);
  }
  times.sort((a, b) => a - b);
  return times;
}

export function generateScenario(cfg: ScenarioConfig): Scenario {
  const rng = mulberry32(cfg.seed);
  const startMin = cfg.startMin ?? 0;
  const horizonMin = cfg.horizonMin ?? 90;

  const restaurants: Restaurant[] = RESTO_TEMPLATE.map((t, i) => ({
    ...t,
    id: `r${i}`,
    prepMeanMin: uniform(rng, 8, 14),
    prepSdMin: uniform(rng, 3, 4.5),
  }));

  const couriers: Courier[] = Array.from({ length: cfg.courierCount }, (_, i) => ({
    id: i,
    home: pick(rng, HOTSPOTS),
  }));

  const times = sampleArrivals(rng, cfg.orderCount, horizonMin);
  const orders: Order[] = times.map((tPlacedMin, i) => {
    const resto = pick(rng, restaurants);
    // customer 0.7–2.8 km crow-flies from the restaurant, random bearing
    const bearing = uniform(rng, 0, 2 * Math.PI);
    const km = uniform(rng, 0.7, 2.8);
    const dLat = (km * Math.cos(bearing)) / 111.32;
    const dLng = (km * Math.sin(bearing)) / (111.32 * Math.cos((resto.pos[1] * Math.PI) / 180));
    const cust: LngLat = [resto.pos[0] + dLng, resto.pos[1] + dLat];
    return {
      id: i,
      tPlacedMin: startMin + tPlacedMin,
      resto,
      cust,
      noise: { leg1: Math.max(0.75, normal(rng, 1.0, 0.12)), leg2: Math.max(0.75, normal(rng, 1.0, 0.12)) },
      prepActualMin: Math.max(3, normal(rng, resto.prepMeanMin, resto.prepSdMin)),
    };
  });

  return {
    seed: cfg.seed,
    orderCount: orders.length,
    startMin,
    horizonMin,
    restaurants,
    couriers,
    orders,
  };
}
