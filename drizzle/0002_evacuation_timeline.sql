CREATE TABLE `evacuation_zone_state` (
  `zone_id` text PRIMARY KEY NOT NULL,
  `status_fingerprint` text NOT NULL,
  `status` text NOT NULL,
  `status_class` text NOT NULL,
  `source_updated_at` integer,
  `last_seen_at` integer NOT NULL,
  `active` integer DEFAULT 1 NOT NULL,
  `county` text,
  `city` text,
  `zone_name` text,
  `event_type` text,
  `geometry_json` text NOT NULL,
  `west` real NOT NULL,
  `south` real NOT NULL,
  `east` real NOT NULL,
  `north` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evacuation_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `zone_id` text NOT NULL,
  `version_key` text NOT NULL,
  `status` text NOT NULL,
  `status_class` text NOT NULL,
  `changed_at` integer NOT NULL,
  `captured_at` integer NOT NULL,
  `county` text,
  `city` text,
  `zone_name` text,
  `event_type` text,
  `geometry_json` text NOT NULL,
  `west` real NOT NULL,
  `south` real NOT NULL,
  `east` real NOT NULL,
  `north` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evacuation_events_zone_version_unique` ON `evacuation_events` (`zone_id`,`version_key`);
--> statement-breakpoint
CREATE INDEX `evacuation_events_time_idx` ON `evacuation_events` (`changed_at`);
--> statement-breakpoint
CREATE INDEX `evacuation_events_bounds_idx` ON `evacuation_events` (`west`,`south`,`east`,`north`);
