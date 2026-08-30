import { getPerimeterHistory } from "@/lib/perimeter-store";
import { getEvacuationEvents } from "@/lib/evacuation-store";
import { getHistoricalHotspots, type Bounds } from "@/lib/hotspot-feed";

function timelineBounds(snapshots: Awaited<ReturnType<typeof getPerimeterHistory>>, latitude: number, longitude: number) {
  let west = Number.isFinite(longitude) ? longitude : 180;
  let east = Number.isFinite(longitude) ? longitude : -180;
  let south = Number.isFinite(latitude) ? latitude : 90;
  let north = Number.isFinite(latitude) ? latitude : -90;
  let found = Number.isFinite(latitude) && Number.isFinite(longitude);
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
  snapshots.forEach((snapshot) => visit(snapshot.geometry.coordinates));
  if (!found) return null;
  const longitudePad = Math.max((east - west) * 0.18, 0.12);
  const latitudePad = Math.max((north - south) * 0.18, 0.12);
  return [west - longitudePad, south - latitudePad, east + longitudePad, north + latitudePad] satisfies Bounds;
}

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const irwinId = parameters.get("irwin")?.trim();
  if (!irwinId) {
    return Response.json({ error: "irwin is required" }, { status: 400 });
  }
  try {
    const snapshots = await getPerimeterHistory(irwinId);
    const latitude = Number(parameters.get("lat"));
    const longitude = Number(parameters.get("lon"));
    const bounds = timelineBounds(snapshots, latitude, longitude);
    if (!bounds) return Response.json({ snapshots, evacuationEvents: [], hotspots: { type: "FeatureCollection", features: [] } });
    const cutoff = Date.now() - 20 * 86_400_000;
    const [evacuations, hotspots] = await Promise.allSettled([
      getEvacuationEvents(bounds, cutoff),
      getHistoricalHotspots(bounds, 20),
    ]);
    return Response.json({
      snapshots,
      evacuationEvents: evacuations.status === "fulfilled" ? evacuations.value : [],
      hotspots: hotspots.status === "fulfilled" ? hotspots.value : { type: "FeatureCollection", features: [] },
      timelineFeedStatus: {
        evacuations: evacuations.status === "fulfilled",
        hotspots: hotspots.status === "fulfilled",
      },
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=180" } });
  } catch {
    return Response.json({
      snapshots: [], evacuationEvents: [], hotspots: { type: "FeatureCollection", features: [] }, historyAvailable: false,
    });
  }
}
