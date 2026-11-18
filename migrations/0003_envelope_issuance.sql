-- Short-lived issuance budget/replay metadata only. Never ciphertext or keys.
CREATE TABLE envelope_issuance (
 user_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 key_fingerprint TEXT NOT NULL,
 issued_at INTEGER NOT NULL,
 PRIMARY KEY (user_id, request_id),
 UNIQUE (user_id, key_fingerprint)
);
CREATE INDEX envelope_issuance_time ON envelope_issuance(user_id, issued_at);
