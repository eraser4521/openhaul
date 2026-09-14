CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`credit_note_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`method` text NOT NULL,
	`reference` text,
	`issued_at` integer NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`credit_note_id`) REFERENCES `credit_notes`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_org_id_uq` ON `refunds` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `refunds_invoice_idx` ON `refunds` (`org_id`,`invoice_id`);