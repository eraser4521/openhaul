CREATE TABLE `settlement_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`kind` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`load_id` text,
	`expense_id` text,
	`document_id` text,
	`basis_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`settlement_id`) REFERENCES `settlements`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlement_lines_org_id_uq` ON `settlement_lines` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `settlement_lines_settlement_idx` ON `settlement_lines` (`settlement_id`);--> statement-breakpoint
ALTER TABLE `drivers` ADD `employment_type` text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE `drivers` ADD `pay_per_mile_cents` integer;--> statement-breakpoint
ALTER TABLE `settlements` ADD `finalized_at` integer;--> statement-breakpoint
ALTER TABLE `settlements` ADD `document_id` text;--> statement-breakpoint
ALTER TABLE `settlements` ADD `payment_reference` text;