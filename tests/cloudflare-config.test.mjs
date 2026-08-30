import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("declares the Cloudflare runtime bindings", async () => {
  const config = JSON.parse(await readFile(new URL("wrangler.jsonc", root), "utf8"));

  assert.equal(config.main, "./worker/index.ts");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.images.binding, "IMAGES");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.deepEqual(config.triggers.crons, ["0 13 * * *"]);
});

test("includes perimeter and evacuation-history migrations", async () => {
  const first = await readFile(new URL("drizzle/0000_narrow_dust.sql", root), "utf8");
  const second = await readFile(new URL("drizzle/0001_rare_lord_tyger.sql", root), "utf8");
  const third = await readFile(new URL("drizzle/0002_evacuation_timeline.sql", root), "utf8");

  assert.match(first, /CREATE TABLE [`\"]perimeter_snapshots[`\"]/);
  assert.match(second, /CREATE TABLE [`\"]fire_activity[`\"]/);
  assert.match(third, /CREATE TABLE [`\"]evacuation_zone_state[`\"]/);
  assert.match(third, /CREATE TABLE [`\"]evacuation_events[`\"]/);
});
