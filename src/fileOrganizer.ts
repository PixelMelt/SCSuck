import fs from 'fs';
import path from 'path';
import sanitize from 'sanitize-filename';
import {
	MAX_FILENAME_LENGTH,
	MAX_PATH_LENGTH,
	artistDirName,
	byteLength,
	cleanupFile,
	errorMessage,
	pathExists,
	removeIfEmpty,
	resolveStoredTrackPath,
	sanitizeNameComponent,
	truncateToBytes,
} from './utils.ts';
import {
	getTrackBannerUrl,
	resolveTrackCoverUrl,
	saveBanner,
	saveImage,
} from './coverArtProcessor.ts';
import { displayTitle } from './titleParser.ts';
import type {
	AudioQuality,
	EnrichedTrack,
	FinalizedTrack,
	OrganizeAlbumResult,
	OrganizeSingleResult,
	SinglePrep,
	SoundcloudPlaylist,
} from './types.ts';

export function formatFolderName(
	artist: string,
	title: string,
	year: number,
	fileExt: string,
	audioQuality: AudioQuality,
	id: number,
	maxBytes: number = MAX_FILENAME_LENGTH,
): string {
	const upperExt = fileExt.toUpperCase();

	let baseName = `${artist} - ${title}`;
	const suffix = audioQuality.isLossless
		? ` (${year}) [WEB-${upperExt}] [${audioQuality.bitDepth}B-${Math.round(audioQuality.sampleRate / 100) / 10}kHz] [${id}]`
		: ` (${year}) [WEB-${upperExt}] [${audioQuality.bitRate}kbps] [${id}]`;

	const availableBytes = maxBytes - byteLength(suffix);
	if (availableBytes < 0) {
		throw new Error(
			`Release folder budget ${maxBytes} cannot hold the identity suffix "${suffix}"`,
		);
	}
	if (byteLength(baseName) > availableBytes) {
		baseName =
			availableBytes > 3
				? truncateToBytes(baseName, availableBytes)
				: truncateToBytes(baseName, availableBytes, '');
	}

	return sanitize(baseName + suffix);
}

function bestPrep(preparations: SinglePrep[]): SinglePrep {
	return preparations.reduce((best, prep) => {
		const candidate = prep.audioQuality;
		const incumbent = best.audioQuality;
		if (candidate.isLossless !== incumbent.isLossless) {
			return candidate.isLossless ? prep : best;
		}
		if (candidate.isLossless) {
			return candidate.bitDepth * candidate.sampleRate >
				incumbent.bitDepth * incumbent.sampleRate
				? prep
				: best;
		}
		return candidate.bitRate > incumbent.bitRate ? prep : best;
	});
}

class FileOrganizer {
	private outputDir: string;
	private tempDir: string;

	constructor(outputDir: string, tempDir: string) {
		this.outputDir = outputDir;
		this.tempDir = tempDir;
	}

	private async moveFile(source: string, destination: string): Promise<void> {
		try {
			await fs.promises.rename(source, destination);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
				console.error(`Move file failed: ${source} -> ${destination}`, error);
				throw error;
			}
			console.warn(
				`Rename failed (cross-device?), falling back to copy for ${source} -> ${destination}`,
			);
		}

