import { getPerimeterHistory } from "@/lib/perimeter-store";

export async function GET(request: Request) {
  const irwinId = new URL(request.url).searchParams.get("irwin")?.trim();
  if (!irwinId) {
    return Response.json({ error: "irwin is required" }, { status: 400 });
  }
  try {
    return Response.json({ snapshots: await getPerimeterHistory(irwinId) });
  } catch {
    return Response.json({ snapshots: [], historyAvailable: false });
  }
}
