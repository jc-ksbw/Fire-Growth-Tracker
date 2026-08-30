import { env } from "cloudflare:workers";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const z = Number(url.searchParams.get("z"));
  const x = Number(url.searchParams.get("x"));
  const y = Number(url.searchParams.get("y"));
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 18 || x < 0 || y < 0) {
    return new Response("Invalid tile", { status: 400 });
  }
  const tileUrl = new URL(`https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`);
  const cartoApiKey = typeof env.CARTO_API_KEY === "string" ? env.CARTO_API_KEY.trim() : "";
  if (cartoApiKey) tileUrl.searchParams.set("key", cartoApiKey);
  const tile = await fetch(tileUrl, {
    headers: { Accept: "image/png" },
  });
  if (!tile.ok || !tile.body) return new Response("Tile unavailable", { status: 502 });
  return new Response(tile.body, {
    headers: {
      "Content-Type": tile.headers.get("content-type") ?? "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=604800",
      "X-Carto-Key-Configured": cartoApiKey ? "yes" : "no",
    },
  });
}
