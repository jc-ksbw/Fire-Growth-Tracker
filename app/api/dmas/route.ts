const DMA_SERVICE =
  "https://services.arcgis.com/AgwDJMQH12AGieWa/ArcGIS/rest/services/DMA/FeatureServer/0/query";
const CALIFORNIA_DMA_IDS = new Set([
  "771", "800", "802", "803", "804", "807", "811", "813",
  "825", "828", "855", "862", "866", "868",
]);

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim();
  const params = new URLSearchParams();

  if (id) {
    if (!/^\d{3}$/.test(id)) {
      return Response.json({ error: "Invalid DMA id" }, { status: 400 });
    }
    params.set("where", `ID='${id}'`);
    params.set("outFields", "ID,NAME,STATE_NAME,ST_ABBREV");
    params.set("returnGeometry", "true");
    params.set("outSR", "4326");
    params.set("maxAllowableOffset", "0.002");
    params.set("geometryPrecision", "5");
    params.set("f", "geojson");
  } else {
    params.set("where", "1=1");
    params.set("outFields", "ID,NAME,STATE_NAME,ST_ABBREV");
    params.set("returnGeometry", "false");
    params.set("orderByFields", "NAME");
    params.set("resultRecordCount", "500");
    params.set("f", "json");
  }

  try {
    const response = await fetch(`${DMA_SERVICE}?${params}`, {
      headers: { Accept: "application/json, application/geo+json" },
    });
    if (!response.ok) throw new Error(`DMA service returned ${response.status}`);
    const payload = await response.json() as {
      features?: Array<{
        attributes?: Record<string, unknown>;
        properties?: Record<string, unknown>;
        geometry?: unknown;
      }>;
      error?: { message?: string };
    };
    if (payload.error) throw new Error(payload.error.message ?? "DMA lookup failed");

    if (id) {
      const feature = payload.features?.[0];
      if (!feature) return Response.json({ error: "DMA not found" }, { status: 404 });
      return Response.json(
        { feature },
        { headers: { "Cache-Control": "public, max-age=86400, s-maxage=604800" } },
      );
    }

    const markets = (payload.features ?? []).map((feature) => ({
      id: String(feature.attributes?.ID ?? ""),
      name: String(feature.attributes?.NAME ?? ""),
      state: String(feature.attributes?.STATE_NAME ?? ""),
      abbreviation: String(feature.attributes?.ST_ABBREV ?? ""),
    })).filter((market) => market.id && market.name && CALIFORNIA_DMA_IDS.has(market.id));
    return Response.json(
      { markets },
      { headers: { "Cache-Control": "public, max-age=86400, s-maxage=604800" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "DMA data is unavailable" },
      { status: 502 },
    );
  }
}
