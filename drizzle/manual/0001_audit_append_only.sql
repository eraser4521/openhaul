-- Append-only enforcement for evidentiary tables.
--
-- SQLite has no roles and no REVOKE, so this is done with triggers. They stop
-- the application and a careless operator; they do not stop someone with write
-- access to the database file, who can drop them. The hash chain is what
-- detects that -- and only if the head hash is anchored somewhere outside this
-- file. See src/lib/audit/chain.ts.
--
-- Statements are separated by the breakpoint marker below because trigger
-- bodies contain their own semicolons.

DROP TRIGGER IF EXISTS audit_log_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_delete;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS signature_events_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS signature_events_no_delete;
--> statement-breakpoint
-- A signature ceremony is evidence. Once written it is never edited; a
-- correction is a new signature that supersedes the old one.
CREATE TRIGGER signature_events_no_update
BEFORE UPDATE ON signature_events
BEGIN
  SELECT RAISE(ABORT, 'signature_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER signature_events_no_delete
BEFORE DELETE ON signature_events
BEGIN
  SELECT RAISE(ABORT, 'signature_events is append-only');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_no_update_finalized;
--> statement-breakpoint
-- A finalized document is the record. Superseding creates a new row.
CREATE TRIGGER documents_no_update_finalized
BEFORE UPDATE ON documents
WHEN OLD.finalized_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a finalized document cannot be modified, only superseded');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS inspections_no_update_finalized;
--> statement-breakpoint
-- A finalized inspection is frozen. An offline device that edits one gets a
-- 409 and an amendment template, never a silent overwrite.
CREATE TRIGGER inspections_no_update_finalized
BEFORE UPDATE ON inspections
WHEN OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a finalized inspection cannot be modified, only amended');
END;
