CREATE TABLE `customer_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`direction` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`invoice_id` text NOT NULL,
	`credit_note_id` text,
	`occurred_at` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`credit_note_id`) REFERENCES `credit_notes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_credits_org_id_uq` ON `customer_credits` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `customer_credits_customer_idx` ON `customer_credits` (`org_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_credits_invoice_idx` ON `customer_credits` (`org_id`,`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `applied_credit_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `carried_forward_cents` integer DEFAULT 0 NOT NULL;