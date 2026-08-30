import { env } from "cloudflare:workers";
import { HISTORICAL_PERIMETER_SEED_GZIP } from "./perimeter-seed";

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

const textValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

type HistoricalSeedRow = {
  versionKey: string;
  capturedAt: number;
  incidentName: string;
  irwinId: string;
  uniqueFireId: string | null;
  perimeterDate: number | null;
  acres: number | null;
  contained: number | null;
  state: string | null;
  county: string | null;
  geometryJson: string;
};

async function historicalSeedRows() {
  const compressed = Uint8Array.from(atob(HISTORICAL_PERIMETER_SEED_GZIP), (character) => character.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as HistoricalSeedRow[];
}

/**
 * Backfills the user-supplied August 2026 WFIGS snapshots once. INSERT OR
 * IGNORE preserves any same-day perimeter that the live capture already saved.
 */
export async function seedHistoricalPerimeters() {
  const db = getBinding();
  const status = await db.prepare(
    `SELECT COUNT(*) AS seeded
     FROM perimeter_snapshots
     WHERE version_key IN ('daily-2026-08-21', 'daily-2026-08-24', 'daily-2026-08-27', 'daily-2026-08-29')
       AND lower(replace(replace(irwin_id, '{', ''), '}', '')) IN
           ('51374d2c-d96b-40f7-940b-6cb8e0a483a2', 'c257fba6-f90e-431f-9464-067e8fbf79d7')`,
  ).all<{ seeded: number }>();
  let inserted = 0;
  if ((status.results?.[0]?.seeded ?? 0) < 6) {
    const rows = await historicalSeedRows();
    const statements = rows.map((row) => db.prepare(
      `INSERT OR IGNORE INTO perimeter_snapshots
       (irwin_id, unique_fire_id, incident_name, version_key, captured_at,
        perimeter_date, acres, contained, state, county, geometry_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.irwinId, row.uniqueFireId, row.incidentName, row.versionKey,
      row.capturedAt, row.perimeterDate, row.acres, row.contained,
      row.state, row.county, row.geometryJson,
    ));
    for (let i = 0; i < statements.length; i += 2) {
      await db.batch(statements.slice(i, i + 2));
    }
    inserted = rows.length;
  }

  // Older releases used more than one identifier/version format and could
  // leave duplicate same-day rows. Keep the newest capture for each fire/day.
  await db.prepare(
    `DELETE FROM perimeter_snapshots
     WHERE rowid IN (
       SELECT rowid FROM (
         SELECT rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY lower(replace(replace(irwin_id, '{', ''), '}', '')),
                               substr(datetime(captured_at / 1000, 'unixepoch'), 1, 10)
                  ORDER BY captured_at DESC, COALESCE(perimeter_date, 0) DESC, rowid DESC
                ) AS daily_rank
         FROM perimeter_snapshots
       ) WHERE daily_rank > 1
     )`,
  ).run();
  return inserted;
}

export async function savePerimeterSnapshots(features: PerimeterFeature[]) {
  const db = getBinding();
  const capturedAt = Date.now();
  const archiveDay = new Date(capturedAt).toISOString().slice(0, 10);
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
    const versionKey = `daily-${archiveDay}`;
    statements.push(
      db.prepare(
        `INSERT INTO perimeter_snapshots
         (irwin_id, unique_fire_id, incident_name, version_key, captured_at,
          perimeter_date, acres, contained, state, county, geometry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(irwin_id, version_key) DO UPDATE SET
           unique_fire_id = excluded.unique_fire_id,
           incident_name = excluded.incident_name,
           captured_at = excluded.captured_at,
           perimeter_date = excluded.perimeter_date,
           acres = excluded.acres,
           contained = excluded.contained,
           state = excluded.state,
           county = excluded.county,
           geometry_json = excluded.geometry_json`,
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
export async function purgePerimeterHistory(cutoff: number) {
  const db = getBinding();
  const deletion = await db.prepare("DELETE FROM perimeter_snapshots WHERE captured_at < ?").bind(cutoff).run();
  const activityDeletion = await db.prepare("DELETE FROM fire_activity WHERE last_active_at < ?").bind(cutoff).run();
  return {
    activityRowsDeleted: activityDeletion.meta?.changes ?? 0,
    snapshotsDeleted: deletion.meta?.changes ?? 0,
  };
}

export async function getArchiveDays() {
  const result = await getBinding().prepare(
    `SELECT substr(datetime(captured_at / 1000, 'unixepoch'), 1, 10) AS archive_day,
            COUNT(*) AS perimeter_count, MAX(captured_at) AS captured_at
     FROM perimeter_snapshots GROUP BY archive_day
     ORDER BY archive_day DESC LIMIT 20`,
  ).all<{ archive_day: string; perimeter_count: number; captured_at: number }>();
  return (result.results ?? []).map((row) => ({
    date: row.archive_day,
    perimeterCount: row.perimeter_count,
    capturedAt: row.captured_at,
  }));
}

export async function getDailyPerimeters(date: string) {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return [];
  const result = await getBinding().prepare(
    `SELECT irwin_id, incident_name, captured_at, perimeter_date, acres,
            contained, state, county, geometry_json
     FROM perimeter_snapshots
     WHERE captured_at >= ? AND captured_at < ?
     ORDER BY incident_name ASC`,
  ).bind(start, start + 86_400_000).all<{
    irwin_id: string; incident_name: string; captured_at: number;
    perimeter_date: number | null; acres: number | null; contained: number | null;
    state: string | null; county: string | null; geometry_json: string;
  }>();
  return (result.results ?? []).map((row) => ({
    irwinId: row.irwin_id, incidentName: row.incident_name,
    capturedAt: row.captured_at, perimeterDate: row.perimeter_date,
    acres: row.acres, contained: row.contained, state: row.state, county: row.county,
    geometry: JSON.parse(row.geometry_json) as GeoJsonGeometry,
  }));
}

export async function getPerimeterHistory(irwinId: string) {
  const normalizedIrwinId = irwinId.replace(/[{}]/g, "").toLowerCase();
  const result = await getBinding()
    .prepare(
      `WITH ranked AS (
         SELECT incident_name, captured_at, perimeter_date, acres, contained,
                state, county, geometry_json,
                ROW_NUMBER() OVER (
                  PARTITION BY substr(datetime(captured_at / 1000, 'unixepoch'), 1, 10)
                  ORDER BY captured_at DESC, COALESCE(perimeter_date, 0) DESC, rowid DESC
                ) AS daily_rank
         FROM perimeter_snapshots
         WHERE lower(replace(replace(irwin_id, '{', ''), '}', '')) = ?
       )
       SELECT incident_name, captured_at, perimeter_date, acres, contained,
              state, county, geometry_json
       FROM ranked WHERE daily_rank = 1
       ORDER BY COALESCE(perimeter_date, captured_at) ASC
       LIMIT 20`,
    )
    .bind(normalizedIrwinId)
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
