'use client';

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Map as MapLibreMap, AttributionControl, Popup, type GeoJSONSource, type MapLayerMouseEvent, type SymbolLayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Scenario } from '@/lib/scenario';
import type { Mode, SimResult, TrailSeg } from '@/lib/sim';
import { courierPositionAt, activeRoutesAt } from '@/lib/sim';

export const BERLIN_CENTER: [number, number] = [13.405, 52.52];

export interface MapViewHandle {
  setTime: (t: number) => void;
  getMap: () => MapLibreMap | null;
}

/** A courier picked on the map, scoped to the mode of the map it was clicked on. */
export interface CourierSelection {
  mode: Mode;
  courierId: number;
}

interface Props {
  scenario: Scenario | null;
  result: SimResult | null;
  mode: 'before' | 'after';
  time: number;
  selection?: CourierSelection | null;
  onSelectCourier?: (selection: CourierSelection | null) => void;
  className?: string;
}

const ORDER_COLORS: Record<string, string> = {
  waiting: '#e8a013',
  cooking: '#2f6fed',
  onTheWay: '#8b3fd6',
  done: '#1d7a3e',
};

const COURIER_COLORS: Record<'before' | 'after', string> = {
  before: '#b3261e',
  after: '#1d7a3e',
};

const RESTO_ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">` +
  `<rect x="1" y="1" width="22" height="22" rx="6" fill="#d95f02" stroke="#ffffff" stroke-width="1.5"/>` +
  `<path d="M8.2 5.4v3.9a1.9 1.9 0 0 0 3.8 0V5.4" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>` +
  `<path d="M10.1 11.2v7.4" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>` +
  `<path d="M16.8 5.4v13.2" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>` +
  `<path d="M16.8 5.4c-2.6 1.7-3.2 4.5-1.7 6.9l1.7 1.3" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>`;

