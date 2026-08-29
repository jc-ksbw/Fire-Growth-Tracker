import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Create the database and update its database_id in wrangler.jsonc before using perimeter history."
    );
  }

  return drizzle(env.DB, { schema });
}
