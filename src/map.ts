// MapLibre setup and overlay management.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { BandGeometry } from './band';
import type { LatLon } from './geo';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TAIWAN_CENTER: [number, number] = [121.0, 23.7];

export interface MapHandles {
  map: maplibregl.Map;
  setStructure(p: LatLon | null): void;
  setOverlays(geom: BandGeometry | null): void;
  setSightline(structure: LatLon | null, spot: LatLon | null): void;
  setSpot(p: LatLon | null, occluded: boolean): void;
  setBodyKind(kind: 'sun' | 'moon'): void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const COLORS = {
  sun: { band: '#f59e0b', line: '#d97706' },
  moon: { band: '#60a5fa', line: '#2563eb' },
};

export function createMap(container: HTMLElement, onTap: (p: LatLon) => void): MapHandles {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: TAIWAN_CENTER,
    zoom: 7,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(
    new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
    'top-right',
  );

  let marker: maplibregl.Marker | null = null;
  let kind: 'sun' | 'moon' = 'sun';
  let pendingGeom: BandGeometry | null = null;

  // Defer single taps so a double-click zoom doesn't also re-place the pin.
  let tapTimer: ReturnType<typeof setTimeout> | null = null;
  map.on('click', (e) => {
    if (tapTimer) clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      tapTimer = null;
      onTap({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    }, 300);
  });
  map.on('dblclick', () => {
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  });

  map.on('load', () => {
    map.addSource('band', { type: 'geojson', data: EMPTY });
    map.addSource('clear-line', { type: 'geojson', data: EMPTY });
    map.addSource('occluded-line', { type: 'geojson', data: EMPTY });
    map.addSource('sightline', { type: 'geojson', data: EMPTY });
    map.addSource('spot', { type: 'geojson', data: EMPTY });

    map.addLayer({
      id: 'band-fill',
      type: 'fill',
      source: 'band',
      paint: { 'fill-color': COLORS.sun.band, 'fill-opacity': 0.22 },
    });
    map.addLayer({
      id: 'clear-line',
      type: 'line',
      source: 'clear-line',
      paint: { 'line-color': COLORS.sun.line, 'line-width': 2.5 },
    });
    map.addLayer({
      id: 'occluded-line',
      type: 'line',
      source: 'occluded-line',
      paint: { 'line-color': '#9ca3af', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'sightline',
      type: 'line',
      source: 'sightline',
      paint: { 'line-color': '#111827', 'line-width': 1, 'line-dasharray': [1, 2], 'line-opacity': 0.6 },
    });
    map.addLayer({
      id: 'spot-halo',
      type: 'circle',
      source: 'spot',
      paint: {
        'circle-radius': 11,
        'circle-color': ['case', ['get', 'occluded'], '#9ca3af', COLORS.sun.line],
        'circle-opacity': 0.3,
      },
    });
    map.addLayer({
      id: 'spot-dot',
      type: 'circle',
      source: 'spot',
      paint: {
        'circle-radius': 5,
        'circle-color': ['case', ['get', 'occluded'], '#6b7280', COLORS.sun.line],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    if (pendingGeom) setOverlays(pendingGeom);
  });

  const src = (id: string) => map.getSource(id) as maplibregl.GeoJSONSource | undefined;

  function setOverlays(geom: BandGeometry | null): void {
    if (!map.isStyleLoaded() && geom) {
      pendingGeom = geom;
      return;
    }
    src('band')?.setData(geom ? { type: 'FeatureCollection', features: geom.band } : EMPTY);
    src('clear-line')?.setData(geom ? { type: 'FeatureCollection', features: geom.clearLines } : EMPTY);
    src('occluded-line')?.setData(geom ? { type: 'FeatureCollection', features: geom.occludedLines } : EMPTY);
  }

  function setSightline(structure: LatLon | null, spot: LatLon | null): void {
    const data: GeoJSON.FeatureCollection =
      structure && spot
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [structure.lon, structure.lat],
                    [spot.lon, spot.lat],
                  ],
                },
              },
            ],
          }
        : EMPTY;
    src('sightline')?.setData(data);
  }

  function setSpot(p: LatLon | null, occluded: boolean): void {
    const data: GeoJSON.FeatureCollection = p
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: { occluded }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }],
        }
      : EMPTY;
    src('spot')?.setData(data);
  }

  function setStructure(p: LatLon | null): void {
    if (!p) {
      marker?.remove();
      marker = null;
      return;
    }
    if (!marker) {
      marker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([p.lon, p.lat]).addTo(map);
    } else {
      marker.setLngLat([p.lon, p.lat]);
    }
  }

  function setBodyKind(k: 'sun' | 'moon'): void {
    kind = k;
    if (!map.isStyleLoaded()) return;
    map.setPaintProperty('band-fill', 'fill-color', COLORS[kind].band);
    map.setPaintProperty('clear-line', 'line-color', COLORS[kind].line);
    map.setPaintProperty('spot-halo', 'circle-color', ['case', ['get', 'occluded'], '#9ca3af', COLORS[kind].line]);
    map.setPaintProperty('spot-dot', 'circle-color', ['case', ['get', 'occluded'], '#6b7280', COLORS[kind].line]);
  }

  return { map, setStructure, setOverlays, setSightline, setSpot, setBodyKind };
}
