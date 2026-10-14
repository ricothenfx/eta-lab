'use client';

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Map as MapLibreMap, AttributionControl, Popup, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Scenario } from '@/lib/scenario';
import type { SimResult, TrailSeg } from '@/lib/sim';
import { courierPositionAt, activeRoutesAt } from '@/lib/sim';

export const BERLIN_CENTER: [number, number] = [13.405, 52.52];

export interface MapViewHandle {
  setTime: (t: number) => void;
}

interface Props {
  scenario: Scenario | null;
  result: SimResult | null;
  mode: 'before' | 'after';
  time: number;
  className?: string;
}

const ORDER_COLORS: Record<string, string> = {
  waiting: '#e8a013',
  cooking: '#2f6fed',
  onTheWay: '#8b3fd6',
  done: '#1d7a3e',
};

function makeMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: BERLIN_CENTER,
    zoom: 11.6,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }));
  return map;
}

export const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  { scenario, result, mode, time, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const fittedRef = useRef<Scenario | null>(null);
  const dataRef = useRef<{
    scenario: Scenario | null;
    result: SimResult | null;
    time: number;
  }>({ scenario: null, result: null, time: 0 });

  dataRef.current.scenario = scenario;
  dataRef.current.result = result;
  dataRef.current.time = time;

  function ensureSources(map: MapLibreMap) {
    if (map.getSource('restos')) return;
    map.addSource('restos', { type: 'geojson', data: emptyFC() });
    map.addSource('orders', { type: 'geojson', data: emptyFC() });
    map.addSource('couriers', { type: 'geojson', data: emptyFC() });
    map.addSource('routes', { type: 'geojson', data: emptyFC() });

    map.addLayer({
      id: 'routes-line',
      type: 'line',
      source: 'routes',
      paint: {
        'line-color': ['match', ['get', 'kind'], 'pickup', '#1a4fd6', '#8b3fd6'],
        'line-width': 4,
        'line-opacity': 0.85,
      },
    });
    map.addLayer({
      id: 'restos-circle',
      type: 'circle',
      source: 'restos',
      paint: {
        'circle-radius': 7,
        'circle-color': '#d95f02',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'orders-circle',
      type: 'circle',
      source: 'orders',
      paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': ['case', ['==', ['get', 'status'], 'done'], 0.35, 1],
      },
    });
    map.addLayer({
      id: 'couriers-circle',
      type: 'circle',
      source: 'couriers',
      paint: {
        'circle-radius': 6,
        'circle-color': mode === 'before' ? '#b3261e' : '#1d7a3e',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    });

    const show = (e: MapLayerMouseEvent) => {
      const d = dataRef.current;
      const f = e.features?.[0];
      if (!f || !d.result) return;
      const html = f.properties?.html ?? '';
      popupRef.current?.remove();
      popupRef.current = new Popup({ closeButton: false, maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    };
    map.on('click', 'couriers-circle', show);
    map.on('click', 'orders-circle', show);
    map.on('click', 'restos-circle', show);
  }

  function emptyFC(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  function fitScenario(map: MapLibreMap, sc: Scenario) {
    const pts = [
      ...sc.restaurants.map((r) => r.pos),
      ...sc.orders.map((o) => o.cust),
      ...sc.couriers.map((c) => c.home),
    ];
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    fittedRef.current = sc;
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 60, duration: 600, maxZoom: 13.5 },
    );
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = makeMap(containerRef.current);
    mapRef.current = map;
    // exposed for the E2E test (scripts/e2e.ts)
    const w = window as unknown as { __etaMap?: MapLibreMap; __etaMaps?: MapLibreMap[] };
    w.__etaMap = map;
    (w.__etaMaps ??= []).push(map);
    map.on('load', () => {
      ensureSources(map);
      refreshStatic();
      const sc = dataRef.current.scenario;
      if (sc && fittedRef.current !== sc) fitScenario(map, sc);
      refreshAt(dataRef.current.time);
    });
    return () => {
      popupRef.current?.remove();
      map.remove();
      const w = window as unknown as { __etaMaps?: MapLibreMap[] };
      w.__etaMaps = w.__etaMaps?.filter((m) => m !== map);
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint static layers when scenario/result identity changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (map.getLayer('couriers-circle'))
      map.setPaintProperty('couriers-circle', 'circle-color', mode === 'before' ? '#b3261e' : '#1d7a3e');
    if (scenario && fittedRef.current !== scenario) fitScenario(map, scenario);
    refreshStatic();
    refreshAt(dataRef.current.time);
  }, [scenario, result, mode]);

  function refreshStatic() {
    const map = mapRef.current;
    const sc = dataRef.current.scenario;
    if (!map || !sc || !map.getSource('restos')) return;
    (map.getSource('restos') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: sc.restaurants.map((r) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: r.pos },
        properties: {
          html: `<b>${r.name}</b><br/><span class="popup-muted">${r.area} · prep ~${Math.round(r.prepMeanMin)} min</span>`,
        },
      })),
    });
  }

  function refreshAt(t: number) {
    const map = mapRef.current;
    const d = dataRef.current;
    if (!map || !d.scenario || !map.getSource('orders')) return;

    // orders with current status
    const recs = d.result?.records;
    const orderFeatures: GeoJSON.Feature[] = [];
    if (recs) {
      for (const r of recs) {
        const o = d.scenario!.orders[r.id];
        let status = 'waiting';
        if (t >= r.tDeliver) status = 'done';
        else if (t >= r.tPickup) status = 'onTheWay';
        else if (t >= r.tDispatch) status = 'cooking';
        if (status === 'done' && t > d.result!.simEndMin + 1) continue;
        const info =
          status === 'waiting'
            ? `waiting for a courier`
            : status === 'cooking'
              ? `courier heading to ${o.resto.name}`
              : status === 'onTheWay'
                ? `on the way to the customer`
                : `delivered`;
        orderFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: status === 'done' || status === 'onTheWay' ? o.cust : o.resto.pos },
          properties: {
            color: ORDER_COLORS[status],
            status,
            html: `<b>Order #${o.id}</b><br/><span class="popup-muted">${o.resto.name} · ${info}<br/>` +
              `promised ${fmtClock(d.scenario!, r.promised)} · actual ${fmtClock(d.scenario!, r.tDeliver)}</span>`,
          },
        });
      }
    }
    (map.getSource('orders') as GeoJSONSource).setData({ type: 'FeatureCollection', features: orderFeatures });

    // couriers
    const courierFeatures: GeoJSON.Feature[] = [];
    if (d.result) {
      for (const c of d.scenario!.couriers) {
        const segs = d.result.trails.get(c.id) ?? ([] as TrailSeg[]);
        const pos = courierPositionAt(segs, c.home, t);
        const active = segs.find((s) => t >= s.t0 && t <= s.t1);
        courierFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: {
            html: `<b>Courier #${c.id}</b><br/><span class="popup-muted">${active ? (active.kind === 'pickup' ? 'riding to restaurant' : 'delivering') : 'idle'}</span>`,
          },
        });
      }
    } else if (d.scenario) {
      for (const c of d.scenario.couriers)
        courierFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.home },
          properties: { html: `<b>Courier #${c.id}</b>` },
        });
    }
    (map.getSource('couriers') as GeoJSONSource).setData({ type: 'FeatureCollection', features: courierFeatures });

    // active route polylines
    const routeFeatures: GeoJSON.Feature[] = [];
    if (d.result) {
      for (const segs of d.result.trails.values())
        for (const s of activeRoutesAt(segs, t))
          routeFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: s.coords },
            properties: { kind: s.kind },
          });
    }
    (map.getSource('routes') as GeoJSONSource).setData({ type: 'FeatureCollection', features: routeFeatures });
  }

  useImperativeHandle(ref, () => ({
    setTime: (t: number) => {
      dataRef.current.time = t;
      refreshAt(t);
    },
  }));

  return <div ref={containerRef} className={className ?? 'min-h-0 flex-1'} />;
});

function fmtClock(sc: Scenario, tMin: number): string {
  const total = Math.round(sc.startMin + tMin);
  const hh = (18 + Math.floor(total / 60)) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
