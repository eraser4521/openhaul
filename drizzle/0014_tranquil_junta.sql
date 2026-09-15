CREATE TABLE `cash_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`as_of` integer NOT NULL,
	`recorded_by_user_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_balances_org_id_uq` ON `cash_balances` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `cash_balances_org_as_of_idx` ON `cash_balances` (`org_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `recurring_outgoings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`cadence` text NOT NULL,
	`anchor_on` integer NOT NULL,
	`ends_on` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_outgoings_org_id_uq` ON `recurring_outgoings` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `recurring_outgoings_org_idx` ON `recurring_outgoings` (`org_id`);