import type { Feature, FeatureCollection } from "./fire-feeds";

const CAL_FIRE_ACTIVE_INCIDENTS =
  "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/GeoJsonList?inactive=false";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Convert CAL FIRE's public incident GeoJSON into the shared incident shape.
 *
 * IMPORTANT: this is deliberately a California-only enrichment workflow.
 * Never apply CAL FIRE acreage, containment, or IDs to incidents whose state
 * is not US-CA if this tracker is expanded nationally.
 */
export function normalizeCalFireIncidents(collection: FeatureCollection) {
  return {
    type: "FeatureCollection",
    features: collection.features.flatMap((feature): Feature[] => {
      if (feature.geometry?.type !== "Point") return [];
      const p = feature.properties;
      const name = text(p.Name);
      const uniqueId = text(p.UniqueId);
      if (!name || !uniqueId || p.IsActive === false || text(p.Type)?.toUpperCase() !== "WILDFIRE") return [];
      return [{
        ...feature,
        properties: {
          ...p,
          IncidentName: name.replace(/\s+Fire$/i, ""),
          IncidentSize: number(p.AcresBurned),
          PercentContained: number(p.PercentContained),
          FireDiscoveryDateTime: timestamp(p.Started),
          ModifiedOnDateTime_dt: timestamp(p.Updated),
          POOState: "US-CA",
          POOCounty: text(p.County),
          CalFireUniqueId: uniqueId,
          CalFireUrl: text(p.Url),
          CanonicalID: uniqueId,
          isNew: false,
          sources: ["CAL FIRE Incidents"],
          sourceReports: 1,
          reportingStatus: "CONFIRMED",
          ReportedAcresSource: "CAL FIRE",
          ReportedAcresUpdatedAt: timestamp(p.Updated),
          regionalWorkflow: "CALIFORNIA_CAL_FIRE",
        },
      }];
    }),
  } satisfies FeatureCollection;
}

export async function getCalFireActiveIncidents() {
  const response = await fetch(CAL_FIRE_ACTIVE_INCIDENTS, { headers: { Accept: "application/geo+json, application/json" } });
  if (!response.ok) throw new Error(`CAL FIRE incidents returned ${response.status}`);
  const collection = await response.json() as FeatureCollection & { error?: string };
  if (collection.error || collection.type !== "FeatureCollection") throw new Error(collection.error ?? "CAL FIRE incidents returned invalid GeoJSON");
  return normalizeCalFireIncidents(collection);
}
