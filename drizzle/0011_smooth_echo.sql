CREATE TABLE `statement_run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`run_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`statement_id` text,
	`outcome` text NOT NULL,
	`detail` text,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`held_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`run_id`) REFERENCES `statement_runs`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_run_items_org_id_uq` ON `statement_run_items` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `statement_run_items_run_idx` ON `statement_run_items` (`org_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `statement_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`due_on` integer NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`considered_count` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_runs_org_id_uq` ON `statement_runs` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `statement_runs_org_due_uq` ON `statement_runs` (`org_id`,`due_on`);--> statement-breakpoint
CREATE TABLE `statement_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`cadence` text DEFAULT 'off' NOT NULL,
	`day_of_month` integer DEFAULT 1 NOT NULL,
	`day_of_week` integer DEFAULT 1 NOT NULL,
	`window_days` integer DEFAULT 90 NOT NULL,
	`minimum_balance_cents` integer DEFAULT 0 NOT NULL,
	`include_credit_holders` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_schedules_org_id_uq` ON `statement_schedules` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `statement_schedules_org_uq` ON `statement_schedules` (`org_id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `statements_enabled` integer DEFAULT true NOT NULL;