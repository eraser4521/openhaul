CREATE TABLE `accessorial_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`code` text NOT NULL,
	`label` text NOT NULL,
	`unit` text DEFAULT 'flat' NOT NULL,
	`default_cents` integer DEFAULT 0 NOT NULL,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accessorial_rates_org_id_uq` ON `accessorial_rates` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accessorial_rates_org_code_uq` ON `accessorial_rates` (`org_id`,`code`);--> statement-breakpoint
CREATE INDEX `accessorial_rates_org_active_idx` ON `accessorial_rates` (`org_id`,`active`);--> statement-breakpoint
CREATE TABLE `document_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`letterhead_name` text,
	`tagline` text,
	`accent_hex` text,
	`logo_storage_key` text,
	`logo_sha256` text,
	`logo_width` integer,
	`logo_height` integer,
	`show_logo` integer,
	`footer_note` text,
	`addendum` text,
	`remit_to_text` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_templates_org_id_uq` ON `document_templates` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_templates_org_scope_uq` ON `document_templates` (`org_id`,`scope`);--> statement-breakpoint
CREATE TABLE `invoice_accessorials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`rate_id` text,
	`code` text,
	`label` text NOT NULL,
	`unit` text DEFAULT 'flat' NOT NULL,
	`quantity_hundredths` integer DEFAULT 100 NOT NULL,
	`unit_cents` integer DEFAULT 0 NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_accessorials_org_id_uq` ON `invoice_accessorials` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `invoice_accessorials_invoice_idx` ON `invoice_accessorials` (`org_id`,`invoice_id`);