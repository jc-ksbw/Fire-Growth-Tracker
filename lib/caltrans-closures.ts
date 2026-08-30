const CALTRANS_CLOSURES_KML = "https://quickmap.dot.ca.gov/data/lcs2way.kml";

type ClosureFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    closureId: string;
    title: string;
    details: string[];
    updatedLabel: string | null;
    closureClass: "full" | "pending" | "seasonal";
    source: "Caltrans QuickMap";
    url: string;
  };
};

function plainText(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCaltransClosures(kml: string) {
  const features = new Map<string, ClosureFeature>();
  for (const match of kml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi)) {
    const placemark = match[1];
    const style = placemark.match(/<styleUrl>#([^<]+)<\/styleUrl>/i)?.[1] ?? "";
    const closureClass = style === "pending-full-closure"
      ? "pending"
      : style === "SRRA-closed"
        ? "seasonal"
        : style.includes("full-closure")
          ? "full"
          : null;
    if (!closureClass) continue;
    const coordinateText = placemark.match(/<Point>\s*<coordinates>\s*([^<]+)<\/coordinates>\s*<\/Point>/i)?.[1];
    if (!coordinateText) continue;
    const [longitude, latitude] = coordinateText.split(",").map(Number);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const title = plainText(placemark.match(/<h2[^>]*class=["']iw-title["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? "Caltrans road closure");
    const details = [...placemark.matchAll(/<p[^>]*class=["']iw-text["'][^>]*>([\s\S]*?)<\/p>/gi)]
      .map((item) => plainText(item[1]))
      .filter(Boolean);
    const closureId = plainText(placemark.match(/Closure ID:\s*([^,<]+)/i)?.[1] ?? `${title}-${longitude}-${latitude}`);
    const updatedLabel = plainText(placemark.match(/Last updated:\s*([\s\S]*?)<\/span>/i)?.[1] ?? "") || null;
    if (features.has(closureId)) continue;
    features.set(closureId, {
      type: "Feature",
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        closureId,
        title,
        details,
        updatedLabel,
        closureClass,
        source: "Caltrans QuickMap",
        url: "https://quickmap.dot.ca.gov/",
      },
    });
  }
  return { type: "FeatureCollection" as const, features: [...features.values()] };
}

export async function getCaltransClosures() {
  const response = await fetch(CALTRANS_CLOSURES_KML, {
    headers: { Accept: "application/vnd.google-earth.kml+xml, application/xml;q=0.9" },
  });
  if (!response.ok) throw new Error(`Caltrans QuickMap returned ${response.status}`);
  return parseCaltransClosures(await response.text());
}
