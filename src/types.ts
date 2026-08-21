import type Soundcloud from 'soundcloud.ts';
import type {
	SoundcloudTrack,
	SoundcloudUser,
	SoundcloudPlaylist,
	SoundcloudTranscoding,
} from 'soundcloud.ts';

export type { SoundcloudTrack, SoundcloudUser, SoundcloudPlaylist, SoundcloudTranscoding };

export type SoundcloudClient = Soundcloud;

export interface Migration {
	id: number;
	name: string;
	sql: string;
}

export interface MediaPlaylist {
	keyUri: string | null;
	initUri: string | null;
	segmentUris: string[];
}

export interface DatabaseConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
}

export interface PushoverConfig {
	appToken: string | null;
	userKey: string | null;
}

export interface Config {
	clientId: string;
	oauthToken: string;
	tempDir: string;
	outputDir: string;
	backupDir: string;
	backupIntervalHours: number;
	discoveryIntervalHours: number;
	syncFollowers: string[];
	additionalArtists: string[];
	excludeArtists: string[];
	rateLimitMS: number;
	proxyHost: string | null;
	proxyPort: number | null;
	proxyUsername: string | null;
	proxyPassword: string | null;
	debug: boolean;
	datadomeStub: boolean;
	pushover: PushoverConfig;
	database: DatabaseConfig;
}

export interface EnrichedTrack extends SoundcloudTrack {
	trackIndex: number;
	album_id: number | null;
	album_title: string | null;
	revisionDate?: string;
	revisionOf?: string;
	upgradeOf?: string;
}

export type Job =
	| { type: 'single'; track: EnrichedTrack }
	| {
			type: 'album';
			albumContext: SoundcloudPlaylist;
			tracksToProcess: EnrichedTrack[];
			existingTrackPath: string | null;
	  };

export interface AudioQuality {
	isLossless: boolean;
	bitDepth: number;
	sampleRate: number;
	bitRate: number;
}

export interface ArtistRow {
	id: string;
	username: string;
	permalink: string;
	is_active: boolean;
	last_checked: Date | null;
	avatar_url: string | null;
	banner_url: string | null;
	marked_inactive_at: Date | null;
}

export interface TrackRow {
	id: string;
	user_id: string;
	track_key: string;
	title: string;
	waveform_url: string | null;
	file_path: string | null;
	downloaded_at: Date | null;
	skip_reason: SkipReason | null;
	artwork_url: string | null;
	banner_url: string | null;
	downloadable: boolean | null;
	last_modified: string | null;
	duration: number | null;
	deleted_from_api_at: Date | null;
	revision_of: string | null;
}

export interface NewArtistData {
	id: number;
	username: string;
	permalink: string;
}

export interface TrackSoundState {
	waveform_url: string | null;
	duration: number | null;
	downloadable: boolean | null;
	last_modified: string | null;
}

export interface SkippedTrackData {
	id: number;
	track_key: string;
	user_id: number;
	title: string;
	downloadable: boolean | null;
}

export interface TrackKeyInput {
	id: number;
	user_id: number;
	album_id?: number | null;
	revisionDate?: string;
}

export interface BackupConfig {
	backupDir: string;
	backupIntervalHours: number;
	database: DatabaseConfig;
}

export interface CoArtistInput {
	title: string;
	description?: string | null;
	publisherArtist?: string | null;
	mainArtist: string;
	mainArtistAliases?: string[];
}

export type SkipReason = 'drm-only' | 'drm-unrecoverable';

export type PreparationResult =
	| { success: true; tempPath: string; fileExt: string; audioQuality: AudioQuality }
	| {
			success: false;
			skipReason: SkipReason | null;
	  };

export type HlsDownloadResult =
	| {
			success: true;
			filePath: string;
			protocol: string;
			preset: string;
			keyMethod: string | null;
	  }
	| {
			success: false;
			message: string;
			permanent: boolean;
	  };

export interface DiscoveryResult {
	deletedTracks: number;
	artworkRevisions: number;
	artistInactive: boolean;
	error: string | null;
}

export interface DiscoveryOutcome {
	jobs: Job[];
	result: DiscoveryResult;
}

export interface QueueStats {
	success: number;
	upgraded: number;
	failed: number;
	skipped: number;
}

export interface SinglePrep {
	track: EnrichedTrack;
	tempPath: string;
	fileExt: string;
	audioQuality: AudioQuality;
}

export interface FinalizedTrack {
	track: EnrichedTrack;
	finalPath: string;
	relativePath: string;
	tempTrackCoverPath: string | null;
}

export type OrganizeSingleResult =
	| { success: true; finalPath: string; relativePath: string }
	| { success: false };

export type OrganizeAlbumResult =
	| { success: true; finalizedTracks: FinalizedTrack[] }
	| { success: false };

export interface AddTrackData {
	id: number;
	track_key: string;
	user_id: number;
	title: string;
	waveform_url: string | null;
	file_path: string;
	artwork_url: string | null;
	banner_url: string | null;
	downloadable: boolean | null;
	last_modified: string | null;
	duration: number | null;
	revision_of: string | null;
}
