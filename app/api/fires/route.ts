import {
  CA_PERIMETERS,
  PERIMETER_FIELDS,
  activeFireIdentity,
  dedupePerimeters,
  getGeoJson,
  normalizedId,
  normalizedName,
  normalizePerimeters,
  queryUrl,
} from "@/lib/fire-feeds";
import { markFiresActive, purgePerimeterHistory, savePerimeterSnapshots, seedHistoricalPerimeters } from "@/lib/perimeter-store";
import { PERIMETER_RETENTION_MS } from "@/lib/capture";
import { getNoaaHmsHotspots } from "@/lib/hotspot-feed";
import { getActiveEvacuations } from "@/lib/evacuation-feed";
import { saveEvacuationEvents } from "@/lib/evacuation-store";
import { getCalFireActiveIncidents } from "@/lib/cal-fire-incidents";

const NIFC_INCIDENTS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query";
const CA_NEW_STARTS =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/WFTIIC_IA_INCIDENTS_V1_PublicView_2/FeatureServer/0/query";

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

function calFireFeature(feature: Feature, rawPerimeters: FeatureCollection) {
  const calFireId = normalizedId(feature.properties.CalFireUniqueId);
  const bridge = rawPerimeters.features
    .filter((perimeter) => normalizedId(perimeter.properties.websiteId) === calFireId)
    .sort((a, b) => (number(b.properties.poly_DateCurrent) ?? 0) - (number(a.properties.poly_DateCurrent) ?? 0))[0];
  const irwinId = normalizedId(bridge?.properties.incident_number);
  return {
    ...feature,
    properties: {
      ...feature.properties,
      IrwinID: irwinId,
      UniqueFireIdentifier: irwinId,
      CanonicalID: irwinId ?? calFireId ?? feature.properties.CanonicalID,
    },
  };
}

function mergeCalFire(target: Feature, incoming: Feature) {
  mergeFire(target, incoming);
  // CAL FIRE's incident record is the authoritative reported acreage and
  // containment for this California-only workflow, even when NIFC lags.
  for (const key of [
    "IncidentSize", "PercentContained", "ModifiedOnDateTime_dt", "CalFireUniqueId",
    "CalFireUrl", "ReportedAcresSource", "ReportedAcresUpdatedAt", "regionalWorkflow",
  ]) {
    const value = incoming.properties[key];
    if (value !== null && value !== undefined && value !== "") target.properties[key] = value;
  }
}

function matchingPerimeter(fire: Feature, perimeters: FeatureCollection) {
  const fireIds = new Set(ids(fire));
  const fireName = normalizedName(fire.properties.IncidentName);
  return perimeters.features.find((perimeter) => {
    const perimeterId = normalizedId(perimeter.properties.poly_IRWINID ?? perimeter.properties.attr_IrwinID);
    if (perimeterId && fireIds.has(perimeterId)) return true;
    return Boolean(fireName && fireName === normalizedName(perimeter.properties.poly_IncidentName ?? perimeter.properties.attr_IncidentName));
  });
}

function dedupeFires(nifc: FeatureCollection, cwi: FeatureCollection, calFire: FeatureCollection, rawPerimeters: FeatureCollection) {
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
  // California-specific: CAL FIRE records are merged only into the already
  // California-filtered incident collection. A future national route must not
  // run this loop for incidents outside US-CA.
  for (const raw of calFire.features) {
    const incoming = calFireFeature(raw, rawPerimeters);
    const match = canonical.find((candidate) => likelySameIncident(candidate, incoming));
    if (match) mergeCalFire(match, incoming); else canonical.push(incoming);
  }
  return { type: "FeatureCollection", features: canonical } satisfies FeatureCollection;
}

