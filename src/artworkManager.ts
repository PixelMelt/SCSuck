import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getTrackBannerUrl, nonDefaultAvatarUrl, saveImage } from './coverArtProcessor.ts';
import { artistDirName, formatDateStamp, pathExists, resolveStoredTrackPath } from './utils.ts';
import type Database from './database.ts';
import type { ArtistRow, SoundcloudTrack, SoundcloudUser, TrackRow } from './types.ts';

function getArtistBannerUrl(artist: SoundcloudUser): string | null {
	const url = artist.visuals?.visuals?.[0]?.visual_url;
	return typeof url === 'string' && url.startsWith('http') ? url : null;
}

function revisionFileName(prefix: string, url: string): string {
	const tag = createHash('sha1').update(url).digest('hex').slice(0, 8);
	return `${prefix}-${formatDateStamp()}-${tag}.jpg`;
}

class ArtworkManager {
	private database: Database;
	private outputDir: string;

	constructor(database: Database, outputDir: string) {
		this.database = database;
		this.outputDir = outputDir;
	}

	private artistDir(artist: SoundcloudUser): string {
		return path.join(this.outputDir, artistDirName(artist.username, artist.id));
	}

	async processArtistImages(
		artist: SoundcloudUser,
		artistRow: ArtistRow | null,
	): Promise<number> {
		const avatarUrl = nonDefaultAvatarUrl(artist.avatar_url);
		const bannerUrl = getArtistBannerUrl(artist);
		const dir = this.artistDir(artist);

		await fs.promises.mkdir(dir, { recursive: true });

		const revisionDir = path.join(dir, 'artwork');

		const avatar = await this.processImageSlot(
			avatarUrl,
			artistRow?.avatar_url ?? null,
			path.join(dir, 'artist.jpg'),
			revisionDir,
			'avatar',
			`avatar for ${artist.username}`,
		);

		const banner = await this.processImageSlot(
			bannerUrl,
			artistRow?.banner_url ?? null,
			path.join(dir, 'banner.jpg'),
			revisionDir,
			'banner',
			`banner for ${artist.username}`,
		);

		await this.database.updateArtistImages(artist.id, avatar.ackUrl, banner.ackUrl);
		return avatar.revisions + banner.revisions;
	}

	private async processImageSlot(
		apiUrl: string | null,
		storedUrl: string | null,
		originalPath: string,
		revisionDir: string,
		revisionPrefix: string,
		label: string,
	): Promise<{ revisions: number; ackUrl: string | null }> {
		if (apiUrl && !(await pathExists(originalPath))) {
			const saved = await saveImage(apiUrl, originalPath);
			if (saved) console.log(` -> Saved ${path.basename(originalPath)} (${label})`);
			return { revisions: 0, ackUrl: apiUrl };
		}
		return this.revisionSlot(apiUrl, storedUrl, revisionDir, revisionPrefix, label);
	}

	private async revisionSlot(
		apiUrl: string | null,
		storedUrl: string | null,
		revisionDir: string,
		revisionPrefix: string,
		label: string,
	): Promise<{ revisions: number; ackUrl: string | null }> {
		if (!apiUrl) return { revisions: 0, ackUrl: storedUrl };
		if (storedUrl == null || storedUrl === apiUrl) return { revisions: 0, ackUrl: apiUrl };

		const revisionPath = path.join(revisionDir, revisionFileName(revisionPrefix, apiUrl));
		const saved = await saveImage(apiUrl, revisionPath);
		if (!saved) return { revisions: 0, ackUrl: storedUrl };
		console.log(` -> Saved image revision ${path.basename(revisionPath)} (${label})`);
		return { revisions: 1, ackUrl: apiUrl };
	}

	async checkTrackImageRevisions(apiTrack: SoundcloudTrack, trackRow: TrackRow): Promise<number> {
		if (!trackRow.file_path) {
			throw new Error(`Archived track ${trackRow.track_key} has no file_path`);
		}

		const absoluteTrackPath = resolveStoredTrackPath(this.outputDir, trackRow.file_path);
		const revisionDir = path.join(path.dirname(absoluteTrackPath), 'artwork');

		const artwork = await this.revisionSlot(
			apiTrack.artwork_url ?? null,
			trackRow.artwork_url,
			revisionDir,
			`cover-${apiTrack.id}`,
			`cover for ${apiTrack.title}`,
		);
		const banner = await this.revisionSlot(
			getTrackBannerUrl(apiTrack),
			trackRow.banner_url,
			revisionDir,
			`banner-${apiTrack.id}`,
			`banner for ${apiTrack.title}`,
		);

		if (artwork.ackUrl !== trackRow.artwork_url || banner.ackUrl !== trackRow.banner_url) {
			await this.database.updateTrackImageState(
				trackRow.track_key,
				artwork.ackUrl,
				banner.ackUrl,
			);
		}
		return artwork.revisions + banner.revisions;
	}
}

export default ArtworkManager;
