CREATE TABLE `dunning_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`run_id` text,
	`stage_sequence` integer NOT NULL,
	`stage_label` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`sent_at` integer NOT NULL,
	`document_id` text,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`days_past_due` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_notices_org_id_uq` ON `dunning_notices` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `dunning_notices_invoice_idx` ON `dunning_notices` (`org_id`,`invoice_id`);--> statement-breakpoint
CREATE INDEX `dunning_notices_run_idx` ON `dunning_notices` (`org_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `dunning_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`due_on` integer NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`considered_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`held_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_runs_org_id_uq` ON `dunning_runs` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_runs_org_due_uq` ON `dunning_runs` (`org_id`,`due_on`);--> statement-breakpoint
CREATE TABLE `dunning_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`minimum_balance_cents` integer DEFAULT 0 NOT NULL,
	`minimum_gap_days` integer DEFAULT 10 NOT NULL,
	`pause_after_payment_days` integer DEFAULT 14 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_settings_org_id_uq` ON `dunning_settings` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_settings_org_uq` ON `dunning_settings` (`org_id`);--> statement-breakpoint
CREATE TABLE `dunning_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`label` text NOT NULL,
	`days_past_due` integer NOT NULL,
	`message` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_stages_org_id_uq` ON `dunning_stages` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dunning_stages_org_sequence_uq` ON `dunning_stages` (`org_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `customers` ADD `dunning_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `dunning_paused_until` integer;--> statement-breakpoint
ALTER TABLE `invoices` ADD `dunning_pause_reason` text;