import { buildTrackKey, cleanupFile, errorMessage } from './utils.ts';
import type {
	EnrichedTrack,
	Job,
	PreparationResult,
	QueueStats,
	SinglePrep,
	SkipReason,
} from './types.ts';
import type TrackProcessor from './trackProcessor.ts';
import type FileOrganizer from './fileOrganizer.ts';
import { writeMetadata } from './metadataWriter.ts';
import type Database from './database.ts';
import { getTrackBannerUrl } from './coverArtProcessor.ts';

function queueStats(partial: Partial<QueueStats> = {}): QueueStats {
	return { success: 0, upgraded: 0, failed: 0, skipped: 0, ...partial };
}

function addQueueStats(into: QueueStats, from: QueueStats): void {
	into.success += from.success;
	into.upgraded += from.upgraded;
	into.failed += from.failed;
	into.skipped += from.skipped;
}

class JobProcessor {
	private trackProcessor: TrackProcessor;
	private fileOrganizer: FileOrganizer;
	private database: Database;
	private rateLimitMS: number;
	private stopSignal: AbortSignal;

	constructor(
		trackProcessor: TrackProcessor,
		fileOrganizer: FileOrganizer,
		database: Database,
		rateLimitMS: number,
		stopSignal: AbortSignal,
	) {
		this.trackProcessor = trackProcessor;
		this.fileOrganizer = fileOrganizer;
		this.database = database;
		this.rateLimitMS = rateLimitMS;
		this.stopSignal = stopSignal;
	}

	private async artistNamesFor(userId: number, currentName: string): Promise<string[]> {
		const names = [currentName];
		for (const alias of await this.database.getArtistAliasUsernames(userId)) {
			if (!names.some((n) => n.toLowerCase() === alias.toLowerCase())) {
				names.push(alias);
			}
		}
		return names;
	}

	async processQueue(jobs: Job[]): Promise<QueueStats> {
		const stats = queueStats();
		if (jobs.length === 0) {
			return stats;
		}

		console.log(`--- Starting Download Queue Processing (${jobs.length} items) ---`);

		try {
			for (const job of jobs) {
				if (this.stopSignal.aborted) {
					console.log('\nStop requested; the remaining jobs re-queue next run.');
					break;
				}

				const label = job.type === 'single' ? job.track.title : job.albumContext.title;
				console.log(`\nProcessing Job: ${job.type} - ${label}`);

				try {
					const jobStats =
						job.type === 'single'
							? await this.processSingleTrackJob(job)
							: await this.processAlbumJob(job);
					addQueueStats(stats, jobStats);
				} catch (jobError) {
					stats.failed += job.type === 'single' ? 1 : job.tracksToProcess.length;
					console.error(
						`Unhandled error processing job (${job.type} - ${label}): ${errorMessage(jobError)}`,
						(jobError as Error).stack,
					);
				}
			}
		} finally {
			console.log(
				`\n--- Download Queue Processing Finished --- (Success: ${stats.success}, Upgraded: ${stats.upgraded}, Failed: ${stats.failed}, Skipped: ${stats.skipped})`,
			);
		}

		return stats;
	}

	private async recordUnrecoverable(
		track: EnrichedTrack,
		reason: SkipReason,
	): Promise<'skipped' | 'failed'> {
		if (track.upgradeOf) {
			console.log(
				` -> Upgrade to the original file failed unrecoverably for "${track.title}"; keeping the archived stream copy`,
			);
			await this.database.acknowledgeDownloadEnabled(track.upgradeOf);
			return 'failed';
		}
		console.log(
			` -> Track "${track.title}" is unrecoverable via streams; recording skip reason: ${reason}`,
		);
		await this.database.markTrackSkipped(
			{
				id: track.id,
				track_key: buildTrackKey(track),
				user_id: track.user_id,
				title: track.title,
				downloadable: track.downloadable ?? null,
			},
			reason,
		);
		return 'skipped';
	}

	private async rateLimit(context: string): Promise<void> {
		console.log(`--> Waiting ${this.rateLimitMS}ms before ${context}...`);
		await new Promise((resolve) => setTimeout(resolve, this.rateLimitMS));
	}

