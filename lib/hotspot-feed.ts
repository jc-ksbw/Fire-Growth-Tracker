import { getGeoJson, type Feature, type FeatureCollection } from "./fire-feeds";

const NOAA_HMS_HOTSPOTS =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Fire_Detections_(v1)/FeatureServer/0/query";
const CALIFORNIA_BOUNDS: Bounds = [-124.48, 32.5, -114.13, 42.1];

export type Bounds = [west: number, south: number, east: number, north: number];

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function yearDayCode(date: Date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000) + 1;
  return year * 1000 + day;
}

function recentDayCodes(days: number) {
  const now = Date.now();
  return Array.from({ length: Math.max(1, Math.min(days, 20)) }, (_, daysAgo) =>
    yearDayCode(new Date(now - daysAgo * 86_400_000)));
}

function queryUrl(where: string, bounds: Bounds, options: { countOnly?: boolean; offset?: number } = {}) {
  const params = new URLSearchParams({
    where,
    geometry: bounds.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  if (options.countOnly) {
    params.set("returnCountOnly", "true");
    params.set("f", "json");
  } else {
    params.set("outFields", "FID,Lon,Lat,YearDay,Time,Satellite,Method,Ecosystem,FRP");
    params.set("returnGeometry", "true");
    params.set("outSR", "4326");
    params.set("orderByFields", "FID ASC");
    params.set("resultOffset", String(options.offset ?? 0));
    params.set("resultRecordCount", "2000");
    params.set("f", "geojson");
  }
  return `${NOAA_HMS_HOTSPOTS}?${params.toString()}`;
}

function observedAt(yearDayValue: unknown, timeValue: unknown) {
  const yearDay = number(yearDayValue);
  if (yearDay === null) return null;
  const year = Math.floor(yearDay / 1000);
  const day = yearDay % 1000;
  const digits = (text(timeValue) ?? "0000").padStart(4, "0");
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  const value = Date.UTC(year, 0, day, Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0);
  return Number.isFinite(value) ? value : null;
}

function point(feature: Feature): [number, number] | null {
  if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return typeof longitude === "number" && typeof latitude === "number" ? [longitude, latitude] : null;
}

async function getHotspots(bounds: Bounds, days: number, preserveDailyCells: boolean) {
  const dayCodes = recentDayCodes(days);
  const where = `YearDay IN (${dayCodes.join(",")})`;
  const countResponse = await fetch(queryUrl(where, bounds, { countOnly: true }), { headers: { Accept: "application/json" } });
  if (!countResponse.ok) throw new Error(`NOAA HMS hotspots returned ${countResponse.status}`);
  const countPayload = await countResponse.json() as { count?: number; error?: { message?: string } };
  if (countPayload.error) throw new Error(countPayload.error.message ?? "NOAA HMS hotspots failed");
  const count = Math.max(0, countPayload.count ?? 0);
  const pageCount = Math.min(Math.ceil(count / 2000), preserveDailyCells ? 8 : 5);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, page) =>
      getGeoJson(queryUrl(where, bounds, { offset: page * 2000 }), `NOAA HMS hotspots page ${page + 1}`)),
  );
  const fetchedAt = Date.now();
  const cells = new Map<string, Feature>();
  for (const feature of pages.flatMap((page) => page.features)) {
    const coordinates = point(feature);
    if (!coordinates) continue;
    const time = observedAt(feature.properties.YearDay, feature.properties.Time);
    const dayKey = preserveDailyCells ? `${feature.properties.YearDay}:` : "";
    const key = `${dayKey}${Math.round(coordinates[0] * 200)}:${Math.round(coordinates[1] * 200)}`;
    const prepared: Feature = {
      ...feature,
      properties: {
        ...feature.properties,
        observedAt: time,
        hours_old: time === null ? days * 24 : Math.max(0, (fetchedAt - time) / 3_600_000),
        frp: number(feature.properties.FRP) ?? 0,
        satellite: text(feature.properties.Satellite),
        method: text(feature.properties.Method),
        hotspotSource: "NOAA HMS",
      },
    };
    const existing = cells.get(key);
    const existingTime = number(existing?.properties.observedAt) ?? 0;
    const incomingTime = number(prepared.properties.observedAt) ?? 0;
    if (!existing || incomingTime >= existingTime) {
      prepared.properties.frp = Math.max(number(existing?.properties.frp) ?? 0, number(prepared.properties.frp) ?? 0);
      cells.set(key, prepared);
    } else {
      existing.properties.frp = Math.max(number(existing.properties.frp) ?? 0, number(prepared.properties.frp) ?? 0);
    }
  }
  return { type: "FeatureCollection", features: [...cells.values()] } satisfies FeatureCollection;
}

export function getNoaaHmsHotspots() {
  return getHotspots(CALIFORNIA_BOUNDS, 3, false);
}

export function getHistoricalHotspots(bounds: Bounds, days = 20) {
  return getHotspots(bounds, days, true);
}
