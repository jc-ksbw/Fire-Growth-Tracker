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

export const evacuationZoneState = sqliteTable("evacuation_zone_state", {
  zoneId: text("zone_id").primaryKey(),
  statusFingerprint: text("status_fingerprint").notNull(),
  status: text("status").notNull(),
  statusClass: text("status_class").notNull(),
  sourceUpdatedAt: integer("source_updated_at"),
  lastSeenAt: integer("last_seen_at").notNull(),
  active: integer("active").notNull().default(1),
  county: text("county"),
  city: text("city"),
  zoneName: text("zone_name"),
  eventType: text("event_type"),
  geometryJson: text("geometry_json").notNull(),
  west: real("west").notNull(),
  south: real("south").notNull(),
  east: real("east").notNull(),
  north: real("north").notNull(),
});

export const evacuationEvents = sqliteTable(
  "evacuation_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    zoneId: text("zone_id").notNull(),
    versionKey: text("version_key").notNull(),
    status: text("status").notNull(),
    statusClass: text("status_class").notNull(),
    changedAt: integer("changed_at").notNull(),
    capturedAt: integer("captured_at").notNull(),
    county: text("county"),
    city: text("city"),
    zoneName: text("zone_name"),
    eventType: text("event_type"),
    geometryJson: text("geometry_json").notNull(),
    west: real("west").notNull(),
    south: real("south").notNull(),
    east: real("east").notNull(),
    north: real("north").notNull(),
  },
  (table) => [
    uniqueIndex("evacuation_events_zone_version_unique").on(table.zoneId, table.versionKey),
    index("evacuation_events_time_idx").on(table.changedAt),
    index("evacuation_events_bounds_idx").on(table.west, table.south, table.east, table.north),
  ],
);
