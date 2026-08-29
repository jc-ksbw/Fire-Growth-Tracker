import { env } from "cloudflare:workers";
import { runCapture } from "@/lib/capture";

/**
 * Manual/external trigger for the autonomous perimeter capture — the fallback
 * when the hosting platform doesn't expose Worker cron triggers. Point any
 * scheduler (GitHub Actions cron, cron-job.org, uptime monitor) at:
 *
 *   POST /api/capture
 *   Authorization: Bearer <CAPTURE_TOKEN>
 *
 * Requires a CAPTURE_TOKEN environment variable; the route refuses to run
 * without one so the endpoint can't be used anonymously to hammer upstream feeds.
 */
async function handle(request: Request) {
  const configured = (env as unknown as Record<string, unknown>).CAPTURE_TOKEN;
  if (typeof configured !== "string" || configured.length < 16) {
    return Response.json(
      { error: "Capture trigger disabled. Set a CAPTURE_TOKEN environment variable (16+ characters) to enable it." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? url.searchParams.get("token");
  if (provided !== configured) {
    return Response.json({ error: "Invalid capture token" }, { status: 401 });
  }
  try {
    return Response.json(await runCapture());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Capture failed" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
