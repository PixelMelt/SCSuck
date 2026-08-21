import { buildTrackKey, errorMessage, formatDateStamp, isNotFoundError } from './utils.ts';
import type {
	ArtistRow,
	DiscoveryOutcome,
	DiscoveryResult,
	EnrichedTrack,
	Job,
	SoundcloudClient,
	SoundcloudPlaylist,
	SoundcloudTrack,
	SoundcloudUser,
	TrackRow,
} from './types.ts';
import type Database from './database.ts';
import type ArtworkManager from './artworkManager.ts';
import type ArtistRenameManager from './artistRenameManager.ts';

const EMPTY_RESULT: DiscoveryResult = {
	deletedTracks: 0,
	artworkRevisions: 0,
	artistInactive: false,
	error: null,
};

class ContentDiscovery {
	private soundcloud: SoundcloudClient;
	private database: Database;
	private debug: boolean;
	private artworkManager: ArtworkManager;
	private renameManager: ArtistRenameManager;

	constructor(
		soundcloud: SoundcloudClient,
		database: Database,
		debug: boolean,
		artworkManager: ArtworkManager,
		renameManager: ArtistRenameManager,
	) {
		this.soundcloud = soundcloud;
		this.database = database;
		this.debug = debug;
		this.artworkManager = artworkManager;
		this.renameManager = renameManager;
	}

	async discoverAndQueueContent(artistRow: ArtistRow): Promise<DiscoveryOutcome> {
		console.log(`Discovering content for ${artistRow.username} [${artistRow.id}]`);
		const jobs: Job[] = [];
		const result: DiscoveryResult = { ...EMPTY_RESULT };
		let newCount = 0;
		let revisionCount = 0;

		const newTracksByAlbum = new Map<
			number,
			{ context: SoundcloudPlaylist; newTracks: EnrichedTrack[] }
		>();
		const albumExistingPath = new Map<number, string>();

		const flushAlbumJobs = () => {
			for (const albumData of newTracksByAlbum.values()) {
				jobs.push({
					type: 'album',
					albumContext: albumData.context,
					tracksToProcess: albumData.newTracks,
					existingTrackPath: albumExistingPath.get(albumData.context.id) ?? null,
				});
				console.log(
					`Queued album job: ${albumData.context.title} (${albumData.newTracks.length} new tracks)`,
				);
			}
			newTracksByAlbum.clear();
		};

		let artist: SoundcloudUser;
		try {
			artist = await this.soundcloud.users.get(String(artistRow.id));
		} catch (error) {
			const message = errorMessage(error);
			result.error = message;
			console.error(`Error discovering content for ${artistRow.username}: ${message}`);

			if (isNotFoundError(error)) {
				console.log(
					`Marking artist ${artistRow.username} [${artistRow.id}] as inactive (account deleted/deactivated)`,
				);
				try {
					await this.database.markArtistInactive(artistRow.id);
					result.artistInactive = true;
					result.error = null;
				} catch (dbError) {
					result.error = `${message}; and marking the artist inactive failed: ${errorMessage(dbError)}`;
					console.error(`Failed to mark artist as inactive:`, errorMessage(dbError));
				}
			}
			return { jobs, result };
		}

		try {
			await this.database.recordArtistAlias(artist.id, artist.username, artist.permalink);

			if (
				artistRow.username !== artist.username ||
				artistRow.permalink !== artist.permalink
			) {
				if (artistRow.username !== artist.username) {
					console.log(
						`Artist ${artist.id} renamed: "${artistRow.username}" -> "${artist.username}"`,
					);
				}
				if (artistRow.permalink !== artist.permalink) {
					console.log(
						`Artist ${artist.id} permalink changed: "${artistRow.permalink}" -> "${artist.permalink}"`,
					);
				}

				if (artistRow.username !== artist.username) {
					await this.renameManager.handleRename(
						artist.id,
						artist.username,
						artistRow.username,
					);
				}

				await this.database.updateArtistIdentity(
					artist.id,
					artist.username,
					artist.permalink,
				);
			}

			result.artworkRevisions += await this.artworkManager.processArtistImages(
				artist,
				artistRow,
			);

			const albums = (await this.soundcloud.users.albums(
				artist.id,
			)) as unknown as SoundcloudPlaylist[];

			const tracks = await this.soundcloud.users.tracks(artist.id);

			const dbTracks = await this.database.getTracksByArtist(artist.id);
			const dbTracksByKey = new Map(dbTracks.map((row) => [row.track_key, row]));

			const queueEnriched = (
				enriched: EnrichedTrack,
				albumContext: SoundcloudPlaylist | null,
			) => {
				if (albumContext) {
					let group = newTracksByAlbum.get(albumContext.id);
					if (!group) {
						group = { context: albumContext, newTracks: [] };
						newTracksByAlbum.set(albumContext.id, group);
					}
					group.newTracks.push(enriched);
				} else {
					jobs.push({ type: 'single', track: enriched });
				}
			};

			for (const track of tracks) {
				const memberships = albums
					.map((album) => ({
						album,
						index: album.tracks.findIndex((t) => t.id === track.id),
					}))
					.filter((m) => m.index >= 0);

				const contexts: { albumContext: SoundcloudPlaylist | null; trackIndex: number }[] =
					memberships.length > 0
						? memberships.map((m) => ({
								albumContext: m.album,
								trackIndex: m.index + 1,
							}))
						: [{ albumContext: null, trackIndex: 1 }];

				for (const { albumContext, trackIndex } of contexts) {
					const enrichedTrack: EnrichedTrack = {
						...track,
						trackIndex,
						album_id: albumContext?.id ?? null,
						album_title: albumContext?.title ?? null,
					};

					const trackKey = buildTrackKey(enrichedTrack);
					const existing = dbTracksByKey.get(trackKey) ?? null;

					if (
						albumContext &&
						existing?.file_path &&
						!albumExistingPath.has(albumContext.id)
					) {
						albumExistingPath.set(albumContext.id, existing.file_path);
					}

					if (!track.media || track.media.transcodings.length === 0) {
						continue;
					}

					if (!existing) {
						newCount++;
						queueEnriched(enrichedTrack, albumContext);
						continue;
					}

					if (existing.skip_reason) {
						if (
							track.downloadable === true &&
							track.has_downloads_left === true &&
							existing.downloadable !== true
						) {
							console.log(
								` -> Previously skipped track "${track.title}" is now downloadable, queueing`,
							);
							newCount++;
							queueEnriched(enrichedTrack, albumContext);
						} else if (existing.skip_reason === 'drm-only') {
							console.log(
								` -> Previously skipped track "${track.title}" predates encrypted-HLS support, queueing`,
							);
							newCount++;
							queueEnriched(enrichedTrack, albumContext);
						}
						continue;
					}

					result.artworkRevisions += await this.artworkManager.checkTrackImageRevisions(
						track,
						existing,
					);

					if (this.detectDownloadUpgrade(track, existing)) {
						console.log(
							` -> Downloads enabled for "${track.title}", queueing upgrade to original file`,
						);
						queueEnriched({ ...enrichedTrack, upgradeOf: trackKey }, albumContext);
						continue;
					}

					const revision = await this.detectSoundChange(track, existing);
					if (revision) {
						const revisedTrack: EnrichedTrack = {
							...enrichedTrack,
							revisionDate: revision,
							revisionOf: trackKey,
						};
						const revisionKey = buildTrackKey(revisedTrack);
						if (!dbTracksByKey.has(revisionKey)) {
							console.log(
								` -> Sound file changed for "${track.title}", queueing dated re-download (${revision})`,
							);
							revisionCount++;
							queueEnriched(revisedTrack, albumContext);
						}
					}
				}
			}

			flushAlbumJobs();

			if (tracks.length === 0 && dbTracks.length > 0) {
				result.error = `API returned 0 tracks for ${artist.username} but ${dbTracks.length} are archived`;
				console.warn(` -> ${result.error}; skipping deletion detection.`);
			} else {
				result.deletedTracks = await this.detectDeletedTracks(dbTracks, tracks);
			}

			console.log(
				`Discovery complete for ${artist.username}: ${newCount} new, ${revisionCount} changed, ${result.deletedTracks} deleted.`,
			);
			return { jobs, result };
		} catch (error) {
			const message = errorMessage(error);
			result.error = message;
			console.error(`Error discovering content for ${artistRow.username}: ${message}`);
			if (this.debug && error instanceof Error) {
				console.error(error.stack);
			}

			flushAlbumJobs();
			return { jobs, result };
		}
	}

