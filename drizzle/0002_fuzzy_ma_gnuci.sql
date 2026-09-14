CREATE TABLE `credit_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` text NOT NULL,
	`invoice_id` text NOT NULL,
	`customer_id` text,
	`claim_id` text,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`issued_at` integer,
	`document_id` text,
	`voided_at` integer,
	`void_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_notes_org_id_uq` ON `credit_notes` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credit_notes_org_number_uq` ON `credit_notes` (`org_id`,`number`);--> statement-breakpoint
CREATE INDEX `credit_notes_invoice_idx` ON `credit_notes` (`invoice_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `credited_cents` integer DEFAULT 0 NOT NULL;