CREATE TABLE `statements` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`document_id` text,
	`issued_at` integer NOT NULL,
	`period_from` integer NOT NULL,
	`window_days` integer NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`held_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`open_item_count` integer DEFAULT 0 NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statements_org_id_uq` ON `statements` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `statements_customer_idx` ON `statements` (`org_id`,`customer_id`);