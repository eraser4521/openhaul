CREATE TABLE `esign_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`party_email` text,
	`party_name` text NOT NULL,
	`disclosure_version` text NOT NULL,
	`disclosure_sha256` text NOT NULL,
	`scope` text NOT NULL,
	`consented_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`withdrawn_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `esign_consents_org_idx` ON `esign_consents` (`org_id`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_uq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_org_idx` ON `invitations` (`org_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_org_user_uq` ON `memberships` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `monitoring_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`notice_version` text NOT NULL,
	`notice_sha256` text NOT NULL,
	`consented_at` integer NOT NULL,
	`withdrawn_at` integer,
	`ip_address` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `monitoring_consents_user_idx` ON `monitoring_consents` (`user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'carrier' NOT NULL,
	`legal_name` text NOT NULL,
	`dba_name` text,
	`usdot_number` text,
	`mc_number` text,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`country` text DEFAULT 'US' NOT NULL,
	`phone` text,
	`email` text,
	`retention_days` integer DEFAULT 2557 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organizations_usdot_idx` ON `organizations` (`usdot_number`);--> statement-breakpoint
CREATE INDEX `organizations_mc_idx` ON `organizations` (`mc_number`);--> statement-breakpoint
CREATE TABLE `pii_vault` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name_encrypted` text,
	`email_encrypted` text,
	`phone_encrypted` text,
	`address_encrypted` text,
	`dob_encrypted` text,
	`cdl_number_encrypted` text,
	`cdl_blind_index` text,
	`account_last4` text,
	`redacted_at` integer,
	`redaction_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pii_vault_cdl_bidx` ON `pii_vault` (`org_id`,`cdl_blind_index`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_started_at` integer NOT NULL,
	`blocked_until` integer
);
--> statement-breakpoint
CREATE INDEX `rate_limits_window_idx` ON `rate_limits` (`window_started_at`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`absolute_expires_at` integer NOT NULL,
	`mfa_verified_at` integer,
	`ip_created` text,
	`user_agent_created` text,
	`device_label` text,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_idle_expires_idx` ON `sessions` (`idle_expires_at`);--> statement-breakpoint
CREATE TABLE `subject_keys` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	`destroyed_reason` text
);
--> statement-breakpoint
CREATE TABLE `totp_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`activated_at` integer,
	`last_used_step` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `totp_user_uq` ON `totp_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text,
	`display_name` text NOT NULL,
	`phone` text,
	`email_verified_at` integer,
	`disabled_at` integer,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'broker' NOT NULL,
	`usdot_number` text,
	`mc_number` text,
	`contact_name` text,
	`email` text,
	`phone` text,
	`address_line1` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`default_payment_terms` text,
	`notes` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_org_id_uq` ON `customers` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `customers_org_name_idx` ON `customers` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `drivers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`display_name` text NOT NULL,
	`subject_id` text,
	`cdl_state` text,
	`cdl_class` text,
	`cdl_expires_on` integer,
	`medical_card_expires_on` integer,
	`pay_rate_bps` integer,
	`active_at` integer,
	`deactivated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drivers_org_id_uq` ON `drivers` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `drivers_org_idx` ON `drivers` (`org_id`);--> statement-breakpoint
CREATE TABLE `equipment` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`vin` text,
	`plate` text,
	`plate_state` text,
	`transport_type` text,
	`capacity_slots` integer,
	`capacity_lbs` integer,
	`annual_inspection_due_on` integer,
	`active_at` integer,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `equipment_org_id_uq` ON `equipment` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `equipment_org_kind_idx` ON `equipment` (`org_id`,`kind`);--> statement-breakpoint
CREATE TABLE `loads` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`transport_type` text DEFAULT 'open' NOT NULL,
	`inspection_tier` text DEFAULT 'advanced' NOT NULL,
	`customer_id` text,
	`trip_id` text,
	`driver_id` text,
	`rate_cents` integer,
	`tariff_cents` integer,
	`broker_fee_cents` integer,
	`fuel_surcharge_cents` integer,
	`deposit_cents` integer,
	`cod_amount_cents` integer,
	`cod_method` text,
	`cod_location` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`payment_terms` text,
	`payment_method` text,
	`distance_miles` integer,
	`deadhead_miles` integer,
	`purchase_order_number` text,
	`rate_confirmation_number` text,
	`instructions` text,
	`internal_notes` text,
	`dispatched_at` integer,
	`picked_up_at` integer,
	`delivered_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`legal_hold` integer DEFAULT false NOT NULL,
	`retain_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`trip_id`) REFERENCES `trips`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`driver_id`) REFERENCES `drivers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loads_org_id_uq` ON `loads` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loads_org_number_uq` ON `loads` (`org_id`,`number`);--> statement-breakpoint
CREATE INDEX `loads_org_status_idx` ON `loads` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `loads_org_driver_idx` ON `loads` (`org_id`,`driver_id`);--> statement-breakpoint
CREATE TABLE `stops` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`load_id` text NOT NULL,
	`kind` text NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`venue_id` text,
	`date_type` text DEFAULT 'estimated' NOT NULL,
	`scheduled_at` integer,
	`scheduled_ends_at` integer,
	`first_available_at` integer,
	`arrived_at` integer,
	`completed_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`venue_id`) REFERENCES `venues`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stops_org_id_uq` ON `stops` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `stops_load_idx` ON `stops` (`load_id`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`driver_id` text,
	`tractor_id` text,
	`trailer_id` text,
	`started_at` integer,
	`completed_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`driver_id`) REFERENCES `drivers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trips_org_id_uq` ON `trips` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `trips_org_driver_idx` ON `trips` (`org_id`,`driver_id`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`load_id` text NOT NULL,
	`vin` text NOT NULL,
	`vin_check_digit_valid` integer,
	`year` integer,
	`make` text,
	`model` text,
	`trim` text,
	`color` text,
	`vehicle_type` text DEFAULT 'sedan' NOT NULL,
	`body_class` text,
	`plate` text,
	`plate_state` text,
	`lot_number` text,
	`odometer` integer,
	`curb_weight_lbs` integer,
	`declared_value_cents` integer,
	`price_cents` integer,
	`is_inoperable` integer DEFAULT false NOT NULL,
	`inoperable_reason` text,
	`is_oversized` integer DEFAULT false NOT NULL,
	`requires_enclosed` integer DEFAULT false NOT NULL,
	`nhtsa_decoded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vehicles_org_id_uq` ON `vehicles` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `vehicles_load_idx` ON `vehicles` (`load_id`);--> statement-breakpoint
CREATE INDEX `vehicles_org_vin_idx` ON `vehicles` (`org_id`,`vin`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`business_type` text DEFAULT 'business' NOT NULL,
	`address_line1` text NOT NULL,
	`address_line2` text,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`postal_code` text NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`latitude` integer,
	`longitude` integer,
	`contact_name` text,
	`contact_phone` text,
	`contact_email` text,
	`gate_code` text,
	`requires_twic` integer DEFAULT false NOT NULL,
	`hours_note` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `venues_org_id_uq` ON `venues` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `venues_org_city_idx` ON `venues` (`org_id`,`state`,`city`);--> statement-breakpoint
CREATE TABLE `vin_decodes` (
	`vin` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`error_code` text,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `damages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`code` text NOT NULL,
	`area_code` text NOT NULL,
	`type_code` text NOT NULL,
	`severity_code` text NOT NULL,
	`grid_code` text,
	`code_version` text NOT NULL,
	`description` text,
	`diagram_x` text,
	`diagram_y` text,
	`diagram_view` text,
	`pre_existing` integer DEFAULT false NOT NULL,
	`non_transportation` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`inspection_id`) REFERENCES `inspections`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `damages_org_id_uq` ON `damages` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `damages_inspection_idx` ON `damages` (`inspection_id`);--> statement-breakpoint
CREATE TABLE `inspection_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`inspection_id` text NOT NULL,
	`slot` text,
	`damage_id` text,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_type` text NOT NULL,
	`width` integer,
	`height` integer,
	`exif_captured_at` integer,
	`exif_latitude` text,
	`exif_longitude` text,
	`exif_device` text,
	`captured_latitude` text,
	`captured_longitude` text,
	`within_geofence` integer,
	`uploaded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`inspection_id`) REFERENCES `inspections`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inspection_photos_org_id_uq` ON `inspection_photos` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `inspection_photos_inspection_idx` ON `inspection_photos` (`inspection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `inspection_photos_org_sha_uq` ON `inspection_photos` (`org_id`,`inspection_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`load_id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`stage` text NOT NULL,
	`tier` text DEFAULT 'advanced' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`driver_id` text,
	`odometer` integer,
	`fuel_level_eighths` integer,
	`keys_present` integer,
	`personal_items_present` integer,
	`personal_items_note` text,
	`limitation_note` text,
	`latitude` text,
	`longitude` text,
	`location_accuracy_m` integer,
	`location_source` text,
	`started_at` integer,
	`completed_at` integer,
	`client_claimed_at` integer,
	`finalized_at` integer,
	`content_hash` text,
	`amends_inspection_id` text,
	`amendment_reason` text,
	`created_offline` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`vehicle_id`) REFERENCES `vehicles`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`driver_id`) REFERENCES `drivers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inspections_org_id_uq` ON `inspections` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `inspections_load_idx` ON `inspections` (`load_id`);--> statement-breakpoint
CREATE INDEX `inspections_vehicle_stage_idx` ON `inspections` (`vehicle_id`,`stage`);--> statement-breakpoint
CREATE TABLE `signature_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`subject` text NOT NULL,
	`document_version` integer DEFAULT 1 NOT NULL,
	`document_sha256` text NOT NULL,
	`signer_role` text NOT NULL,
	`signer_name_printed` text NOT NULL,
	`signer_user_id` text,
	`signer_email` text,
	`signer_phone` text,
	`auth_method` text NOT NULL,
	`auth_evidence_id` text,
	`attesting_user_id` text,
	`intent_text` text NOT NULL,
	`intent_sha256` text NOT NULL,
	`signature_method` text NOT NULL,
	`signature_image_sha256` text,
	`signature_storage_key` text,
	`signature_strokes` text,
	`signed_at` integer NOT NULL,
	`client_claimed_at` integer,
	`ip_address` text,
	`user_agent` text,
	`device_fingerprint` text,
	`latitude` text,
	`longitude` text,
	`location_accuracy_m` integer,
	`geo_consent` integer DEFAULT false NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`customer_unavailable` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signature_events_org_id_uq` ON `signature_events` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `signature_events_subject_idx` ON `signature_events` (`subject`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`load_id` text,
	`driver_id` text,
	`category` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`incurred_at` integer NOT NULL,
	`vendor` text,
	`notes` text,
	`receipt_storage_key` text,
	`receipt_sha256` text,
	`reimbursable` integer DEFAULT false NOT NULL,
	`reimbursed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_org_id_uq` ON `expenses` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `expenses_org_load_idx` ON `expenses` (`org_id`,`load_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` text NOT NULL,
	`load_id` text,
	`customer_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`line_haul_cents` integer DEFAULT 0 NOT NULL,
	`fuel_surcharge_cents` integer DEFAULT 0 NOT NULL,
	`accessorial_cents` integer DEFAULT 0 NOT NULL,
	`cod_collected_cents` integer DEFAULT 0 NOT NULL,
	`deposit_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`terms` text,
	`issued_at` integer,
	`due_at` integer,
	`sent_at` integer,
	`paid_at` integer,
	`voided_at` integer,
	`void_reason` text,
	`factoring_company_name` text,
	`factoring_notice_text` text,
	`notes` text,
	`document_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_org_id_uq` ON `invoices` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_org_number_uq` ON `invoices` (`org_id`,`number`);--> statement-breakpoint
CREATE INDEX `invoices_org_status_idx` ON `invoices` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`method` text NOT NULL,
	`reference` text,
	`received_at` integer NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`,`invoice_id`) REFERENCES `invoices`(`org_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_org_id_uq` ON `payments` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `payments_invoice_idx` ON `payments` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`driver_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`gross_revenue_cents` integer DEFAULT 0 NOT NULL,
	`broker_fees_cents` integer DEFAULT 0 NOT NULL,
	`pay_rate_bps` integer,
	`driver_pay_cents` integer DEFAULT 0 NOT NULL,
	`reimbursements_cents` integer DEFAULT 0 NOT NULL,
	`deductions_cents` integer DEFAULT 0 NOT NULL,
	`net_pay_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`paid_at` integer,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settlements_org_id_uq` ON `settlements` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `settlements_org_driver_idx` ON `settlements` (`org_id`,`driver_id`);--> statement-breakpoint
CREATE TABLE `audit_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`head_seq` integer NOT NULL,
	`head_hash` text NOT NULL,
	`entry_count` integer NOT NULL,
	`anchored_at` integer NOT NULL,
	`exported_to` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`org_id` text NOT NULL,
	`actor_id` text,
	`actor_role` text,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`ip_address` text,
	`user_agent` text,
	`request_id` text,
	`at` integer NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_org_at_idx` ON `audit_log` (`org_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_subject_idx` ON `audit_log` (`subject`);--> statement-breakpoint
CREATE INDEX `audit_log_action_idx` ON `audit_log` (`action`);--> statement-breakpoint
CREATE TABLE `carrier_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`usdot_number` text NOT NULL,
	`mc_number` text,
	`legal_name` text,
	`dba_name` text,
	`allowed_to_operate` integer,
	`out_of_service` integer,
	`out_of_service_at` integer,
	`safety_rating` text,
	`source` text NOT NULL,
	`raw` text,
	`checked_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carrier_checks_org_id_uq` ON `carrier_checks` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `carrier_checks_usdot_idx` ON `carrier_checks` (`usdot_number`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` text NOT NULL,
	`load_id` text,
	`vehicle_id` text,
	`customer_id` text,
	`status` text DEFAULT 'filed' NOT NULL,
	`claimant_name` text NOT NULL,
	`claimant_email` text,
	`demand_amount_cents` integer,
	`description` text NOT NULL,
	`filed_at` integer NOT NULL,
	`acknowledge_due_at` integer NOT NULL,
	`acknowledged_at` integer,
	`resolve_due_at` integer NOT NULL,
	`next_status_due_at` integer,
	`offer_amount_cents` integer,
	`offered_at` integer,
	`settled_amount_cents` integer,
	`settled_at` integer,
	`declined_at` integer,
	`decline_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`,`load_id`) REFERENCES `loads`(`org_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`,`customer_id`) REFERENCES `customers`(`org_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_org_id_uq` ON `claims` (`org_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_org_number_uq` ON `claims` (`org_id`,`number`);--> statement-breakpoint
CREATE INDEX `claims_org_status_idx` ON `claims` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`load_id` text,
	`subject` text,
	`title` text NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_type` text DEFAULT 'application/pdf' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_document_id` text,
	`finalized_at` integer,
	`location_protected` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_org_id_uq` ON `documents` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `documents_org_load_idx` ON `documents` (`org_id`,`load_id`);--> statement-breakpoint
CREATE INDEX `documents_subject_idx` ON `documents` (`subject`);--> statement-breakpoint
CREATE TABLE `insurance_certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`kind` text NOT NULL,
	`insurer_name` text NOT NULL,
	`policy_number` text NOT NULL,
	`coverage_limit_cents` integer,
	`deductible_cents` integer,
	`effective_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`document_id` text,
	`verified_at` integer,
	`verified_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insurance_certificates_org_id_uq` ON `insurance_certificates` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `insurance_certificates_expiry_idx` ON `insurance_certificates` (`org_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `legal_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`subject` text NOT NULL,
	`reason` text NOT NULL,
	`placed_by_user_id` text,
	`placed_at` integer NOT NULL,
	`released_at` integer,
	`released_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`placed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`released_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `legal_holds_org_subject_idx` ON `legal_holds` (`org_id`,`subject`);--> statement-breakpoint
CREATE TABLE `retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`record_class` text NOT NULL,
	`anchor_type` text NOT NULL,
	`retention_days` integer NOT NULL,
	`citation` text NOT NULL,
	`floor_days` integer NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_policies_org_class_uq` ON `retention_policies` (`org_id`,`record_class`);