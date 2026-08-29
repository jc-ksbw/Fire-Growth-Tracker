CREATE TABLE `fire_activity` (
	`irwin_id` text PRIMARY KEY NOT NULL,
	`incident_name` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fire_activity_last_active_idx` ON `fire_activity` (`last_active_at`);
