-- 0001_init.sql — Xue-Mint initial schema
-- Metadata schema for the desktop server. Photos themselves are plain files on disk; this DB holds metadata only.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,                -- server-generated id (uuid)
    name        TEXT NOT NULL,                   -- shown in the paired-devices UI
    public_key  BLOB NOT NULL UNIQUE,            -- phone's public key (from pairing)
    credential  TEXT NOT NULL,                   -- device credential (hashed at rest; see note)
    paired_at   TEXT NOT NULL,                   -- ISO-8601
    last_seen_at TEXT,
    revoked     INTEGER NOT NULL DEFAULT 0       -- 1 = blocked immediately
);

CREATE TABLE IF NOT EXISTS assets (
    id         TEXT PRIMARY KEY,                 -- server-generated id (uuid)
    hash       TEXT NOT NULL,                    -- BLAKE3 (final pick, Decision Log) hex
    filename   TEXT,
    type       TEXT NOT NULL CHECK (type IN ('photo','video')),
    size       INTEGER NOT NULL,                 -- bytes
    taken_at   TEXT,                             -- from EXIF; NULL if unknown
    gps        TEXT,                             -- from EXIF; NULL if unknown
    width      INTEGER,
    height     INTEGER,
    path       TEXT NOT NULL,                    -- relative path inside the photos folder
    added_at   TEXT NOT NULL                     -- when indexed/uploaded (ISO-8601)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash);   -- dedupe: one hash, one asset
CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at DESC, added_at DESC);  -- timeline

CREATE TABLE IF NOT EXISTS uploads (
    id         TEXT PRIMARY KEY,                 -- upload session id
    device_id  TEXT NOT NULL REFERENCES devices(id),
    hash       TEXT NOT NULL,
    offset     INTEGER NOT NULL DEFAULT 0,       -- resumable progress (bytes)
    total      INTEGER NOT NULL,                 -- expected total bytes
    status     TEXT NOT NULL DEFAULT 'in_progress'
               CHECK (status IN ('in_progress','complete','failed')),
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_device ON uploads(device_id, status);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,                        -- e.g. photos_folder, delete_behavior, port, autostart, mirror_folder
    value TEXT NOT NULL
);

-- NOTE: the device credential column stores a salted hash of the credential, not the
-- plaintext credential. Only the phone keeps the plaintext credential.
