// Shared feed plumbing for the CAL FIRE / FIRIS / NIFC active-perimeter service.
// Used by the interactive /api/fires route and by the autonomous capture job so
// both paths normalize and dedupe perimeters identically.

export const CA_PERIMETERS =
  "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/ArcGIS/rest/services/CA_Perimeters_NIFC_FIRIS_public_view/FeatureServer/0/query";

export const PERIMETER_FIELDS = [
  "GlobalID", "type", "source", "poly_DateCurrent", "mission", "incident_name",
  "incident_number", "area_acres", "description", "FireDiscoveryDate", "displayStatus",
].join(",");

export type Geometry = {
  type: "Point" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};
export type Feature = {
  type: "Feature";
  id?: string | number;
  geometry: Geometry | null;
  properties: Record<string, unknown>;
};
export type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function queryUrl(base: string, fields: string, where: string, simplify = false) {
  const params = new URLSearchParams({
    where,
    outFields: fields,
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: "2000",
  });
  if (simplify) {
    params.set("maxAllowableOffset", "0.00035");
    params.set("geometryPrecision", "5");
  }
  return `${base}?${params.toString()}`;
}

export async function getGeoJson(url: string, source: string) {
  const response = await fetch(url, {
    headers: { Accept: "application/geo+json, application/json" },
  });
  if (!response.ok) throw new Error(`${source} returned ${response.status}`);
  const data = (await response.json()) as FeatureCollection & { error?: { message?: string } };
  if (data.error) throw new Error(data.error.message ?? `${source} query failed`);
  return data;
}

export function normalizedId(value: unknown) {
  return text(value)?.replace(/[{}]/g, "").toUpperCase() ?? null;
}

export function normalizedName(value: unknown) {
  return (text(value) ?? "")
    .toUpperCase()
    .replace(/\b(FIRE|WILDFIRE|INCIDENT)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizePerimeter(feature: Feature): Feature {
  const p = feature.properties;
  const name = text(p.incident_name) ?? text(p.mission) ?? "Unnamed perimeter";
  const incidentId = text(p.incident_number);
  const acres = number(p.area_acres);
  return {
    ...feature,
    properties: {
      ...p,
      poly_IncidentName: name,
      poly_GISAcres: acres,
      poly_Acres_AutoCalc: acres,
      poly_PolygonDateTime: number(p.poly_DateCurrent),
      poly_IRWINID: incidentId,
      attr_IrwinID: incidentId,
      attr_IncidentName: name,
      attr_IncidentSize: acres,
      attr_POOState: "US-CA",
      perimeterSource: text(p.source) ?? "CAL FIRE / FIRIS / NIFC",
      perimeterType: text(p.type) ?? "Fire perimeter",
    },
  };
}

function oneEditApart(a: string, b: string) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function likelySamePerimeter(a: Feature, b: Feature) {
  const aId = normalizedId(a.properties.poly_IRWINID) ?? normalizedId(a.properties.attr_IrwinID);
  const bId = normalizedId(b.properties.poly_IRWINID) ?? normalizedId(b.properties.attr_IrwinID);
  if (aId && bId && aId === bId) return true;
  const aName = normalizedName(a.properties.attr_IncidentName ?? a.properties.poly_IncidentName);
  const bName = normalizedName(b.properties.attr_IncidentName ?? b.properties.poly_IncidentName);
  return Boolean(aName && bName && oneEditApart(aName, bName));
}

export function dedupePerimeters(collection: FeatureCollection) {
  const latest: Feature[] = [];
  for (const raw of collection.features) {
    if (raw.geometry?.type !== "Polygon" && raw.geometry?.type !== "MultiPolygon") continue;
    const feature = normalizePerimeter(raw);
    const existingIndex = latest.findIndex((candidate) => likelySamePerimeter(candidate, feature));
    if (existingIndex === -1) { latest.push(feature); continue; }
    const existing = latest[existingIndex];
    const incomingDate = number(feature.properties.poly_PolygonDateTime) ?? 0;
    const existingDate = number(existing.properties.poly_PolygonDateTime) ?? number(existing.properties.poly_DateCurrent) ?? 0;
    const incomingAcres = number(feature.properties.poly_Acres_AutoCalc) ?? number(feature.properties.poly_GISAcres) ?? 0;
    const existingAcres = number(existing.properties.poly_Acres_AutoCalc) ?? number(existing.properties.poly_GISAcres) ?? 0;
    if (incomingDate > existingDate || (incomingDate === existingDate && incomingAcres > existingAcres)) {
      latest[existingIndex] = feature;
    }
  }
  return { type: "FeatureCollection", features: latest } satisfies FeatureCollection;
}

export function activeFireIdentity(feature: Feature) {
  const irwinId = normalizedId(feature.properties.poly_IRWINID) ?? normalizedId(feature.properties.attr_IrwinID);
  if (!irwinId) return null;
  const incidentName = text(feature.properties.attr_IncidentName) ?? text(feature.properties.poly_IncidentName) ?? "Unnamed fire";
  return { irwinId, incidentName };
}