	private detectDownloadUpgrade(track: SoundcloudTrack, existing: TrackRow): boolean {
		return (
			track.downloadable === true &&
			track.has_downloads_left === true &&
			existing.downloadable === false
		);
	}

	private async detectSoundChange(
		track: SoundcloudTrack,
		existing: TrackRow,
	): Promise<string | null> {
		const apiState = {
			waveform_url: track.waveform_url ?? null,
			duration: track.duration ?? null,
			downloadable: track.downloadable ?? null,
			last_modified: track.last_modified ?? null,
		};

		if (
			existing.waveform_url == null ||
			existing.duration == null ||
			existing.downloadable == null
		) {
			await this.database.updateTrackSoundState(existing.track_key, apiState);
			return null;
		}

		const waveformChanged =
			apiState.waveform_url != null && apiState.waveform_url !== existing.waveform_url;
		const durationChanged =
			apiState.duration != null && apiState.duration !== existing.duration;

		if (!waveformChanged && !durationChanged) {
			if (apiState.last_modified !== existing.last_modified) {
				await this.database.updateTrackSoundState(existing.track_key, {
					...apiState,
					downloadable: existing.downloadable,
				});
			}
			return null;
		}

		await this.database.updateTrackSoundState(existing.track_key, apiState);
		return formatDateStamp(track.last_modified);
	}

	private async detectDeletedTracks(
		dbTracks: TrackRow[],
		apiTracks: SoundcloudTrack[],
	): Promise<number> {
		if (dbTracks.length === 0) return 0;

		const apiIds = new Set(apiTracks.map((t) => String(t.id)));

		const missingKeys = dbTracks
			.filter(
				(row) =>
					row.deleted_from_api_at == null &&
					row.revision_of == null &&
					!apiIds.has(String(row.id)),
			)
			.map((row) => row.track_key);

		const reappearedKeys = dbTracks
			.filter((row) => row.deleted_from_api_at != null && apiIds.has(String(row.id)))
			.map((row) => row.track_key);

		if (missingKeys.length > 0) {
			await this.database.markTracksDeleted(missingKeys);
			console.log(
				` -> ${missingKeys.length} track(s) no longer on soundcloud (marked, files kept): ${missingKeys.join(', ')}`,
			);
		}
		if (reappearedKeys.length > 0) {
			await this.database.clearTracksDeleted(reappearedKeys);
			console.log(` -> ${reappearedKeys.length} previously-missing track(s) reappeared.`);
		}

		return missingKeys.length;
	}
}

export default ContentDiscovery;