	private async upgradeTargetPath(track: EnrichedTrack): Promise<string | null> {
		if (!track.upgradeOf) return null;
		const oldRow = await this.database.getTrackByKey(track.upgradeOf);
		if (!oldRow?.file_path) {
			throw new Error(`Upgrade target ${track.upgradeOf} is missing or has no file_path`);
		}
		return oldRow.file_path;
	}

	private async persistFinalizedTrack(
		track: EnrichedTrack,
		finalPath: string,
		relativePath: string,
	): Promise<void> {
		const oldPath = await this.upgradeTargetPath(track);
		await this.database.addTrack({
			id: track.id,
			track_key: buildTrackKey(track),
			user_id: track.user_id,
			title: track.title,
			waveform_url: track.waveform_url,
			file_path: relativePath,
			artwork_url: track.artwork_url ?? null,
			banner_url: getTrackBannerUrl(track),
			downloadable: track.downloadable ?? null,
			last_modified: track.last_modified ?? null,
			duration: track.duration ?? null,
			revision_of: track.revisionOf ?? null,
		});
		if (oldPath) {
			await this.fileOrganizer.retireUpgradedFile(oldPath, finalPath);
		}
	}

	private async processSingleTrackJob(
		job: Extract<Job, { type: 'single' }>,
	): Promise<QueueStats> {
		await this.rateLimit('starting job');

		const { track } = job;
		let preparationResult: PreparationResult | null = null;

		try {
			preparationResult = await this.trackProcessor.downloadAndPrepare(track);
			if (!preparationResult.success) {
				if (preparationResult.skipReason) {
					const outcome = await this.recordUnrecoverable(
						track,
						preparationResult.skipReason,
					);
					return queueStats({ [outcome]: 1 });
				}
				console.error(`Track preparation failed for ${track.title}. Aborting job.`);
				return queueStats({ failed: 1 });
			}

			const artistNames = await this.artistNamesFor(track.user_id, track.user.username);

			const finalizationResult = await this.fileOrganizer.organizeSingle(
				track,
				preparationResult.tempPath,
				preparationResult.fileExt,
				preparationResult.audioQuality,
				artistNames,
			);

			if (!finalizationResult.success) {
				console.error(`Track finalization failed for ${track.title}. Aborting job.`);
				await cleanupFile(preparationResult.tempPath, 'prepared temp after finalize fail');
				return queueStats({ failed: 1 });
			}

			console.log(` -> Writing metadata for: ${track.title}`);
			const metadataSuccess = writeMetadata(
				track,
				finalizationResult.finalPath,
				null,
				artistNames,
			);
			if (!metadataSuccess) {
				console.warn(` -> Failed to write metadata for single track: ${track.title}`);
			}

			console.log(` -> Adding to database: ${track.title}`);
			try {
				await this.persistFinalizedTrack(
					track,
					finalizationResult.finalPath,
					finalizationResult.relativePath,
				);
				console.log(` -> Successfully processed single track: ${track.title}`);
				return track.upgradeOf ? queueStats({ upgraded: 1 }) : queueStats({ success: 1 });
			} catch (dbError) {
				console.error(
					` -> Database update failed for ${track.title} (File exists at ${finalizationResult.finalPath}): ${errorMessage(dbError)}`,
				);
				return queueStats({ failed: 1 });
			}
		} catch (error) {
			console.error(
				`Unexpected error in processSingleTrackJob for ${track.title}: ${errorMessage(error)}`,
			);
			if (preparationResult?.success)
				await cleanupFile(preparationResult.tempPath, 'prepared temp');
			return queueStats({ failed: 1 });
		}
	}

