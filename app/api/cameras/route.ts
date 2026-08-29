const CAMERA_FEED = "https://alertwest.live/api/firecams/v0/cameras";

type CameraRecord = {
  name?: string;
  site?: { id?: string; latitude?: number | string; longitude?: number | string; state?: string; county?: string };
};

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));
  const limit = Math.min(5, Math.max(1, Number(url.searchParams.get("limit")) || 5));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Response.json({ error: "lat and lon are required" }, { status: 400 });
  }
  try {
    const response = await fetch(CAMERA_FEED, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Camera feed returned ${response.status}`);
    const raw = await response.json() as CameraRecord[] | { cameras?: CameraRecord[]; data?: CameraRecord[] };
    const records = Array.isArray(raw) ? raw : raw.cameras ?? raw.data ?? [];
    const cameras = records.flatMap((camera) => {
      const lat = Number(camera.site?.latitude);
      const lon = Number(camera.site?.longitude);
      const name = camera.name ?? camera.site?.id;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || camera.site?.state !== "CA") return [];
      return [{
        name: name.replace(/^Axis-/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(\d+)$/, " $1"),
        cameraId: name,
        county: camera.site?.county ?? null,
        latitude: lat,
        longitude: lon,
        distanceMiles: distanceKm(latitude, longitude, lat, lon) * 0.621371,
        url: `https://cameras.alertcalifornia.org/?id=${encodeURIComponent(name)}&pos=${latitude.toFixed(4)}_${longitude.toFixed(4)}_10`,
      }];
    }).sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, limit);
    return Response.json({ cameras, source: "AlertWest / ALERTCalifornia" }, {
      headers: { "Cache-Control": "public, max-age=900" },
    });
  } catch (error) {
    return Response.json({ cameras: [], error: error instanceof Error ? error.message : "Camera feed unavailable" }, { status: 502 });
  }
}
