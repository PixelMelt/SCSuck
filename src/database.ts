import pg from 'pg';
import { MIGRATIONS } from './migrations.ts';
import { errorMessage } from './utils.ts';
import type {
	AddTrackData,
	ArtistRow,
	DatabaseConfig,
	NewArtistData,
	SkippedTrackData,
	SkipReason,
	TrackRow,
	TrackSoundState,
} from './types.ts';

const { Pool } = pg;

class Database {
	private config: DatabaseConfig;
	private debug: boolean;
	private pool: pg.Pool;
	private log: (...args: unknown[]) => void;

	constructor(config: DatabaseConfig, debug: boolean) {
		this.config = config;
		this.debug = debug;
		this.pool = new Pool(config);
		this.log = this.debug ? console.log : () => {};
	}

	async connect(): Promise<void> {
		try {
			await this.establishConnection();
			await this.runMigrations();
		} catch (error) {
			await this.pool.end();
			throw error;
		}
	}

	private async establishConnection(): Promise<void> {
		try {
			await this.verifyConnection();
		} catch (err) {
			if ((err as { code?: string }).code !== '3D000') {
				console.error(`Failed to connect to database "${this.config.database}":`, err);
				throw err;
			}
			this.log(`Database "${this.config.database}" does not exist. Attempting to create...`);
			await this.createDatabase();
			this.log(`Database "${this.config.database}" created. Retrying connection...`);
			try {
				await this.verifyConnection();
			} catch (retryErr) {
				console.error(`Failed to connect to database "${this.config.database}":`, retryErr);
				throw retryErr;
			}
		}
	}

