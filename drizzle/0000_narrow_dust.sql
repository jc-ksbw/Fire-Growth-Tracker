CREATE TABLE `perimeter_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`irwin_id` text NOT NULL,
	`unique_fire_id` text,
	`incident_name` text NOT NULL,
	`version_key` text NOT NULL,
	`captured_at` integer NOT NULL,
	`perimeter_date` integer,
	`acres` real,
	`contained` real,
	`state` text,
	`county` text,
	`geometry_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `perimeter_snapshots_fire_version_unique` ON `perimeter_snapshots` (`irwin_id`,`version_key`);--> statement-breakpoint
CREATE INDEX `perimeter_snapshots_fire_time_idx` ON `perimeter_snapshots` (`irwin_id`,`captured_at`);