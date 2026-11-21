-- 0003_hardening.sql — Live Photo support and lookup indexes.

-- A Live Photo keeps its still image as the visible asset; the paired video is
-- linked here instead of appearing as a second timeline item.
ALTER TABLE assets ADD COLUMN live_video_path TEXT;

-- Companion videos stay in the library (so dedupe and re-uploads keep working)
-- but are left out of the timeline and library counts.
ALTER TABLE assets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- The watcher checks every file by path before hashing it, and files arrive
-- with an absolute path; the index keeps large-library startup scans linear.
CREATE INDEX IF NOT EXISTS idx_assets_path ON assets(path);

-- Exact-name lookups pair a Live Photo's image and video rows.
CREATE INDEX IF NOT EXISTS idx_assets_filename ON assets(filename);