		const staged = `${destination}.partial`;
		try {
			await fs.promises.copyFile(source, staged);
			await fs.promises.rename(staged, destination);
		} catch (copyError) {
			console.error(`Cross-device copy failed:`, copyError);
			await cleanupFile(staged, 'partial cross-device copy');
			throw copyError;
		}
		await cleanupFile(source, 'cross-device copy source');
	}

	private folderNameBudget(artistDir: string): number {
		const fileReserve = 30;
		return Math.min(
			MAX_FILENAME_LENGTH,
			MAX_PATH_LENGTH - byteLength(artistDir) - 1 - fileReserve,
		);
	}

	private saniTitle(track: EnrichedTrack, artistNames: string[]): string {
		let title = sanitize(displayTitle(track, artistNames)).trim();
		if (!title) {
			title = sanitize(track.permalink ?? '').trim() || `track-${track.id}`;
		}
		if (byteLength(title) > 100) {
			title = truncateToBytes(title, 97);
		}
		return title;
	}

	async retireUpgradedFile(oldFilePath: string, newFinalPath: string): Promise<void> {
		const oldAbs = path.resolve(resolveStoredTrackPath(this.outputDir, oldFilePath));
		const newAbs = path.resolve(newFinalPath);
		if (oldAbs === newAbs) return;

		console.log(` -> Removing superseded file: ${oldAbs}`);
		await cleanupFile(oldAbs, 'superseded stream copy');

		const oldDir = path.dirname(oldAbs);
		const newDir = path.dirname(newAbs);
		if (oldDir === newDir) return;

		try {
			const remaining = await fs.promises.readdir(oldDir);
			const removable = new Set(['cover.jpg', 'banner.jpg', 'artwork']);
			if (remaining.length === 0 || remaining.every((f) => removable.has(f))) {
				if (remaining.includes('artwork')) {
					const src = path.join(oldDir, 'artwork');
					const dest = path.join(newDir, 'artwork');
					try {
						await fs.promises.rename(src, dest);
					} catch {
						const stranded: string[] = [];
						for (const f of await fs.promises.readdir(src)) {
							try {
								await fs.promises.rename(path.join(src, f), path.join(dest, f));
							} catch {
								stranded.push(f);
							}
						}
						if (stranded.length > 0) {
							console.warn(
								` -> Left ${stranded.length} artwork revision(s) in ${src}: ${stranded.join(', ')}`,
							);
						}
						await removeIfEmpty(src);
					}
				}
				for (const f of ['cover.jpg', 'banner.jpg']) {
					await cleanupFile(path.join(oldDir, f), 'superseded art');
				}
				if (await removeIfEmpty(oldDir)) {
					console.log(` -> Removed superseded directory: ${oldDir}`);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				console.warn(
					` -> Could not tidy superseded directory ${oldDir}: ${errorMessage(error)}`,
				);
			}
		}
	}

	async organizeSingle(
		track: EnrichedTrack,
		tempPath: string,
		fileExt: string,
		audioQuality: AudioQuality,
		artistNames: string[],
	): Promise<OrganizeSingleResult> {
		let singleDir: string | null = null;
		let createdTrackFile: string | null = null;

		try {
			console.log(` -> Organizing single track: ${track.title}`);
			const releaseYear = new Date(track.created_at).getFullYear();

			const artistFolder = artistDirName(track.user.username, track.user.id);
			const saniArtistName = sanitizeNameComponent(track.user.username);
			const saniTrackTitle = this.saniTitle(track, artistNames);

			const artistDir = path.join(this.outputDir, artistFolder);
			await fs.promises.mkdir(artistDir, { recursive: true });

			const singleDirName = formatFolderName(
				saniArtistName,
				saniTrackTitle,
				releaseYear,
				fileExt,
				audioQuality,
				track.id,
				this.folderNameBudget(artistDir),
			);
			singleDir = path.join(artistDir, singleDirName);

			await fs.promises.mkdir(singleDir, { recursive: true });

			const trackFileName = this.budgetedTrackFileName(
				singleDir,
				'01',
				saniTrackTitle,
				fileExt,
			);
			const finalTrackLocation = path.join(singleDir, trackFileName);

			if (byteLength(finalTrackLocation) > MAX_PATH_LENGTH) {
				throw new Error(
					`Calculated final file path too long (${byteLength(finalTrackLocation)} > ${MAX_PATH_LENGTH}): ${finalTrackLocation}`,
				);
			}

			const destinationExisted = await pathExists(finalTrackLocation);
			console.log(` -> Moving to final location: ${finalTrackLocation}`);
			await this.moveFile(tempPath, finalTrackLocation);
			if (!destinationExisted) createdTrackFile = finalTrackLocation;

			const coverPath = path.join(singleDir, 'cover.jpg');
			const coverUrl = resolveTrackCoverUrl(track);
			if (coverUrl && !(await pathExists(coverPath))) {
				const saved = await saveImage(coverUrl, coverPath);
				if (saved) {
					console.log(` -> Saved cover.jpg for single track ${track.title}`);
				} else {
					console.warn(` -> Failed to save cover.jpg for single track ${track.title}`);
				}
			}

			const bannerUrl = getTrackBannerUrl(track);
			const bannerPath = path.join(singleDir, 'banner.jpg');
			if (bannerUrl && !(await pathExists(bannerPath))) {
				const saved = await saveBanner(bannerUrl, bannerPath);
				if (saved) console.log(` -> Saved banner.jpg for single track ${track.title}`);
			}

			const relativePath = path.relative(this.outputDir, finalTrackLocation);

			return {
				success: true,
				finalPath: finalTrackLocation,
				relativePath,
			};
		} catch (error) {
			console.error(` -> Error in organizeSingle for ${track.title}: ${errorMessage(error)}`);
			await cleanupFile(createdTrackFile, 'final single track');
			if (singleDir && (await removeIfEmpty(singleDir))) {
				console.log(` -> Cleaned up empty single directory: ${singleDir}`);
			}
			return { success: false };
		}
	}

	private budgetedTrackFileName(
		dir: string,
		trackIndexPadded: string,
		title: string,
		fileExt: string,
	): string {
		const maxFilenameBytes = MAX_PATH_LENGTH - byteLength(dir) - 1;
		const prefixAndExtBytes = byteLength(trackIndexPadded + '. ') + byteLength('.' + fileExt);
		const maxTitleBytes = maxFilenameBytes - prefixAndExtBytes;

		let finalTitle = title;
		if (byteLength(finalTitle) > maxTitleBytes) {
			const targetBytes = Math.max(20, maxTitleBytes - 3);
			finalTitle = truncateToBytes(finalTitle, targetBytes);
			if (byteLength(finalTitle) <= 20) {
				console.warn(` -> Title extremely truncated due to path limits: ${finalTitle}`);
			}
		}
		return `${trackIndexPadded}. ${finalTitle}.${fileExt}`;
	}

	private async newAlbumDir(
		albumContext: SoundcloudPlaylist,
		successfulPreparations: SinglePrep[],
		artist: EnrichedTrack['user'],
	): Promise<string> {
		const best = bestPrep(successfulPreparations);

		const releaseYear = new Date(
			albumContext.release_date || albumContext.created_at,
		).getFullYear();

		const saniArtistName = sanitizeNameComponent(artist.username);

		let saniAlbumTitle = sanitize(albumContext.title).trim();
		if (!saniAlbumTitle) {
			saniAlbumTitle =
				sanitize(albumContext.permalink ?? '').trim() || `album-${albumContext.id}`;
		}
		if (byteLength(saniAlbumTitle) > 100) {
			saniAlbumTitle = truncateToBytes(saniAlbumTitle, 97);
		}

		const artistDir = path.join(this.outputDir, artistDirName(artist.username, artist.id));
		await fs.promises.mkdir(artistDir, { recursive: true });

		const albumFolderName = formatFolderName(
			saniArtistName,
			saniAlbumTitle,
			releaseYear,
			best.fileExt,
			best.audioQuality,
			albumContext.id,
			this.folderNameBudget(artistDir),
		);
		const albumDir = path.join(artistDir, albumFolderName);

		return albumDir;
	}

	async organizeAlbum(
		albumContext: SoundcloudPlaylist,
		successfulPreparations: SinglePrep[],
		artistNames: string[],
		existingTrackPath: string | null,
	): Promise<OrganizeAlbumResult> {
		const finalizedTracks: FinalizedTrack[] = [];
		let albumDir: string | null = null;
		let albumDirExisted = false;
		const createdFiles: string[] = [];
		const artist = successfulPreparations[0]!.track.user;

		try {
			console.log(` -> Organizing album: ${albumContext.title}`);

			if (existingTrackPath) {
				albumDir = path.dirname(resolveStoredTrackPath(this.outputDir, existingTrackPath));
			} else {
				albumDir = await this.newAlbumDir(albumContext, successfulPreparations, artist);
			}

			albumDirExisted = await pathExists(albumDir);
			await fs.promises.mkdir(albumDir, { recursive: true });

			const folderJpgPath = path.join(albumDir, 'folder.jpg');
			if (albumContext.artwork_url && !(await pathExists(folderJpgPath))) {
				const saved = await saveImage(albumContext.artwork_url, folderJpgPath);
				if (saved) {
					createdFiles.push(folderJpgPath);
					console.log(` -> Saved folder.jpg for album ${albumContext.title}`);
				} else {
					console.warn(` -> Failed to save folder.jpg for album ${albumContext.title}`);
				}
			}

			for (const prep of successfulPreparations) {
				const { track, tempPath, fileExt } = prep;
				let createdTrackFile: string | null = null;
				let tempTrackCoverPath: string | null = null;

				try {
					const trackIndexPadded = String(track.trackIndex).padStart(2, '0');
					const saniTrackTitle = this.saniTitle(track, artistNames);
					const trackFileName = this.budgetedTrackFileName(
						albumDir,
						trackIndexPadded,
						saniTrackTitle,
						fileExt,
					);
					const trackFinalPath = path.join(albumDir, trackFileName);

					if (byteLength(trackFinalPath) > MAX_PATH_LENGTH) {
						throw new Error(`Track path too long: ${trackFinalPath}`);
					}

					const destinationExisted = await pathExists(trackFinalPath);
					await this.moveFile(tempPath, trackFinalPath);
					if (!destinationExisted) {
						createdTrackFile = trackFinalPath;
						createdFiles.push(trackFinalPath);
					}

					const embedUrl = resolveTrackCoverUrl(track, albumContext.artwork_url ?? null);
					if (embedUrl) {
						tempTrackCoverPath = path.join(this.tempDir, `cover_embed_${track.id}.jpg`);
						const saved = await saveImage(embedUrl, tempTrackCoverPath);
						if (!saved) {
							console.warn(
								` -> Failed to save temp cover for embedding: ${track.title}`,
							);
							tempTrackCoverPath = null;
						}
					}

					const bannerUrl = getTrackBannerUrl(track);
					if (bannerUrl) {
						const bannerPath = path.join(albumDir, 'artwork', `banner-${track.id}.jpg`);
						if (!(await pathExists(bannerPath))) {
							const saved = await saveBanner(bannerUrl, bannerPath);
							if (saved) createdFiles.push(bannerPath);
						}
					}

					const relativePath = path.relative(this.outputDir, trackFinalPath);

					finalizedTracks.push({
						track,
						finalPath: trackFinalPath,
						relativePath,
						tempTrackCoverPath,
					});
				} catch (trackError) {
					console.error(
						` -> Error processing album track ${track.title} (within album ${albumContext.title}): ${errorMessage(trackError)}`,
					);
					await cleanupFile(createdTrackFile, 'final album track');
				}
			}

			if (finalizedTracks.length === 0) {
				throw new Error(
					`No tracks were successfully finalized for album ${albumContext.title}.`,
				);
			}

			console.log(
				` -> Album ${albumContext.title} organized. ${finalizedTracks.length}/${successfulPreparations.length} tracks finalized.`,
			);
			return {
				success: true,
				finalizedTracks,
			};
		} catch (error) {
			console.error(
				` -> Error in organizeAlbum for ${albumContext.title}: ${errorMessage(error)}`,
			);
			for (const file of createdFiles) {
				await cleanupFile(file, 'partial album file');
			}
			if (albumDir && !albumDirExisted) {
				await removeIfEmpty(path.join(albumDir, 'artwork'));
				if (await removeIfEmpty(albumDir)) {
					console.log(` -> Cleaned up album directory: ${albumDir}`);
				}
			}
			return { success: false };
		}
	}
}

export default FileOrganizer;
