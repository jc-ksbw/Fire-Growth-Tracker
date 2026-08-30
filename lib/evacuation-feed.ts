import { getGeoJson, normalizedId, queryUrl, type Feature, type FeatureCollection } from "./fire-feeds";

const CAL_OES_EVACUATIONS =
  "https://services.arcgis.com/BLN4oKB0N1YSgvY8/ArcGIS/rest/services/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query";
const EVACUATION_FIELDS = [
  "COUNTY", "CITY", "ZONE_NAME", "ZONE_ID", "STATUS", "EVENT_TYPE", "CRITICAL_INFO",
  "PUBLIC_INFO", "EDIT_DATE", "STATEWIDE_LAST_UPDATED", "NOTES", "GlobalID", "EditDate",
].join(",");

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function evacuationClass(statusValue: unknown) {
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

export function dedupeEvacuations(collection: FeatureCollection) {
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
    if (priority[statusClass] > priority[existingClass]
      || (priority[statusClass] === priority[existingClass] && incomingDate > existingDate)) {
      byZone.set(key, prepared);
    }
  }
  return { type: "FeatureCollection", features: [...byZone.values()] } satisfies FeatureCollection;
}

export async function getActiveEvacuations() {
  const raw = await getGeoJson(
    queryUrl(CAL_OES_EVACUATIONS, EVACUATION_FIELDS, "STATUS IS NOT NULL AND STATUS <> 'Normal'", true),
    "CAL OES evacuations",
  );
  return dedupeEvacuations(raw);
}
