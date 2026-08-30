import {
  CA_PERIMETERS,
  PERIMETER_FIELDS,
  activeFireIdentity,
  dedupePerimeters,
  getGeoJson,
  normalizePerimeters,
  queryUrl,
} from "./fire-feeds";
import { markFiresActive, purgePerimeterHistory, savePerimeterSnapshots, seedHistoricalPerimeters } from "./perimeter-store";
import { getActiveEvacuations } from "./evacuation-feed";
import { saveEvacuationEvents } from "./evacuation-store";

/** Today's archive plus the previous 19 UTC days are retained. */
export const PERIMETER_RETENTION_MS = 20 * 86_400_000;

/**
 * One autonomous capture cycle. Runs from the Worker cron trigger and from the
 * token-protected /api/capture route, with no browser involved:
 *  1. Fetch the current active CAL FIRE / FIRIS / NIFC perimeters.
 *  2. Save every unique CAL FIRE/FIRIS source shape before live-map dedupe.
 *  3. Mark every fire seen in the active feed as active right now.
 *  4. Purge archive rows older than the rolling 20-day window.
 */
export async function runCapture() {
  const startedAt = Date.now();
  const [raw, evacuationResult] = await Promise.all([
    getGeoJson(
      queryUrl(CA_PERIMETERS, PERIMETER_FIELDS, "displayStatus='Active'", true),
      "California fire perimeters",
    ),
    getActiveEvacuations().then((value) => ({ value, error: null })).catch((error: unknown) => ({ value: null, error })),
  ]);
  const historicalSnapshotsSeeded = await seedHistoricalPerimeters();
  const historicalPerimeters = normalizePerimeters(raw);
  const perimeters = dedupePerimeters(raw);
  const snapshotsSaved = await savePerimeterSnapshots(
    historicalPerimeters.features as Parameters<typeof savePerimeterSnapshots>[0],
  );
  const active = perimeters.features
    .map(activeFireIdentity)
    .filter((identity): identity is { irwinId: string; incidentName: string } => identity !== null);
  const activeMarked = await markFiresActive(active, startedAt);
  const purge = await purgePerimeterHistory(startedAt - PERIMETER_RETENTION_MS);
  const evacuationHistory = evacuationResult.value
    ? await saveEvacuationEvents(
      evacuationResult.value.features as Parameters<typeof saveEvacuationEvents>[0],
      startedAt - PERIMETER_RETENTION_MS,
    )
    : { eventsDetected: 0, eventsDeleted: 0 };
  return {
    capturedAt: startedAt,
    activePerimeters: perimeters.features.length,
    snapshotsSaved,
    historicalSnapshotsSeeded,
    activeMarked,
    activityRowsDeleted: purge.activityRowsDeleted,
    snapshotsDeleted: purge.snapshotsDeleted,
    evacuationEventsDetected: evacuationHistory.eventsDetected,
    evacuationEventsDeleted: evacuationHistory.eventsDeleted,
    evacuationsAvailable: evacuationResult.error === null,
    durationMs: Date.now() - startedAt,
  };
}
