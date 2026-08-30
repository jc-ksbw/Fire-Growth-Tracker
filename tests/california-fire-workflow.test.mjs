import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCalFireIncidents } from "../lib/cal-fire-incidents.ts";
import { dedupePerimeters, normalizePerimeters } from "../lib/fire-feeds.ts";

const polygon = (offset) => ({
  type: "Polygon",
  coordinates: [[[-121 + offset, 36], [-120.9 + offset, 36], [-120.9 + offset, 36.1], [-121 + offset, 36]]],
});

test("marks CAL FIRE incident enrichment as California-only", () => {
  const result = normalizeCalFireIncidents({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [-121.41472, 35.90356] },
      properties: {
        Name: "Plaskett Fire", UniqueId: "calfire-plaskett", Type: "Wildfire", IsActive: true,
        AcresBurned: 15478.5, PercentContained: 1, Updated: "2026-08-30T22:46:07Z",
        Started: "2026-08-26T18:01:28Z", County: "Monterey",
      },
    }],
  });
  assert.equal(result.features[0].properties.IncidentName, "Plaskett");
  assert.equal(result.features[0].properties.IncidentSize, 15478.5);
  assert.equal(result.features[0].properties.POOState, "US-CA");
  assert.equal(result.features[0].properties.regionalWorkflow, "CALIFORNIA_CAL_FIRE");
});

test("retains all distinct perimeter shapes and backfills early-flight IRWIN IDs", () => {
  const raw = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: polygon(0), properties: { incident_name: "PLASKETT", area_acres: 40, poly_DateCurrent: 1, source: "FIRIS" } },
      { type: "Feature", geometry: polygon(0.2), properties: { incident_name: "PLASKETT", incident_number: "irwin-plaskett", area_acres: 8241, poly_DateCurrent: 2, source: "CAL FIRE" } },
      { type: "Feature", geometry: polygon(0.4), properties: { incident_name: "PLASKETT", incident_number: "irwin-plaskett", area_acres: 15478.5, poly_DateCurrent: 3, source: "CAL FIRE" } },
    ],
  };
  const normalized = normalizePerimeters(raw);
  assert.equal(normalized.features.length, 3);
  assert.equal(normalized.features[0].properties.poly_IRWINID, "IRWIN-PLASKETT");
  const latest = dedupePerimeters(raw);
  assert.equal(latest.features.length, 1);
  assert.equal(latest.features[0].properties.poly_Acres_AutoCalc, 15478.5);
});
