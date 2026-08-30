import { env } from "cloudflare:workers";
import type { Bounds } from "./hotspot-feed";

type Geometry = { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
type EvacuationFeature = {
  type: "Feature";
  geometry: Geometry | null;
  properties: Record<string, unknown>;
};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const normalizedId = (value: unknown) => text(value)?.replace(/[{}]/g, "").toUpperCase() ?? null;

function getBinding() {
  if (!env.DB) throw new Error("D1 is not available");
  return env.DB;
}

let schemaReady: Promise<void> | null = null;

export function ensureEvacuationHistorySchema() {
  if (schemaReady) return schemaReady;
  const db = getBinding();
  schemaReady = (async () => {
    await db.batch([
      db.prepare(
        `CREATE TABLE IF NOT EXISTS evacuation_zone_state (
          zone_id TEXT PRIMARY KEY NOT NULL,
          status_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          status_class TEXT NOT NULL,
          source_updated_at INTEGER,
          last_seen_at INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          county TEXT,
          city TEXT,
          zone_name TEXT,
          event_type TEXT,
          geometry_json TEXT NOT NULL,
          west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL, north REAL NOT NULL
        )`,
      ),
      db.prepare(
        `CREATE TABLE IF NOT EXISTS evacuation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          zone_id TEXT NOT NULL,
          version_key TEXT NOT NULL,
          status TEXT NOT NULL,
          status_class TEXT NOT NULL,
          changed_at INTEGER NOT NULL,
          captured_at INTEGER NOT NULL,
          county TEXT,
          city TEXT,
          zone_name TEXT,
          event_type TEXT,
          geometry_json TEXT NOT NULL,
          west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL, north REAL NOT NULL
        )`,
      ),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS evacuation_events_zone_version_unique ON evacuation_events(zone_id, version_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS evacuation_events_time_idx ON evacuation_events(changed_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS evacuation_events_bounds_idx ON evacuation_events(west, south, east, north)"),
    ]);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function geometryBounds(geometry: Geometry): Bounds | null {
  let west = 180, south = 90, east = -180, north = -90;
  let found = false;
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      found = true;
      west = Math.min(west, value[0]); east = Math.max(east, value[0]);
      south = Math.min(south, value[1]); north = Math.max(north, value[1]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  return found ? [west, south, east, north] : null;
}

type StoredZone = {
  zone_id: string;
  status_fingerprint: string;
  status: string;
  status_class: string;
  source_updated_at: number | null;
  county: string | null;
  city: string | null;
  zone_name: string | null;
  event_type: string | null;
  geometry_json: string;
  west: number; south: number; east: number; north: number;
};

export async function saveEvacuationEvents(features: EvacuationFeature[], retentionCutoff: number) {
  await ensureEvacuationHistorySchema();
  const db = getBinding();
  const capturedAt = Date.now();
  const previousResult = await db.prepare(
    `SELECT zone_id, status_fingerprint, status, status_class, source_updated_at,
            county, city, zone_name, event_type, geometry_json, west, south, east, north
     FROM evacuation_zone_state WHERE active = 1`,
  ).all<StoredZone>();
  const previous = new Map((previousResult.results ?? []).map((row) => [row.zone_id, row]));
  const currentIds = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  let eventsDetected = 0;

  for (const feature of features) {
    if (!feature.geometry) continue;
    const bounds = geometryBounds(feature.geometry);
    const zoneId = normalizedId(feature.properties.ZONE_ID)
      ?? normalizedId(feature.properties.GlobalID)
      ?? normalizedId(feature.properties.OBJECTID);
    const status = text(feature.properties.STATUS);
    const statusClass = text(feature.properties.evacuationClass) ?? "other";
    if (!bounds || !zoneId || !status) continue;
    currentIds.add(zoneId);
    const fingerprint = `${statusClass}:${status.toUpperCase()}`;
    const sourceUpdatedAt = number(feature.properties.EDIT_DATE)
      ?? number(feature.properties.EditDate)
      ?? number(feature.properties.STATEWIDE_LAST_UPDATED);
    const changedAt = sourceUpdatedAt ?? capturedAt;
    const geometryJson = JSON.stringify(feature.geometry);
    const values = {
      county: text(feature.properties.COUNTY),
      city: text(feature.properties.CITY),
      zoneName: text(feature.properties.ZONE_NAME),
      eventType: text(feature.properties.EVENT_TYPE),
    };
    const prior = previous.get(zoneId);
    if (!prior || prior.status_fingerprint !== fingerprint) {
      eventsDetected += 1;
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO evacuation_events
         (zone_id, version_key, status, status_class, changed_at, captured_at,
          county, city, zone_name, event_type, geometry_json, west, south, east, north)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        zoneId, `${changedAt}:${fingerprint}`, status, statusClass, changedAt, capturedAt,
        values.county, values.city, values.zoneName, values.eventType, geometryJson, ...bounds,
      ));
    }
    statements.push(db.prepare(
      `INSERT INTO evacuation_zone_state
       (zone_id, status_fingerprint, status, status_class, source_updated_at, last_seen_at,
        active, county, city, zone_name, event_type, geometry_json, west, south, east, north)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(zone_id) DO UPDATE SET
         status_fingerprint=excluded.status_fingerprint, status=excluded.status,
         status_class=excluded.status_class, source_updated_at=excluded.source_updated_at,
         last_seen_at=excluded.last_seen_at, active=1, county=excluded.county,
         city=excluded.city, zone_name=excluded.zone_name, event_type=excluded.event_type,
         geometry_json=excluded.geometry_json, west=excluded.west, south=excluded.south,
         east=excluded.east, north=excluded.north`,
    ).bind(
      zoneId, fingerprint, status, statusClass, sourceUpdatedAt, capturedAt,
      values.county, values.city, values.zoneName, values.eventType, geometryJson, ...bounds,
    ));
  }

  for (const prior of previous.values()) {
    if (currentIds.has(prior.zone_id)) continue;
    eventsDetected += 1;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO evacuation_events
         (zone_id, version_key, status, status_class, changed_at, captured_at,
          county, city, zone_name, event_type, geometry_json, west, south, east, north)
         VALUES (?, ?, 'Lifted / cleared', 'cleared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        prior.zone_id, `${capturedAt}:cleared`, capturedAt, capturedAt,
        prior.county, prior.city, prior.zone_name, prior.event_type, prior.geometry_json,
        prior.west, prior.south, prior.east, prior.north,
      ),
      db.prepare("UPDATE evacuation_zone_state SET active = 0, last_seen_at = ? WHERE zone_id = ?")
        .bind(capturedAt, prior.zone_id),
    );
  }

  for (let index = 0; index < statements.length; index += 30) {
    await db.batch(statements.slice(index, index + 30));
  }
  const deletion = await db.prepare("DELETE FROM evacuation_events WHERE captured_at < ?").bind(retentionCutoff).run();
  return { eventsDetected, eventsDeleted: deletion.meta?.changes ?? 0 };
}

export async function getEvacuationEvents(bounds: Bounds, cutoff: number) {
  await ensureEvacuationHistorySchema();
  const [west, south, east, north] = bounds;
  const result = await getBinding().prepare(
    `SELECT zone_id, status, status_class, changed_at, captured_at, county, city,
            zone_name, event_type, geometry_json
     FROM evacuation_events
     WHERE captured_at >= ? AND east >= ? AND west <= ? AND north >= ? AND south <= ?
     ORDER BY changed_at ASC LIMIT 500`,
  ).bind(cutoff, west, east, south, north).all<{
    zone_id: string; status: string; status_class: string; changed_at: number; captured_at: number;
    county: string | null; city: string | null; zone_name: string | null; event_type: string | null;
    geometry_json: string;
  }>();
  return (result.results ?? []).map((row) => ({
    zoneId: row.zone_id,
    status: row.status,
    statusClass: row.status_class,
    changedAt: row.changed_at,
    capturedAt: row.captured_at,
    county: row.county,
    city: row.city,
    zoneName: row.zone_name,
    eventType: row.event_type,
    geometry: JSON.parse(row.geometry_json) as Geometry,
  }));
}