const courierIconSvg = (color: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">` +
  `<path d="M12 1.6 21 6.8v10.4L12 22.4 3 17.2V6.8z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>` +
  `<circle cx="7" cy="16.8" r="2" fill="none" stroke="#ffffff" stroke-width="1.6"/>` +
  `<circle cx="17.2" cy="16.8" r="2" fill="none" stroke="#ffffff" stroke-width="1.6"/>` +
  `<path d="M7 16.8h6.6l2.3-6.6" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="M14.2 10.2h4.4" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>` +
  `<path d="M18.6 10.2l-1.4 6.6" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>` +
  `</svg>`;

const ICON_DEFS: Array<{ id: string; svg: string }> = [
  { id: 'resto-icon', svg: RESTO_ICON_SVG },
  { id: 'courier-before', svg: courierIconSvg(COURIER_COLORS.before) },
  { id: 'courier-after', svg: courierIconSvg(COURIER_COLORS.after) },
];

function loadIcon(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(48, 48);
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode icon svg'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

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
  { scenario, result, mode, time, selection, onSelectCourier, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const fittedRef = useRef<Scenario | null>(null);
  const onSelectRef = useRef(onSelectCourier);
  const dataRef = useRef<{
    scenario: Scenario | null;
    result: SimResult | null;
    time: number;
    mode: 'before' | 'after';
    selection: CourierSelection | null;
  }>({ scenario: null, result: null, time: 0, mode, selection: null });

  dataRef.current.scenario = scenario;
  dataRef.current.result = result;
  dataRef.current.time = time;
  dataRef.current.mode = mode;
  dataRef.current.selection = selection ?? null;
  onSelectRef.current = onSelectCourier;

  async function ensureSources(map: MapLibreMap) {
    if (map.getSource('restos')) return;
    await Promise.all(
      ICON_DEFS.map(async ({ id, svg }) => {
        try {
          if (!map.hasImage(id)) map.addImage(id, await loadIcon(svg), { pixelRatio: 2 });
        } catch {
          // icon stays missing; text labels and circles still render
        }
      }),
    );
    map.addSource('restos', { type: 'geojson', data: emptyFC() });
    map.addSource('orders', { type: 'geojson', data: emptyFC() });
    map.addSource('couriers', { type: 'geojson', data: emptyFC() });
    map.addSource('routes', { type: 'geojson', data: emptyFC() });
    map.addSource('ctrail', { type: 'geojson', data: emptyFC() });

    // Selected courier's full day: solid = already ridden, dashed = planned.
    map.addLayer({
      id: 'ctrail-past',
      type: 'line',
      source: 'ctrail',
      filter: ['==', ['get', 'phase'], 'past'],
      paint: {
        'line-color': ['get', 'c'],
        'line-width': 3.5,
        'line-opacity': 0.9,
      },
    });
    map.addLayer({
      id: 'ctrail-future',
      type: 'line',
      source: 'ctrail',
      filter: ['==', ['get', 'phase'], 'future'],
      paint: {
        'line-color': ['get', 'c'],
        'line-width': 2.5,
        'line-opacity': 0.5,
        'line-dasharray': [1.2, 1.6],
      },
    });
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
      id: 'restos-symbol',
      type: 'symbol',
      source: 'restos',
      layout: {
        'icon-image': 'resto-icon',
        'icon-size': 0.75,
        'icon-allow-overlap': true,
        ...iconLabelLayout(),
      },
      paint: labelPaint(),
    });
    map.addLayer({
      id: 'couriers-halo',
      type: 'circle',
      source: 'couriers',
      filter: ['==', ['get', 'sel'], 1],
      paint: {
        'circle-radius': 12,
        'circle-opacity': 0,
        'circle-stroke-color': ['get', 'hc'],
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': 0.9,
      },
    });
    map.addLayer({
      id: 'couriers-symbol',
      type: 'symbol',
      source: 'couriers',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': 0.75,
        'icon-allow-overlap': true,
        // A courier marker must NEVER be hidden by label collision: with
        // text-optional=false (default) MapLibre drops the whole symbol —
        // icon included — when its label loses a collision. Couriers stay
        // permanently traceable instead.
        'text-allow-overlap': true,
        'text-optional': true,
        ...iconLabelLayout(),
      },
      paint: labelPaint(),
    });
    map.addLayer({
      id: 'orders-label',
      type: 'symbol',
      source: 'orders',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-offset': [0, 1.35],
        'text-anchor': 'top',
        'text-max-width': 14,
        'text-letter-spacing': 0.1,
        'text-padding': 2,
      },
      paint: labelPaint(),
    });

    const show = (e: MapLayerMouseEvent) => {
      e.preventDefault(); // keep the background click from clearing the selection
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
    map.on('click', 'orders-circle', show);
    map.on('click', 'restos-symbol', show);
    // Clicking a courier selects it (click again or the map background to deselect).
    map.on('click', 'couriers-symbol', (e) => {
      e.preventDefault();
      const id = e.features?.[0]?.properties?.id;
      if (id == null) return;
      const d = dataRef.current;
      const next: CourierSelection = { mode: d.mode, courierId: Number(id) };
      const cur = d.selection;
      onSelectRef.current?.(
        cur && cur.mode === next.mode && cur.courierId === next.courierId ? null : next,
      );
    });
    map.on('mouseenter', 'couriers-symbol', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'couriers-symbol', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('click', (e) => {
      if (e.defaultPrevented) return;
      popupRef.current?.remove();
      onSelectRef.current?.(null);
    });
  }

  function iconLabelLayout(): SymbolLayerSpecification['layout'] {
    return {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-max-width': 14,
      'text-letter-spacing': 0.1,
      'text-padding': 2,
    };
  }

  function labelPaint(): SymbolLayerSpecification['paint'] {
    return {
      'text-color': '#3c3a45',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4,
    };
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
      void ensureSources(map).then(() => {
        refreshStatic();
        const sc = dataRef.current.scenario;
        if (sc && fittedRef.current !== sc) fitScenario(map, sc);
        refreshAt(dataRef.current.time);
      });
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
    if (scenario && fittedRef.current !== scenario) fitScenario(map, scenario);
    refreshStatic();
    refreshAt(dataRef.current.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, result, mode]);

  // Repaint halo + trail when the courier selection changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getSource('ctrail')) return;
    refreshAt(dataRef.current.time);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

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
          label: `Restaurant · ${r.name}`,
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
        const shortStatus =
          status === 'waiting'
            ? 'waiting'
            : status === 'cooking'
              ? 'cooking'
              : status === 'onTheWay'
                ? 'on the way'
                : 'delivered';
        orderFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: status === 'done' || status === 'onTheWay' ? o.cust : o.resto.pos },
          properties: {
            label: `Order #${o.id} · ${shortStatus}`,
            color: ORDER_COLORS[status],
            status,
            html: `<b>Order #${o.id}</b><br/><span class="popup-muted">${o.resto.name} · ${info}<br/>` +
              `promised ${fmtClock(d.scenario!, r.promised)} · actual ${fmtClock(d.scenario!, r.tDeliver)}</span>`,
          },
        });
      }
    }
    (map.getSource('orders') as GeoJSONSource).setData({ type: 'FeatureCollection', features: orderFeatures });

    // couriers — every courier is always rendered, never filtered out
    const courierIcon = mode === 'before' ? 'courier-before' : 'courier-after';
    const sel = d.selection && d.selection.mode === mode ? d.selection : null;
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
            id: c.id,
            sel: sel?.courierId === c.id ? 1 : 0,
            hc: COURIER_COLORS[mode],
            label: `Courier #${c.id} · ${active ? (active.kind === 'pickup' ? 'riding' : 'delivering') : 'idle'}`,
            icon: courierIcon,
          },
        });
      }
    } else if (d.scenario) {
      for (const c of d.scenario.couriers)
        courierFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: c.home },
          properties: {
            id: c.id,
            sel: sel?.courierId === c.id ? 1 : 0,
            hc: COURIER_COLORS[mode],
            label: `Courier #${c.id} · idle`,
            icon: courierIcon,
          },
        });
    }
    (map.getSource('couriers') as GeoJSONSource).setData({ type: 'FeatureCollection', features: courierFeatures });

    // selected courier's full-day trail: ridden segments solid, planned dashed
    const trailFeatures: GeoJSON.Feature[] = [];
    if (sel && d.result) {
      const segs = d.result.trails.get(sel.courierId) ?? ([] as TrailSeg[]);
      for (const s of segs) {
        const phase = s.t0 >= t ? 'future' : 'past'; // segment being ridden counts as past
        trailFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: s.coords },
          properties: { phase, c: COURIER_COLORS[mode] },
        });
      }
    }
    (map.getSource('ctrail') as GeoJSONSource)?.setData({ type: 'FeatureCollection', features: trailFeatures });

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
    getMap: () => mapRef.current,
  }));

  const badge = mode === 'before' ? 'BEFORE' : 'AFTER';
  const badgeDesc =
    mode === 'before' ? 'naive dispatch · crow-flies & flat ETA' : 'smart dispatch · road-time routing & honest ETA';

  return (
    <div className={`relative ${className ?? 'min-h-0 flex-1'}`}>
      <div ref={containerRef} className="h-full w-full" />
      <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">
        <div className="flex items-center overflow-hidden rounded-full border border-[var(--line)] bg-[var(--panel)] shadow-md">
          <span
            className={`px-2.5 py-1 text-[11px] font-bold tracking-wide text-white ${mode === 'before' ? 'bg-[var(--before)]' : 'bg-[var(--after)]'}`}
          >
            {badge}
          </span>
          <span className="px-2.5 py-1 text-[11px] text-[var(--muted)]">{badgeDesc}</span>
        </div>
      </div>
    </div>
  );
});

function fmtClock(sc: Scenario, tMin: number): string {
  const total = Math.round(sc.startMin + tMin);
  const hh = (18 + Math.floor(total / 60)) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
