CREATE TABLE `document_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`document_id` text NOT NULL,
	`to_addresses` text NOT NULL,
	`cc_addresses` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`message_id` text,
	`error` text,
	`document_sha256` text NOT NULL,
	`actor_id` text,
	`attempted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`document_id`) REFERENCES `documents`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_sends_org_id_uq` ON `document_sends` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `document_sends_document_idx` ON `document_sends` (`document_id`);