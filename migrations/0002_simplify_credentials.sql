-- All stored credentials are available to the authenticated Agent.
-- Keep credential IDs, ciphertext and encryption keys unchanged.
-- Discard short-lived grants issued under the old schema.
DELETE FROM handoffs;
ALTER TABLE credentials DROP COLUMN allow_agent_use;
ALTER TABLE credentials DROP COLUMN provider;
ALTER TABLE handoffs DROP COLUMN purpose;
ALTER TABLE activity DROP COLUMN destination;
