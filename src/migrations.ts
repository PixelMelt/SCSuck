import type { Migration } from './types.ts';

export const MIGRATIONS: Migration[] = [
	{
		id: 1,
		name: 'baseline',
		sql: `
			CREATE TABLE IF NOT EXISTS artists (
				id BIGINT PRIMARY KEY,
				username TEXT NOT NULL,
				permalink TEXT NOT NULL,
				is_active BOOLEAN DEFAULT TRUE,
				last_checked TIMESTAMP DEFAULT NOW()
			);
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
			CREATE TABLE IF NOT EXISTS tracks (
				id BIGINT NOT NULL,
				user_id BIGINT NOT NULL,
				track_key TEXT NOT NULL,
				title TEXT NOT NULL,
				waveform_url TEXT,
				file_path TEXT,
				downloaded_at TIMESTAMP DEFAULT NOW(),
				PRIMARY KEY (track_key)
			);
			CREATE INDEX IF NOT EXISTS idx_tracks_id ON tracks(id);
			CREATE TABLE IF NOT EXISTS artist_aliases (
				id SERIAL PRIMARY KEY,
				artist_id BIGINT NOT NULL REFERENCES artists(id),
				username TEXT NOT NULL,
				permalink TEXT NOT NULL,
				first_seen TIMESTAMP DEFAULT NOW(),
				last_seen TIMESTAMP DEFAULT NOW(),
				UNIQUE(artist_id, username, permalink)
			);
			CREATE INDEX IF NOT EXISTS idx_artist_aliases_artist_id ON artist_aliases(artist_id);
		`,
	},
	{
		id: 2,
		name: 'change-detection-columns',
		sql: `
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artwork_url TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS banner_url TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS downloadable BOOLEAN;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS last_modified TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS duration INTEGER;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS deleted_from_api_at TIMESTAMPTZ;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS revision_of TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS skip_reason TEXT;
			CREATE INDEX IF NOT EXISTS idx_tracks_user_id ON tracks(user_id);
			-- last_checked means "completed a discovery cycle", not "row touched":
			-- new artists must start NULL so they are never skipped as fresh
			ALTER TABLE artists ALTER COLUMN last_checked DROP DEFAULT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS avatar_url TEXT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS banner_url TEXT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS marked_inactive_at TIMESTAMPTZ;
		`,
	},
	{
		id: 3,
		name: 'repair-amended-migration-2',
		sql: `
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artwork_url TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS banner_url TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS downloadable BOOLEAN;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS last_modified TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS duration INTEGER;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS deleted_from_api_at TIMESTAMPTZ;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS revision_of TEXT;
			ALTER TABLE tracks ADD COLUMN IF NOT EXISTS skip_reason TEXT;
			CREATE INDEX IF NOT EXISTS idx_tracks_user_id ON tracks(user_id);
			ALTER TABLE artists ALTER COLUMN last_checked DROP DEFAULT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS avatar_url TEXT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS banner_url TEXT;
			ALTER TABLE artists ADD COLUMN IF NOT EXISTS marked_inactive_at TIMESTAMPTZ;
		`,
	},
	{
		id: 4,
		name: 'cascade-alias-deletion',
		sql: `
			DO $$
			DECLARE con text;
			BEGIN
				FOR con IN
					SELECT conname FROM pg_constraint
					WHERE conrelid = 'artist_aliases'::regclass AND contype = 'f'
				LOOP
					EXECUTE format('ALTER TABLE artist_aliases DROP CONSTRAINT %I', con);
				END LOOP;
			END $$;
			ALTER TABLE artist_aliases
				ADD CONSTRAINT artist_aliases_artist_id_fkey
				FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE;
		`,
	},
	{
		id: 5,
		name: 'requeue-first-gen-drm-unrecoverable',
		sql: `
			UPDATE tracks SET skip_reason = 'drm-only' WHERE skip_reason = 'drm-unrecoverable';
		`,
	},
	{
		id: 6,
		name: 'requeue-sample-aes-generation',
		sql: `
			UPDATE tracks SET skip_reason = 'drm-only' WHERE skip_reason = 'drm-unrecoverable';
		`,
	},
	{
		id: 7,
		name: 'requeue-decode-probe-generation',
		sql: `
			UPDATE tracks SET skip_reason = 'drm-only' WHERE skip_reason = 'drm-unrecoverable';
		`,
	},
	{
		id: 8,
		name: 'requeue-clear-hls-generation',
		sql: `
			UPDATE tracks SET skip_reason = 'drm-only' WHERE skip_reason = 'drm-unrecoverable';
		`,
	},
	{
		id: 9,
		name: 'clear-downloaded-at-on-fileless-rows',
		sql: `
			UPDATE tracks SET downloaded_at = NULL WHERE file_path IS NULL;
		`,
	},
];
