ALTER TABLE `document_sends` ADD `bounced_at` integer;--> statement-breakpoint
ALTER TABLE `document_sends` ADD `bounce_type` text;--> statement-breakpoint
ALTER TABLE `document_sends` ADD `bounce_code` text;--> statement-breakpoint
ALTER TABLE `document_sends` ADD `bounce_recipient` text;--> statement-breakpoint
ALTER TABLE `document_sends` ADD `bounce_diagnostic` text;