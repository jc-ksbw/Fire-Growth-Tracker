import { getArchiveDays, getDailyPerimeters } from "@/lib/perimeter-store";

function xml(value: unknown) {
  return String(value ?? "").replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;",
  })[character] ?? character);
}

function polygons(geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown }) {
  return geometry.type === "Polygon"
    ? [geometry.coordinates as number[][][]]
    : geometry.coordinates as number[][][][];
}

function kmlFor(date: string, rows: Awaited<ReturnType<typeof getDailyPerimeters>>) {
  const placemarks = rows.map((row) => {
    const shapes = polygons(row.geometry).map((polygon) => {
      const rings = polygon.map((ring, index) => {
        const tag = index === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
        const points = ring.map(([longitude, latitude]) => `${longitude},${latitude},0`).join(" ");
        return `<${tag}><LinearRing><coordinates>${points}</coordinates></LinearRing></${tag}>`;
      }).join("");
      return `<Polygon>${rings}</Polygon>`;
    }).join("");
    return `<Placemark><name>${xml(row.incidentName)}</name><ExtendedData>`
      + `<Data name="irwin_id"><value>${xml(row.irwinId)}</value></Data>`
      + `<Data name="acres"><value>${xml(row.acres)}</value></Data>`
      + `<Data name="contained"><value>${xml(row.contained)}</value></Data>`
      + `</ExtendedData><MultiGeometry>${shapes}</MultiGeometry></Placemark>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>California fire perimeters ${xml(date)}</name>${placemarks}</Document></kml>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date")?.trim();
  if (!date) return Response.json({ days: await getArchiveDays(), retentionDays: 20 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const rows = await getDailyPerimeters(date);
  const format = url.searchParams.get("format") ?? "geojson";
  if (format === "kml") {
    return new Response(kmlFor(date, rows), {
      headers: {
        "Content-Type": "application/vnd.google-earth.kml+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="california-fire-perimeters-${date}.kml"`,
      },
    });
  }
  return Response.json({
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature", geometry: row.geometry,
      properties: {
        irwinId: row.irwinId, incidentName: row.incidentName,
        capturedAt: row.capturedAt, perimeterDate: row.perimeterDate,
        acres: row.acres, contained: row.contained, state: row.state, county: row.county,
      },
    })),
  }, { headers: { "Content-Disposition": `attachment; filename="california-fire-perimeters-${date}.geojson"` } });
}
