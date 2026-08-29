import {
  CA_PERIMETERS,
  PERIMETER_FIELDS,
  activeFireIdentity,
  dedupePerimeters,
  getGeoJson,
  queryUrl,
} from "./fire-feeds";
import { markFiresActive, purgeEndedFires, savePerimeterSnapshots } from "./perimeter-store";

/** History is kept while a fire is active and for 48 hours after it leaves the active feed. */
export const RETENTION_AFTER_END_MS = 48 * 3_600_000;

/**
 * One autonomous capture cycle. Runs from the Worker cron trigger and from the
 * token-protected /api/capture route, with no browser involved:
 *  1. Fetch the current active CAL FIRE / FIRIS / NIFC perimeters.
 *  2. Save any changed perimeter shapes as history snapshots.
 *  3. Mark every fire seen in the active feed as active right now.
 *  4. Purge snapshots for fires that ended (left the feed) more than 48h ago.
 */
export async function runCapture() {
  const startedAt = Date.now();
  const raw = await getGeoJson(
    queryUrl(CA_PERIMETERS, PERIMETER_FIELDS, "displayStatus='Active'", true),
    "California fire perimeters",
  );
  const perimeters = dedupePerimeters(raw);
  const snapshotsSaved = await savePerimeterSnapshots(
    perimeters.features as Parameters<typeof savePerimeterSnapshots>[0],
  );
  const active = perimeters.features
    .map(activeFireIdentity)
    .filter((identity): identity is { irwinId: string; incidentName: string } => identity !== null);
  const activeMarked = await markFiresActive(active, startedAt);
  const purge = await purgeEndedFires(startedAt - RETENTION_AFTER_END_MS);
  return {
    capturedAt: startedAt,
    activePerimeters: perimeters.features.length,
    snapshotsSaved,
    activeMarked,
    firesPurged: purge.firesPurged,
    snapshotsDeleted: purge.snapshotsDeleted,
    durationMs: Date.now() - startedAt,
  };
}
