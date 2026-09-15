CREATE TABLE `cash_alert_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`recipients` text,
	`minimum_gap_days` integer DEFAULT 2 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_alert_settings_org_id_uq` ON `cash_alert_settings` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cash_alert_settings_org_uq` ON `cash_alert_settings` (`org_id`);--> statement-breakpoint
CREATE TABLE `cash_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`sent_at` integer NOT NULL,
	`recipients` text NOT NULL,
	`window_from` integer,
	`window_index` integer,
	`shortfall_cents` integer,
	`position_cents` integer,
	`balance_as_of` integer,
	`balance_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_alerts_org_id_uq` ON `cash_alerts` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `cash_alerts_org_sent_idx` ON `cash_alerts` (`org_id`,`sent_at`);