function applyLatestMappedAcreage(fires: FeatureCollection, perimeters: FeatureCollection) {
  for (const fire of fires.features) {
    const perimeter = matchingPerimeter(fire, perimeters);
    if (!perimeter) continue;
    const mappedAcres = number(perimeter.properties.poly_Acres_AutoCalc) ?? number(perimeter.properties.poly_GISAcres);
    const mappedAt = number(perimeter.properties.poly_PolygonDateTime ?? perimeter.properties.poly_DateCurrent);
    fire.properties.MappedAcres = mappedAcres;
    fire.properties.MappedAcresUpdatedAt = mappedAt;
    if (fire.properties.ReportedAcresSource !== "CAL FIRE" && mappedAcres !== null) {
      fire.properties.NifcIncidentSize = number(fire.properties.IncidentSize);
      fire.properties.IncidentSize = mappedAcres;
      fire.properties.ReportedAcresSource = "CAL FIRE perimeter";
      fire.properties.ReportedAcresUpdatedAt = mappedAt;
    }
  }
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
  const results = await Promise.allSettled([
    getGeoJson(queryUrl(NIFC_INCIDENTS, incidentFields, "IncidentTypeCategory='WF' AND POOState='US-CA'"), "NIFC incidents"),
    getGeoJson(queryUrl(CA_PERIMETERS, PERIMETER_FIELDS, "displayStatus='Active'", true), "California fire perimeters"),
    getGeoJson(queryUrl(CA_NEW_STARTS, cwiFields, "1=1"), "CA Wildfire Intel"),
    getCalFireActiveIncidents(),
    getActiveEvacuations(),
    getNoaaHmsHotspots(),
  ]);

  const value = (index: number) => {
    const result = results[index];
    return result.status === "fulfilled" ? result.value : emptyCollection();
  };
  const nifc = value(0);
  const rawPerimeters = value(1);
  const historicalPerimeters = normalizePerimeters(rawPerimeters);
  const perimeters = dedupePerimeters(rawPerimeters);
  const cwi = value(2);
  const calFire = value(3);
  const evacuations = value(4);
  // NOAA is already queried with a California bounding envelope. The precise
  // selected-DMA polygon is applied in the client; a simplified state outline
  // incorrectly excluded the Big Sur coast, including Timber and Plaskett.
  const hotspots = value(5);
  if (results[0].status === "rejected" && results[2].status === "rejected") {
    const message = results[0].reason instanceof Error ? results[0].reason.message : "California fire feeds are unavailable";
    return Response.json({ error: message }, { status: 502 });
  }
  const fires = dedupeFires(nifc, cwi, calFire, rawPerimeters);
  applyLatestMappedAcreage(fires, perimeters);

  let snapshotsSaved = 0;
  let historicalSnapshotsSeeded = 0;
  let evacuationEventsDetected = 0;
  let historyAvailable = true;
  try {
    historicalSnapshotsSeeded = await seedHistoricalPerimeters();
    // Archive every unique source shape before the live-map reduction. This
    // captures intraday CAL FIRE/FIRIS progression without daily KML files.
    snapshotsSaved = await savePerimeterSnapshots(historicalPerimeters.features as Parameters<typeof savePerimeterSnapshots>[0]);
    const active = perimeters.features
      .map((feature) => activeFireIdentity(feature as Parameters<typeof activeFireIdentity>[0]))
      .filter((identity): identity is { irwinId: string; incidentName: string } => identity !== null);
    await markFiresActive(active, Date.now());
    await purgePerimeterHistory(Date.now() - PERIMETER_RETENTION_MS);
    if (results[4].status === "fulfilled") {
      const evacuationResult = await saveEvacuationEvents(
        evacuations.features as Parameters<typeof saveEvacuationEvents>[0],
        Date.now() - PERIMETER_RETENTION_MS,
      );
      evacuationEventsDetected = evacuationResult.eventsDetected;
    }
  } catch {
    historyAvailable = false;
  }

  const feedStatus = {
    nifcIncidents: results[0].status === "fulfilled",
    caPerimeters: results[1].status === "fulfilled",
    caWildfireIntel: results[2].status === "fulfilled",
    calFireIncidents: results[3].status === "fulfilled",
    calOesEvacuations: results[4].status === "fulfilled",
    viirsHotspots: results[5].status === "fulfilled",
  };

  return Response.json(
    {
      fires,
      perimeters,
      evacuations,
      hotspots,
      fetchedAt: Date.now(),
      historyAvailable,
      historicalSnapshotsSeeded,
      evacuationEventsDetected,
      snapshotsSaved,
      feedStatus,
      sources: {
        incidents: "NIFC WFIGS current incidents",
        newStarts: "California Wildfire Intel (IRWIN, PulsePoint, NOAA and CHP)",
        reportedFireStatus: "CAL FIRE active incidents (California only)",
        perimeters: "CAL FIRE California Perimeters (CAL FIRE intelligence, FIRIS and NIFC)",
        evacuations: "CAL OES California Active Evacuation Zones",
        hotspots: "NOAA Hazard Mapping System satellite fire detections",
        satellite: "NASA GIBS GOES ABI Fire Temperature",
      },
    },
    { headers: { "Cache-Control": "public, max-age=60, s-maxage=180" } },
  );
}
