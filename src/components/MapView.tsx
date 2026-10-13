'use client';

import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, AttributionControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export const BERLIN_CENTER: [number, number] = [13.405, 52.52];

export function makeMap(container: HTMLElement): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: BERLIN_CENTER,
    zoom: 11.5,
    attributionControl: false,
  });
  map.addControl(new AttributionControl({ compact: true }));
  return map;
}

/** Thin wrapper used by the home page. */
export default function MapView({
  onMapReady,
  className,
}: {
  onMapReady?: (map: MapLibreMap) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = makeMap(containerRef.current);
    mapRef.current = map;
    map.on('load', () => onMapReady?.(map));
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className={className} />;
}
