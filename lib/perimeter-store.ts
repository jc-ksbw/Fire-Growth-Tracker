import { env } from "cloudflare:workers";

type GeoJsonGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
type PerimeterFeature = {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown>;
};

function getBinding() {
  if (!env.DB) throw new Error("D1 is not available");
  return env.DB;
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const textValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export async function savePerimeterSnapshots(features: PerimeterFeature[]) {
  const db = getBinding();
  const existing = await db
    .prepare("SELECT irwin_id, version_key FROM perimeter_snapshots ORDER BY captured_at DESC LIMIT 4000")
    .all<{ irwin_id: string; version_key: string }>();
  const known = new Set(
    (existing.results ?? []).map((row) => `${row.irwin_id}|${row.version_key}`),
  );
  const capturedAt = Date.now();
  const statements: D1PreparedStatement[] = [];

  for (const feature of features) {
    if (!feature.geometry) continue;
    const p = feature.properties;
    const irwinId = textValue(p.poly_IRWINID) ?? textValue(p.attr_IrwinID);
    const incidentName = textValue(p.attr_IncidentName) ?? textValue(p.poly_IncidentName);
    const contained = numberValue(p.attr_PercentContained);
    const acres =
      numberValue(p.poly_Acres_AutoCalc) ??
      numberValue(p.poly_GISAcres) ??
      numberValue(p.attr_IncidentSize);
    if (!irwinId || !incidentName || contained === 100 || (acres ?? 0) < 10) continue;

    const geometryJson = JSON.stringify(feature.geometry);
    const perimeterDate = numberValue(p.poly_PolygonDateTime) ?? numberValue(p.poly_DateCurrent);
    const versionKey = perimeterDate
      ? String(perimeterDate)
      : `${Math.round((acres ?? 0) * 1000)}-${fnv1a(geometryJson)}`;
    if (known.has(`${irwinId}|${versionKey}`)) continue;
    known.add(`${irwinId}|${versionKey}`);
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO perimeter_snapshots
         (irwin_id, unique_fire_id, incident_name, version_key, captured_at,
          perimeter_date, acres, contained, state, county, geometry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        irwinId,
        textValue(p.attr_UniqueFireIdentifier),
        incidentName,
        versionKey,
        capturedAt,
        perimeterDate,
        acres,
        contained,
        textValue(p.attr_POOState),
        textValue(p.attr_POOCounty),
        geometryJson,
      ),
    );
  }

  for (let i = 0; i < statements.length; i += 40) {
    await db.batch(statements.slice(i, i + 40));
  }
  return statements.length;
}

/**
 * Records that these fires appeared in the active perimeter feed at `at`.
 * Also backfills activity rows for snapshots that predate activity tracking,
 * so legacy history participates in retention instead of living forever.
 */
export async function markFiresActive(fires: Array<{ irwinId: string; incidentName: string }>, at: number) {
  const db = getBinding();
  await db.prepare(
    `INSERT OR IGNORE INTO fire_activity (irwin_id, incident_name, first_seen_at, last_active_at)
     SELECT irwin_id, incident_name, MIN(captured_at), MAX(captured_at)
     FROM perimeter_snapshots GROUP BY irwin_id`,
  ).run();
  const statements = fires.map((fire) =>
    db.prepare(
      `INSERT INTO fire_activity (irwin_id, incident_name, first_seen_at, last_active_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(irwin_id) DO UPDATE SET
         last_active_at = excluded.last_active_at,
         incident_name = excluded.incident_name`,
    ).bind(fire.irwinId, fire.incidentName, at, at),
  );
  for (let i = 0; i < statements.length; i += 40) {
    await db.batch(statements.slice(i, i + 40));
  }
  return statements.length;
}

/**
 * Deletes history for fires whose last appearance in the active feed is older
 * than `cutoff` (i.e. the fire ended and its 48-hour grace window has passed).
 */
export async function purgeEndedFires(cutoff: number) {
  const db = getBinding();
  const stale = await db
    .prepare("SELECT irwin_id FROM fire_activity WHERE last_active_at < ?")
    .bind(cutoff)
    .all<{ irwin_id: string }>();
  const ids = (stale.results ?? []).map((row) => row.irwin_id);
  let snapshotsDeleted = 0;
  for (const irwinId of ids) {
    const deletion = await db.prepare("DELETE FROM perimeter_snapshots WHERE irwin_id = ?").bind(irwinId).run();
    snapshotsDeleted += deletion.meta?.changes ?? 0;
    await db.prepare("DELETE FROM fire_activity WHERE irwin_id = ?").bind(irwinId).run();
  }
  return { firesPurged: ids.length, snapshotsDeleted };
}

export async function getPerimeterHistory(irwinId: string) {
  const result = await getBinding()
    .prepare(
      `SELECT incident_name, captured_at, perimeter_date, acres, contained,
              state, county, geometry_json
       FROM perimeter_snapshots
       WHERE irwin_id = ?
       ORDER BY COALESCE(perimeter_date, captured_at) ASC
       LIMIT 80`,
    )
    .bind(irwinId)
    .all<{
      incident_name: string;
      captured_at: number;
      perimeter_date: number | null;
      acres: number | null;
      contained: number | null;
      state: string | null;
      county: string | null;
      geometry_json: string;
    }>();

  return (result.results ?? []).map((row) => ({
    incidentName: row.incident_name,
    capturedAt: row.captured_at,
    perimeterDate: row.perimeter_date,
    acres: row.acres,
    contained: row.contained,
    state: row.state,
    county: row.county,
    geometry: JSON.parse(row.geometry_json) as GeoJsonGeometry,
  }));
}
