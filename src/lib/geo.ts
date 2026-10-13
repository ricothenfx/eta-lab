export type LngLat = [number, number];

const EARTH_R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Position along a polyline at fraction f of its total haversine length. */
export function interpolateAlong(coords: LngLat[], f: number): LngLat {
  if (coords.length === 0) return [13.405, 52.52];
  if (coords.length === 1 || f <= 0) return coords[0];
  if (f >= 1) return coords[coords.length - 1];
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i]);
    segLens.push(d);
    total += d;
  }
  let target = f * total;
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] || i === segLens.length - 1) {
      const t = segLens[i] === 0 ? 0 : Math.min(1, target / segLens[i]);
      const [x0, y0] = coords[i];
      const [x1, y1] = coords[i + 1];
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    target -= segLens[i];
  }
  return coords[coords.length - 1];
}

export const min = (arr: number[]) => Math.min(...arr);
export const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
