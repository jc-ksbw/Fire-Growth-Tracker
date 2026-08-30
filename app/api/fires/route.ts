import {
  CA_PERIMETERS,
  PERIMETER_FIELDS,
  activeFireIdentity,
  dedupePerimeters,
  getGeoJson,
  normalizedId,
  normalizedName,
  queryUrl,
} from "@/lib/fire-feeds";
import { markFiresActive, purgePerimeterHistory, savePerimeterSnapshots } from "@/lib/perimeter-store";
import { PERIMETER_RETENTION_MS } from "@/lib/capture";

const NIFC_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const NOAA_HMS_HOTSPOTS =
  "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Fire_Detections_(v1)/FeatureServer/0/query";
const CA_NEW_STARTS =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/WFTIIC_IA_INCIDENTS_V1_PublicView_2/FeatureServer/0/query";
const CAL_OES_EVACUATIONS =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/ArcGIS/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query";

type Geometry = {
  type: "Point" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};
type Feature = {
  type: "Feature";
  id?: string | number;
  geometry: Geometry | null;
  properties: Record<string, unknown>;
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

const emptyCollection = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

function yearDayCode(date: Date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - start) / 86_400_000) + 1;
  return year * 1000 + day;
}

function hmsQueryUrl(where: string, options: { countOnly?: boolean; offset?: number } = {}) {
  const params = new URLSearchParams({
    where,
    geometry: "-124.48,32.5,-114.13,42.1",
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

function hmsObservedAt(yearDayValue: unknown, timeValue: unknown) {
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

async function getNoaaHmsHotspots() {
  const now = new Date();
  const dayCodes = [0, 1, 2].map((daysAgo) => yearDayCode(new Date(now.getTime() - daysAgo * 86_400_000)));
  const where = `YearDay IN (${dayCodes.join(",")})`;
  const countResponse = await fetch(hmsQueryUrl(where, { countOnly: true }), { headers: { Accept: "application/json" } });
  if (!countResponse.ok) throw new Error(`NOAA HMS hotspots returned ${countResponse.status}`);
  const countPayload = await countResponse.json() as { count?: number; error?: { message?: string } };
  if (countPayload.error) throw new Error(countPayload.error.message ?? "NOAA HMS hotspots failed");
  const count = Math.max(0, countPayload.count ?? 0);
  const pageCount = Math.min(Math.ceil(count / 2000), 5);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, page) =>
      getGeoJson(hmsQueryUrl(where, { offset: page * 2000 }), `NOAA HMS hotspots page ${page + 1}`)),
  );
  const fetchedAt = Date.now();
  const features = pages.flatMap((page) => page.features).map((feature) => {
    const observedAt = hmsObservedAt(feature.properties.YearDay, feature.properties.Time);
    return {
      ...feature,
      properties: {
        ...feature.properties,
        observedAt,
        hours_old: observedAt === null ? 48 : Math.max(0, (fetchedAt - observedAt) / 3_600_000),
        frp: number(feature.properties.FRP) ?? 0,
        satellite: text(feature.properties.Satellite),
        method: text(feature.properties.Method),
        hotspotSource: "NOAA HMS",
      },
    } satisfies Feature;
  });
  return { type: "FeatureCollection", features } satisfies FeatureCollection;
}

function point(feature: Feature): [number, number] | null {
  if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
  const [longitude, latitude] = feature.geometry.coordinates;
  return typeof longitude === "number" && typeof latitude === "number" ? [longitude, latitude] : null;
}

function distanceKm(a: [number, number], b: [number, number]) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const CALIFORNIA_OUTLINE: Array<[number, number]> = [
  [-124.42, 42.01], [-120.0, 42.01], [-120.0, 39.0], [-119.1, 37.2],
  [-117.0, 35.0], [-114.63, 35.0], [-114.48, 34.15], [-114.72, 32.72],
  [-117.12, 32.53], [-117.9, 33.2], [-118.5, 33.75], [-119.7, 34.4],
  [-120.65, 35.1], [-121.2, 36.0], [-121.95, 36.65], [-122.5, 37.8],
  [-123.8, 39.0], [-124.42, 42.01],
];

function isInCalifornia([longitude, latitude]: [number, number]) {
  let inside = false;
  for (let i = 0, j = CALIFORNIA_OUTLINE.length - 1; i < CALIFORNIA_OUTLINE.length; j = i, i += 1) {
    const [xi, yi] = CALIFORNIA_OUTLINE[i];
    const [xj, yj] = CALIFORNIA_OUTLINE[j];
    if (yi > latitude !== yj > latitude
      && longitude < ((xj - xi) * (latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}

function incidentDate(feature: Feature) {
  return number(feature.properties.FireDiscoveryDateTime)
    ?? number(feature.properties.CreatedOnDateTime)
    ?? number(feature.properties.ModifiedOnDateTime_dt);
}

function ids(feature: Feature) {
  return [
    feature.properties.IrwinID,
    feature.properties.UniqueFireIdentifier,
    feature.properties.FireIdentifier,
    feature.properties.IncidentNumber,
  ].map(normalizedId).filter((value): value is string => Boolean(value));
}

function isGenericName(value: unknown) {
  const original = (text(value) ?? "").toUpperCase();
  const normalized = normalizedName(value);
  return !normalized
    || original.includes("PULSEPOINT-REPORTED")
    || original.includes("REPORTED FIRE")
    || original.includes("HEAT SOURCE")
    || ["VEGETATION", "BRUSH", "UNKNOWN", "UNNAMED", "NEW START"].includes(normalized);
}

function sameExplicitIncident(a: Feature, b: Feature) {
  const aIds = new Set(ids(a));
  return ids(b).some((id) => aIds.has(id));
}

function likelySameIncident(a: Feature, b: Feature) {
  if (sameExplicitIncident(a, b)) return true;
  const aPoint = point(a);
  const bPoint = point(b);
  if (!aPoint || !bPoint) return false;
  const kilometers = distanceKm(aPoint, bPoint);
  const aDate = incidentDate(a);
  const bDate = incidentDate(b);
  const hours = aDate && bDate ? Math.abs(aDate - bDate) / 3_600_000 : Number.POSITIVE_INFINITY;
  const aName = a.properties.IncidentName;
  const bName = b.properties.IncidentName;
  const bothNamed = !isGenericName(aName) && !isGenericName(bName);

  if (bothNamed) {
    return normalizedName(aName) === normalizedName(bName) && kilometers <= 16 && hours <= 72;
  }

  const sources = `${text(a.properties.DataSource) ?? ""} ${text(b.properties.DataSource) ?? ""}`.toUpperCase();
  if (sources.includes("NOAA") || sources.includes("GOES") || sources.includes("FIREGUARD")) {
    return kilometers <= 5 && hours <= 18;
  }
  return kilometers <= 2 && hours <= 6;
}

function cwiName(feature: Feature) {
  const reported = text(feature.properties.IncidentName);
  if (reported) return reported;
  const source = text(feature.properties.DataSource) ?? "California Wildfire Intel";
  return source.toUpperCase().includes("NOAA") ? "Satellite-detected heat source" : `${source}-reported fire`;
}

function canonicalId(feature: Feature, prefix: string) {
  return normalizedId(feature.properties.IrwinID)
    ?? normalizedId(feature.properties.UniqueFireIdentifier)
    ?? normalizedId(feature.properties.FireIdentifier)
    ?? normalizedId(feature.properties.globalid)
    ?? `${prefix}-${feature.id ?? feature.properties.OBJECTID ?? feature.properties.objectid ?? "UNKNOWN"}`;
}

function nifcFeature(feature: Feature): Feature {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      CanonicalID: canonicalId(feature, "NIFC"),
      isNew: false,
      sources: ["NIFC WFIGS"],
      sourceReports: 1,
      reportingStatus: "CONFIRMED",
    },
  };
}

function cwiFeature(feature: Feature): Feature {
  const source = text(feature.properties.DataSource) ?? "California Wildfire Intel";
  return {
    ...feature,
    properties: {
      ...feature.properties,
      IncidentName: cwiName(feature),
      IncidentSize: number(feature.properties.IncidentSize),
      PercentContained: null,
      POOState: "US-CA",
      POOCounty: text(feature.properties.County)?.replace(/\s+County$/i, "") ?? null,
      UniqueFireIdentifier: text(feature.properties.FireIdentifier),
      CanonicalID: canonicalId(feature, "CWI"),
      isNew: true,
      sources: [`CA Wildfire Intel • ${source}`],
      sourceReports: 1,
      reportingStatus: normalizedId(feature.properties.IrwinID) ? "CONFIRMED" : "PRELIMINARY",
    },
  };
}

function mergeFire(target: Feature, incoming: Feature) {
  const targetSources = Array.isArray(target.properties.sources) ? target.properties.sources as string[] : [];
  const incomingSources = Array.isArray(incoming.properties.sources) ? incoming.properties.sources as string[] : [];
  target.properties.sources = [...new Set([...targetSources, ...incomingSources])];
  target.properties.sourceReports = (number(target.properties.sourceReports) ?? 1) + (number(incoming.properties.sourceReports) ?? 1);
  target.properties.isNew = target.properties.isNew === true || incoming.properties.isNew === true;
  if (!text(target.properties.IncidentName) || isGenericName(target.properties.IncidentName)) {
    target.properties.IncidentName = incoming.properties.IncidentName;
  }
  for (const key of [
    "IncidentSize", "DiscoveryAcres", "PercentContained", "FireDiscoveryDateTime",
    "POOCounty", "POOCity", "IrwinID", "UniqueFireIdentifier", "FireCause",
  ]) {
    if (target.properties[key] === null || target.properties[key] === undefined || target.properties[key] === "") {
      target.properties[key] = incoming.properties[key];
    }
  }
  if (target.properties.reportingStatus !== "CONFIRMED" && incoming.properties.reportingStatus === "CONFIRMED") {
    target.properties.reportingStatus = "CONFIRMED";
  }
}

function dedupeFires(nifc: FeatureCollection, cwi: FeatureCollection) {
  const canonical: Feature[] = [];
  for (const raw of nifc.features) {
    if (raw.geometry?.type !== "Point") continue;
    const incoming = nifcFeature(raw);
    const match = canonical.find((candidate) => likelySameIncident(candidate, incoming));
    if (match) mergeFire(match, incoming); else canonical.push(incoming);
  }
  for (const raw of cwi.features) {
    if (raw.geometry?.type !== "Point") continue;
    const incoming = cwiFeature(raw);
    const match = canonical.find((candidate) => likelySameIncident(candidate, incoming));
    if (match) mergeFire(match, incoming); else canonical.push(incoming);
  }
  return { type: "FeatureCollection", features: canonical } satisfies FeatureCollection;
}

function evacuationClass(statusValue: unknown) {
  const status = (text(statusValue) ?? "").toUpperCase();
  if (status.includes("SHELTER")) return "shelter";
  if (status.includes("ORDER") || status.includes("LEVEL 3")) return "order";
  if (status.includes("WARNING") || status.includes("LEVEL 2")) return "warning";
  if (status.includes("ADVISORY") || status.includes("VOLUNTARY") || status.includes("LEVEL 1")) return "advisory";
  return "other";
}

function isActiveEvacuation(statusValue: unknown) {
  const status = (text(statusValue) ?? "").toUpperCase();
  return Boolean(status)
    && !status.includes("NORMAL")
    && !status.includes("CLEAR")
    && !status.includes("LIFTED")
    && !status.includes("NO EVACUATION");
}

function dedupeEvacuations(collection: FeatureCollection) {
  const priority: Record<string, number> = { order: 4, shelter: 3, warning: 2, advisory: 1, other: 0 };
  const byZone = new Map<string, Feature>();
  for (const feature of collection.features) {
    if (!feature.geometry || !isActiveEvacuation(feature.properties.STATUS)) continue;
    const statusClass = evacuationClass(feature.properties.STATUS);
    const key = normalizedId(feature.properties.ZONE_ID)
      ?? normalizedId(feature.properties.GlobalID)
      ?? `EVAC-${feature.id ?? feature.properties.OBJECTID}`;
    const prepared: Feature = { ...feature, properties: { ...feature.properties, evacuationClass: statusClass } };
    const existing = byZone.get(key);
    if (!existing) { byZone.set(key, prepared); continue; }
    const existingClass = text(existing.properties.evacuationClass) ?? "other";
    const incomingDate = number(prepared.properties.EDIT_DATE) ?? number(prepared.properties.EditDate) ?? 0;
    const existingDate = number(existing.properties.EDIT_DATE) ?? number(existing.properties.EditDate) ?? 0;
    if (priority[statusClass] > priority[existingClass] || (priority[statusClass] === priority[existingClass] && incomingDate > existingDate)) {
      byZone.set(key, prepared);
    }
  }
  return { type: "FeatureCollection", features: [...byZone.values()] } satisfies FeatureCollection;
}

export async function GET() {
  const incidentFields = [
    "IncidentName", "IncidentSize", "DiscoveryAcres", "FireDiscoveryDateTime",
    "PercentContained", "POOState", "POOCounty", "POOCity", "IrwinID",
    "UniqueFireIdentifier", "ModifiedOnDateTime_dt", "IncidentTypeCategory", "FireCause",
  ].join(",");
  const cwiFields = [
    "IrwinID", "IncidentName", "InitialLatitude", "InitialLongitude", "County", "Agency",
    "FireIdentifier", "IncidentSize", "CreatedOnDateTime", "DataSource", "IncidentNumber",
    "FireDiscoveryDateTime", "UNIT", "UNITCODE", "REGION", "FireMAR", "globalid",
  ].join(",");
  const evacuationFields = [
    "COUNTY", "CITY", "ZONE_NAME", "ZONE_ID", "STATUS", "EVENT_TYPE", "CRITICAL_INFO",
    "PUBLIC_INFO", "EDIT_DATE", "STATEWIDE_LAST_UPDATED", "NOTES", "GlobalID", "EditDate",
  ].join(",");

  const results = await Promise.allSettled([
    getGeoJson(queryUrl(NIFC_INCIDENTS, incidentFields, "IncidentTypeCategory='WF' AND POOState='US-CA'"), "NIFC incidents"),
    getGeoJson(queryUrl(CA_PERIMETERS, PERIMETER_FIELDS, "displayStatus='Active'", true), "California fire perimeters"),
    getGeoJson(queryUrl(CA_NEW_STARTS, cwiFields, "1=1"), "CA Wildfire Intel"),
    getGeoJson(queryUrl(CAL_OES_EVACUATIONS, evacuationFields, "STATUS IS NOT NULL AND STATUS <> 'Normal'", true), "CAL OES evacuations"),
    getNoaaHmsHotspots(),
  ]);

  const value = (index: number) => {
    const result = results[index];
    return result.status === "fulfilled" ? result.value : emptyCollection();
  };
  const nifc = value(0);
  const perimeters = dedupePerimeters(value(1));
  const cwi = value(2);
  const evacuations = dedupeEvacuations(value(3));
  const hotspots = {
    type: "FeatureCollection",
    features: value(4).features.filter((feature) => {
      const coordinates = point(feature);
      return coordinates ? isInCalifornia(coordinates) : false;
    }),
  } satisfies FeatureCollection;
  if (results[0].status === "rejected" && results[2].status === "rejected") {
    const message = results[0].reason instanceof Error ? results[0].reason.message : "California fire feeds are unavailable";
    return Response.json({ error: message }, { status: 502 });
  }
  const fires = dedupeFires(nifc, cwi);

  let snapshotsSaved = 0;
  let historyAvailable = true;
  try {
    snapshotsSaved = await savePerimeterSnapshots(perimeters.features as Parameters<typeof savePerimeterSnapshots>[0]);
    const active = perimeters.features
      .map((feature) => activeFireIdentity(feature as Parameters<typeof activeFireIdentity>[0]))
      .filter((identity): identity is { irwinId: string; incidentName: string } => identity !== null);
    await markFiresActive(active, Date.now());
    await purgePerimeterHistory(Date.now() - PERIMETER_RETENTION_MS);
  } catch {
    historyAvailable = false;
  }

  const feedStatus = {
    nifcIncidents: results[0].status === "fulfilled",
    caPerimeters: results[1].status === "fulfilled",
    caWildfireIntel: results[2].status === "fulfilled",
    calOesEvacuations: results[3].status === "fulfilled",
    viirsHotspots: results[4].status === "fulfilled",
  };

  return Response.json(
    {
      fires,
      perimeters,
      evacuations,
      hotspots,
      fetchedAt: Date.now(),
      historyAvailable,
      snapshotsSaved,
      feedStatus,
      sources: {
        incidents: "NIFC WFIGS current incidents",
        newStarts: "California Wildfire Intel (IRWIN, PulsePoint, NOAA and CHP)",
        perimeters: "CAL FIRE California Perimeters (CAL FIRE intelligence, FIRIS and NIFC)",
        evacuations: "CAL OES California Active Evacuation Zones",
        hotspots: "NOAA Hazard Mapping System satellite fire detections",
        satellite: "NASA GIBS GOES ABI Fire Temperature",
      },
    },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=180" } },
  );
}
