import { getCaltransClosures } from "@/lib/caltrans-closures";

export async function GET() {
  try {
    return Response.json(await getCaltransClosures(), {
      headers: { "Cache-Control": "public, max-age=120, s-maxage=300" },
    });
  } catch (error) {
    return Response.json(
      { type: "FeatureCollection", features: [], error: error instanceof Error ? error.message : "Caltrans closures unavailable" },
      { status: 502 },
    );
  }
}
