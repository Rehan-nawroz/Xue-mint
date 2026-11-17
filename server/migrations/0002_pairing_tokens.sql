-- 0002_pairing_tokens.sql — one-time pairing codes shown in the QR window.
-- Single use (used flag), expire within minutes (expires_at).
-- Stored in the database so any desktop process can mint a token while the
-- server keeps running.

CREATE TABLE IF NOT EXISTS pairing_tokens (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);