	private async verifyConnection(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query('SELECT NOW()');
		} finally {
			client.release();
		}
		this.log('Connected to database successfully');
	}

	private async createDatabase(): Promise<void> {
		const tempPool = new Pool({ ...this.config, database: 'postgres' });
		let client: pg.PoolClient | undefined;
		try {
			client = await tempPool.connect();
			await client.query(`CREATE DATABASE "${this.config.database}" TEMPLATE template0`);
		} catch (err) {
			console.error(`Error creating database "${this.config.database}":`, err);
			throw err;
		} finally {
			client?.release();
			await tempPool.end();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
		this.log('Database connection closed');
	}

	private async runMigrations(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				id INT PRIMARY KEY,
				name TEXT,
				applied_at TIMESTAMPTZ DEFAULT NOW()
			)
		`);

		const { rows } = await this.pool.query('SELECT id FROM schema_migrations');
		const applied = new Set(rows.map((r) => Number(r.id)));

		for (const migration of MIGRATIONS) {
			if (applied.has(migration.id)) continue;

			const client = await this.pool.connect();
			try {
				await client.query('BEGIN');
				await client.query(migration.sql);
				await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
					migration.id,
					migration.name,
				]);
				await client.query('COMMIT');
				this.log(`Applied migration ${migration.id} (${migration.name})`);
			} catch (err) {
				await client.query('ROLLBACK');
				throw new Error(
					`Migration ${migration.id} (${migration.name}) failed: ${errorMessage(err)}`,
				);
			} finally {
				client.release();
			}
		}
	}

	private async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		params: unknown[] = [],
	): Promise<pg.QueryResult<R>> {
		try {
			return await this.pool.query<R>(text, params);
		} catch (err) {
			if (this.debug) {
				console.error('Error executing query:', err);
			} else {
				console.error(`Query failed: ${errorMessage(err)}`);
			}
			throw err;
		}
	}

	async getArtistById(id: number | string): Promise<ArtistRow | null> {
		const { rows } = await this.query<ArtistRow>('SELECT * FROM artists WHERE id = $1', [id]);
		return rows[0] ?? null;
	}

	async getActiveArtistByRef(ref: string): Promise<ArtistRow | null> {
		const { rows } = await this.query<ArtistRow>(
			`SELECT * FROM artists WHERE is_active = TRUE AND (permalink = $1 OR id::text = $1)
			 ORDER BY (id::text = $1) DESC LIMIT 1`,
			[ref],
		);
		return rows[0] ?? null;
	}

	async getArtistByRef(ref: string): Promise<ArtistRow | null> {
		const { rows } = await this.query<ArtistRow>(
			`SELECT * FROM artists WHERE permalink = $1 OR id::text = $1
			 ORDER BY (id::text = $1) DESC LIMIT 1`,
			[ref],
		);
		return rows[0] ?? null;
	}

	async insertArtist(artistData: NewArtistData): Promise<ArtistRow> {
		const { rows } = await this.query<ArtistRow>(
			`
			INSERT INTO artists (id, username, permalink)
			VALUES ($1, $2, $3)
			RETURNING *
			`,
			[artistData.id, artistData.username, artistData.permalink],
		);
		return rows[0]!;
	}

	async reactivateArtist(id: number | string): Promise<ArtistRow> {
		const { rows } = await this.query<ArtistRow>(
			`
			UPDATE artists SET is_active = TRUE, marked_inactive_at = NULL, last_checked = NULL
			WHERE id = $1
			RETURNING *
			`,
			[id],
		);
		return rows[0]!;
	}

	async updateArtistIdentity(
		id: number | string,
		username: string,
		permalink: string,
	): Promise<void> {
		await this.query('UPDATE artists SET username = $2, permalink = $3 WHERE id = $1', [
			id,
			username,
			permalink,
		]);
	}

	async getAllArtists(): Promise<ArtistRow[]> {
		const { rows } = await this.query<ArtistRow>(
			'SELECT * FROM artists WHERE is_active = TRUE ORDER BY username',
		);
		return rows;
	}

	async getEncryptionRecoveryArtists(): Promise<ArtistRow[]> {
		return (
			await this
				.query<ArtistRow>(`SELECT a.* FROM artists a WHERE a.is_active = TRUE AND EXISTS (
			SELECT 1 FROM tracks t WHERE t.user_id = a.id AND t.skip_reason IN ('drm-only', 'drm-unrecoverable')
		) ORDER BY a.username`)
		).rows;
	}

	async requeueEncryptionFailures(): Promise<number> {
		return (
			await this.query(`UPDATE tracks SET skip_reason = 'drm-only'
			WHERE skip_reason = 'drm-unrecoverable' AND file_path IS NULL`)
		).rowCount!;
	}

	async removeArtist(id: number | string): Promise<void> {
		await this.query('DELETE FROM artists WHERE id = $1', [id]);
	}

	async markArtistInactive(artistId: number | string): Promise<void> {
		await this.query(
			'UPDATE artists SET is_active = FALSE, marked_inactive_at = NOW() WHERE id = $1',
			[artistId],
		);
	}

	async updateArtistImages(
		id: number | string,
		avatarUrl: string | null,
		bannerUrl: string | null,
	): Promise<void> {
		await this.query('UPDATE artists SET avatar_url = $2, banner_url = $3 WHERE id = $1', [
			id,
			avatarUrl,
			bannerUrl,
		]);
	}

	async recordArtistAlias(
		artistId: number | string,
		username: string,
		permalink: string,
	): Promise<void> {
		await this.query(
			`
			INSERT INTO artist_aliases (artist_id, username, permalink, first_seen, last_seen)
			VALUES ($1, $2, $3, NOW(), NOW())
			ON CONFLICT (artist_id, username, permalink)
			DO UPDATE SET last_seen = NOW()
			`,
			[artistId, username, permalink],
		);
	}

	async getArtistAliasUsernames(artistId: number | string): Promise<string[]> {
		const { rows } = await this.query<{ username: string }>(
			'SELECT username FROM artist_aliases WHERE artist_id = $1 ORDER BY first_seen',
			[artistId],
		);
		return rows.map((row) => row.username);
	}

	async updateArtistLastChecked(id: number | string): Promise<void> {
		await this.query('UPDATE artists SET last_checked = NOW() WHERE id = $1', [id]);
	}

	async updateArtistTrackPathPrefix(
		artistId: number | string,
		oldDirName: string,
		newDirName: string,
		libraryRoot: string,
	): Promise<number> {
		const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = `^(${escape(libraryRoot)}/)?${escape(oldDirName)}/`;
		const replacement = `\\1${newDirName}/`;
		const { rowCount } = await this.query(
			`UPDATE tracks
			SET file_path = REGEXP_REPLACE(file_path, $1, $2)
			WHERE user_id = $3`,
			[pattern, replacement, artistId],
		);
		return rowCount!;
	}

	async getTrackByKey(trackKey: string): Promise<TrackRow | null> {
		const { rows } = await this.query<TrackRow>('SELECT * FROM tracks WHERE track_key = $1', [
			trackKey,
		]);
		return rows[0] ?? null;
	}

	async getTracksByArtist(userId: number | string): Promise<TrackRow[]> {
		const { rows } = await this.query<TrackRow>('SELECT * FROM tracks WHERE user_id = $1', [
			userId,
		]);
		return rows;
	}

	async addTrack(trackData: AddTrackData): Promise<void> {
		const {
			id,
			track_key,
			user_id,
			title,
			waveform_url,
			file_path,
			artwork_url,
			banner_url,
			downloadable,
			last_modified,
			duration,
			revision_of,
		} = trackData;

		await this.query(
			`
			INSERT INTO tracks
				(id, track_key, user_id, title, waveform_url, file_path,
				 artwork_url, banner_url, downloadable, last_modified, duration, revision_of)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
			ON CONFLICT (track_key) DO UPDATE
			SET title = $4,
				waveform_url = $5,
				file_path = $6,
				downloaded_at = NOW(),
				artwork_url = $7,
				banner_url = $8,
				downloadable = $9,
				last_modified = $10,
				duration = $11,
				revision_of = $12,
				skip_reason = NULL
			`,
			[
				id,
				track_key,
				user_id,
				title,
				waveform_url,
				file_path,
				artwork_url,
				banner_url,
				downloadable,
				last_modified,
				duration,
				revision_of,
			],
		);
	}

	async updateTrackSoundState(trackKey: string, state: TrackSoundState): Promise<void> {
		await this.query(
			`UPDATE tracks
			 SET waveform_url = $2, duration = $3, downloadable = $4, last_modified = $5
			 WHERE track_key = $1`,
			[trackKey, state.waveform_url, state.duration, state.downloadable, state.last_modified],
		);
	}

	async updateTrackImageState(
		trackKey: string,
		artworkUrl: string | null,
		bannerUrl: string | null,
	): Promise<void> {
		await this.query(
			'UPDATE tracks SET artwork_url = $2, banner_url = $3 WHERE track_key = $1',
			[trackKey, artworkUrl, bannerUrl],
		);
	}

	async markTrackSkipped(data: SkippedTrackData, reason: SkipReason): Promise<void> {
		await this.query(
			`
			INSERT INTO tracks (id, track_key, user_id, title, skip_reason, downloadable, downloaded_at)
			VALUES ($1, $2, $3, $4, $5, $6, NULL)
			ON CONFLICT (track_key) DO UPDATE SET skip_reason = $5, downloadable = $6
			`,
			[data.id, data.track_key, data.user_id, data.title, reason, data.downloadable],
		);
	}

	async acknowledgeDownloadEnabled(trackKey: string): Promise<void> {
		await this.query('UPDATE tracks SET downloadable = TRUE WHERE track_key = $1', [trackKey]);
	}

	async markTracksDeleted(trackKeys: string[]): Promise<void> {
		await this.query(
			`UPDATE tracks SET deleted_from_api_at = NOW()
			 WHERE track_key = ANY($1) AND deleted_from_api_at IS NULL`,
			[trackKeys],
		);
	}

	async clearTracksDeleted(trackKeys: string[]): Promise<void> {
		await this.query(`UPDATE tracks SET deleted_from_api_at = NULL WHERE track_key = ANY($1)`, [
			trackKeys,
		]);
	}
}

export default Database;
