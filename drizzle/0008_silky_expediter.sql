ALTER TABLE `expenses` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `expenses` ADD `reviewed_by_user_id` text REFERENCES users(id);