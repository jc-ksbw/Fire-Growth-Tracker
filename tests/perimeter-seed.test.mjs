import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { HISTORICAL_PERIMETER_SEED_GZIP } from "../lib/perimeter-seed.ts";

const rows = JSON.parse(gunzipSync(Buffer.from(HISTORICAL_PERIMETER_SEED_GZIP, "base64")));

test("contains the six supplied Central Coast perimeter snapshots", () => {
  assert.equal(rows.length, 6);
  assert.deepEqual(
    [...new Set(rows.map((row) => row.versionKey))],
    ["daily-2026-08-21", "daily-2026-08-24", "daily-2026-08-27", "daily-2026-08-29"],
  );
  assert.deepEqual(
    rows.filter((row) => row.incidentName === "Timber").map((row) => Math.round(row.acres)),
    [6672, 12629, 17817, 23235],
  );
  assert.deepEqual(
    rows.filter((row) => row.incidentName === "Plaskett").map((row) => Math.round(row.acres)),
    [40, 5417],
  );
});

test("contains valid polygon geometry and capture chronology", () => {
  for (const row of rows) {
    const geometry = JSON.parse(row.geometryJson);
    assert.match(geometry.type, /^(Polygon|MultiPolygon)$/);
    assert.ok(Array.isArray(geometry.coordinates));
    assert.ok(row.capturedAt >= row.perimeterDate);
    assert.match(row.irwinId, /^[0-9a-f-]{36}$/);
  }
});
