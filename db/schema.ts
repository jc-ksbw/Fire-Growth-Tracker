import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const fireActivity = sqliteTable(
  "fire_activity",
  {
    irwinId: text("irwin_id").primaryKey(),
    incidentName: text("incident_name").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastActiveAt: integer("last_active_at").notNull(),
  },
  (table) => [index("fire_activity_last_active_idx").on(table.lastActiveAt)],
);

export const perimeterSnapshots = sqliteTable(
  "perimeter_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    irwinId: text("irwin_id").notNull(),
    uniqueFireId: text("unique_fire_id"),
    incidentName: text("incident_name").notNull(),
    versionKey: text("version_key").notNull(),
    capturedAt: integer("captured_at").notNull(),
    perimeterDate: integer("perimeter_date"),
    acres: real("acres"),
    contained: real("contained"),
    state: text("state"),
    county: text("county"),
    geometryJson: text("geometry_json").notNull(),
  },
  (table) => [
    uniqueIndex("perimeter_snapshots_fire_version_unique").on(table.irwinId, table.versionKey),
    index("perimeter_snapshots_fire_time_idx").on(table.irwinId, table.capturedAt),
  ],
);
