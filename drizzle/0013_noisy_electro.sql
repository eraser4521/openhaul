CREATE TABLE `promises_to_pay` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`promised_for` integer NOT NULL,
	`made_at` integer NOT NULL,
	`contact_name` text,
	`channel` text DEFAULT 'phone' NOT NULL,
	`notes` text,
	`cancelled_at` integer,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promises_to_pay_org_id_uq` ON `promises_to_pay` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `promises_to_pay_invoice_idx` ON `promises_to_pay` (`org_id`,`invoice_id`);--> statement-breakpoint
ALTER TABLE `dunning_settings` ADD `promise_grace_days` integer DEFAULT 3 NOT NULL;