	private async processAlbumJob(job: Extract<Job, { type: 'album' }>): Promise<QueueStats> {
		const { albumContext, tracksToProcess } = job;
		const successfulPreparations: SinglePrep[] = [];
		let failedPreparations = 0;
		let skippedPreparations = 0;

		console.log(
			` -> Preparing ${tracksToProcess.length} tracks SEQUENTIALLY for album: ${albumContext.title}`,
		);

		for (const track of tracksToProcess) {
			await this.rateLimit(`preparing track: ${track.title} [Album: ${albumContext.title}]`);

			try {
				const preparationResult = await this.trackProcessor.downloadAndPrepare(track);

				if (preparationResult.success) {
					successfulPreparations.push({ track, ...preparationResult });
					console.log(`  -> Successfully prepared: ${track.title}`);
				} else if (preparationResult.skipReason) {
					const outcome = await this.recordUnrecoverable(
						track,
						preparationResult.skipReason,
					);
					if (outcome === 'skipped') skippedPreparations++;
					else failedPreparations++;
				} else {
					failedPreparations++;
				}
			} catch (error) {
				console.error(
					` -> Unexpected error during downloadAndPrepare for ${track.title} [Album: ${albumContext.title}]: ${errorMessage(error)}`,
					(error as Error).stack,
				);
				failedPreparations++;
			}
		}

		try {
			if (successfulPreparations.length === 0) {
				if (failedPreparations === 0 && skippedPreparations > 0) {
					console.log(
						` -> All ${skippedPreparations} track(s) in album ${albumContext.title} are unrecoverable; skipped.`,
					);
				} else {
					console.error(
						` -> No tracks successfully prepared for album ${albumContext.title}. Aborting job. Failed: ${failedPreparations}`,
					);
				}
				return queueStats({ failed: failedPreparations, skipped: skippedPreparations });
			}
			console.log(
				` -> Finished sequential preparation for album ${albumContext.title}. Success: ${successfulPreparations.length}, Failed: ${failedPreparations}.`,
			);

			const firstTrack = successfulPreparations[0]!.track;
			const artistNames = await this.artistNamesFor(
				firstTrack.user_id,
				firstTrack.user.username,
			);

			const finalizationResult = await this.fileOrganizer.organizeAlbum(
				albumContext,
				successfulPreparations,
				artistNames,
				job.existingTrackPath,
			);

			for (const prep of successfulPreparations) {
				await cleanupFile(prep.tempPath, `prepared album track temp`);
			}

			if (!finalizationResult.success) {
				console.error(` -> Album finalization failed for ${albumContext.title}.`);
				return queueStats({
					failed: failedPreparations + successfulPreparations.length,
					skipped: skippedPreparations,
				});
			}

			for (const finalized of finalizationResult.finalizedTracks) {
				const { track, finalPath, tempTrackCoverPath } = finalized;

				const metadataSuccess = writeMetadata(
					track,
					finalPath,
					tempTrackCoverPath,
					artistNames,
				);

				await cleanupFile(tempTrackCoverPath, 'temp embed cover');

				if (!metadataSuccess) {
					console.warn(` -> Failed to write metadata for album track: ${track.title}`);
				}
			}

			console.log(
				` -> Adding ${finalizationResult.finalizedTracks.length} finalized tracks to database for album ${albumContext.title}.`,
			);
			let dbSuccessCount = 0;
			let dbUpgradedCount = 0;
			for (const finalized of finalizationResult.finalizedTracks) {
				const { track, finalPath, relativePath } = finalized;
				try {
					await this.persistFinalizedTrack(track, finalPath, relativePath);
					if (track.upgradeOf) {
						dbUpgradedCount++;
					} else {
						dbSuccessCount++;
					}
				} catch (dbError) {
					console.error(
						` -> Database update failed for album track ${track.title} (File exists at ${finalPath}): ${errorMessage(dbError)}`,
					);
				}
			}

			const persisted = dbSuccessCount + dbUpgradedCount;
			console.log(
				` -> Successfully processed album: ${albumContext.title} (${persisted}/${finalizationResult.finalizedTracks.length} tracks added to DB).`,
			);
			return queueStats({
				success: dbSuccessCount,
				upgraded: dbUpgradedCount,
				failed: failedPreparations + successfulPreparations.length - persisted,
				skipped: skippedPreparations,
			});
		} catch (error) {
			console.error(
				`Unexpected error in processAlbumJob (after preparation stage) for ${albumContext.title}: ${errorMessage(error)}`,
				(error as Error).stack,
			);
			return queueStats({
				failed: failedPreparations + successfulPreparations.length,
				skipped: skippedPreparations,
			});
		}
	}
}

export default JobProcessor;
