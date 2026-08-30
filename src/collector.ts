import fs from 'fs';
import path from 'path';
import Soundcloud from 'soundcloud.ts';

import { loadConfig } from './configLoader.ts';
import Database from './database.ts';
import ArtworkManager from './artworkManager.ts';
import ArtistRenameManager from './artistRenameManager.ts';
import TrackProcessor from './trackProcessor.ts';
import FileOrganizer from './fileOrganizer.ts';
import ContentDiscovery from './contentDiscovery.ts';
import JobProcessor from './jobProcessor.ts';
import Notifier from './notifier.ts';
import { runBackup, runBackupIfDue } from './backup.ts';
import { errorMessage, isNotFoundError } from './utils.ts';
import type { ArtistRow, Config, SoundcloudUser } from './types.ts';

interface RunSummary {
	newTracks: number;
	upgradedTracks: number;
	deletedTracks: number;
	skippedTracks: number;
	inactiveArtists: string[];
	artworkRevisions: number;
	errors: string[];
}

export function buildProxyUrl(config: Config): string | null {
	const { proxyHost, proxyPort, proxyUsername, proxyPassword } = config;
	const components = [proxyPort, proxyUsername, proxyPassword];

	if (!proxyHost) {
		if (components.some((value) => value !== null)) {
			throw new Error('SCS_PROXY_PORT/USERNAME/PASSWORD are set without SCS_PROXY_HOST');
		}
		return null;
	}

	if ((proxyUsername === null) !== (proxyPassword === null)) {
		throw new Error('Proxy needs both SCS_PROXY_USERNAME and SCS_PROXY_PASSWORD, or neither');
	}

	if (proxyHost.includes('://')) {
		if (components.some((value) => value !== null)) {
			throw new Error(
				'SCS_PROXY_HOST is a full URL; remove SCS_PROXY_PORT/USERNAME/PASSWORD or give a bare host',
			);
		}
		return proxyHost;
	}

	const url = new URL(`http://${proxyHost}`);
	if (proxyPort !== null) url.port = String(proxyPort);
	if (proxyUsername !== null && proxyPassword !== null) {
		url.username = proxyUsername;
		url.password = proxyPassword;
	}
	return url.toString();
}

interface Modules {
	contentDiscovery: ContentDiscovery;
	jobProcessor: JobProcessor;
	artworkManager: ArtworkManager;
	renameManager: ArtistRenameManager;
}

class SoundcloudCollector {
	private config: Config;
	private soundcloud: Soundcloud;
	private database: Database;
	private notifier: Notifier;
	private stopController: AbortController;

	private contentDiscovery: ContentDiscovery;
	private jobProcessor: JobProcessor;
	private artworkManager: ArtworkManager;
	private renameManager: ArtistRenameManager;

	private constructor(
		config: Config,
		soundcloud: Soundcloud,
		database: Database,
		notifier: Notifier,
		modules: Modules,
		stopController: AbortController,
	) {
		this.config = config;
		this.soundcloud = soundcloud;
		this.database = database;
		this.notifier = notifier;
		this.stopController = stopController;

		this.contentDiscovery = modules.contentDiscovery;
		this.jobProcessor = modules.jobProcessor;
		this.artworkManager = modules.artworkManager;
		this.renameManager = modules.renameManager;
	}

	static async create(): Promise<SoundcloudCollector> {
		const config = loadConfig();
		const notifier = new Notifier(config.pushover);

		await fs.promises.mkdir(config.tempDir, { recursive: true });
		await fs.promises.mkdir(config.outputDir, { recursive: true });

		const scOptions: { proxy?: string } = {};
		const proxy = buildProxyUrl(config);
		if (proxy) {
			scOptions.proxy = proxy;
			console.log(`Using proxy: ${proxy.replace(/\/\/.*@/, '//***@')}`);
		}
		const soundcloud = new Soundcloud(config.clientId, config.oauthToken, scOptions);

		const database = new Database(config.database, config.debug);
		await database.connect();
		console.log('Database connected');

		try {
			return await this.assemble(config, soundcloud, database, notifier);
		} catch (error) {
			await database.close();
			throw error;
		}
	}

	private static async assemble(
		config: Config,
		soundcloud: Soundcloud,
		database: Database,
		notifier: Notifier,
	): Promise<SoundcloudCollector> {
		try {
			const user = (await soundcloud.api.getV2('/me')) as { id?: number; username?: string };
			if (!user.id) {
				throw new Error('Invalid Soundcloud credentials');
			}
			console.log(`Logged in as ${user.username}`);
		} catch (error) {
			await notifier.push(
				'SCSuck: SoundCloud token invalid',
				`Credential check failed: ${errorMessage(error)}. Refresh SCS_OAUTH_TOKEN/SCS_CLIENT_ID.`,
			);
			throw error;
		}

		const artworkManager = new ArtworkManager(database, config.outputDir);
		const renameManager = new ArtistRenameManager(database, config.outputDir);
		const contentDiscovery = new ContentDiscovery(
			soundcloud,
			database,
			config.debug,
			artworkManager,
			renameManager,
		);
		const stopController = new AbortController();
		const jobProcessor = new JobProcessor(
			new TrackProcessor(soundcloud, config.tempDir, config.debug),
			new FileOrganizer(config.outputDir, config.tempDir),
			database,
			config.rateLimitMS,
			stopController.signal,
		);

		const collector = new SoundcloudCollector(
			config,
			soundcloud,
			database,
			notifier,
			{ contentDiscovery, jobProcessor, artworkManager, renameManager },
			stopController,
		);

		await collector.cleanupTempFiles();

		return collector;
	}

	private async cleanupTempFiles(): Promise<void> {
		try {
			const files = await fs.promises.readdir(this.config.tempDir);
			let removed = 0;
			for (const file of files) {
				try {
					await fs.promises.unlink(path.join(this.config.tempDir, file));
					removed++;
				} catch (error) {
					console.error(`Failed to delete temp file ${file}:`, errorMessage(error));
				}
			}
			if (removed > 0) {
				console.log(`Cleaned up ${removed} files from temp directory.`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}

	private normalizeArtistRef(ref: string): string {
		if (!ref.includes('/')) return ref;
		const tail = ref.split('/').filter(Boolean).pop();
		if (!tail) {
			throw new Error(`Artist reference has no permalink or id: "${ref}"`);
		}
		return tail;
	}

	private isExcluded(artist: { permalink: string; id: number | string }): boolean {
		return (
			this.config.excludeArtists.includes(artist.permalink) ||
			this.config.excludeArtists.includes(String(artist.id))
		);
	}

	private async addResolvedArtist(artist: SoundcloudUser): Promise<ArtistRow | null> {
		if (this.isExcluded(artist)) {
			console.log(`Skipping excluded artist: ${artist.username}`);
			return null;
		}

		const existing = await this.database.getArtistById(artist.id);

		let row: ArtistRow;
		if (!existing) {
			row = await this.database.insertArtist({
				id: artist.id,
				username: artist.username,
				permalink: artist.permalink,
			});
			console.log(`Added ${artist.username} to monitored artists.`);
		} else if (!existing.is_active) {
			row = await this.database.reactivateArtist(artist.id);
			console.log(`Re-activated ${existing.username} for monitoring.`);
		} else {
			row = existing;
			console.log(`${artist.username} is already being monitored.`);
		}

		await this.database.recordArtistAlias(artist.id, artist.username, artist.permalink);

		if (!existing || existing.username === artist.username) {
			await this.artworkManager.processArtistImages(artist, existing);
		}
		return row;
	}

	async addArtistToLibrary(artistUrlOrId: string): Promise<void> {
		console.log(`Adding artist: ${artistUrlOrId}`);
		const artist = await this.soundcloud.users.get(artistUrlOrId);
		if (!(await this.addResolvedArtist(artist))) {
			throw new Error(`${artist.username} is excluded by SCS_EXCLUDE_ARTISTS`);
		}
	}

	async removeArtistFromLibrary(artistUrlOrId: string): Promise<void> {
		console.log(`Removing artist: ${artistUrlOrId}`);

		let id: number | string;
		let username: string;
		try {
			const artist = await this.soundcloud.users.get(artistUrlOrId);
			id = artist.id;
			username = artist.username;
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
			const artist = await this.database.getArtistByRef(
				this.normalizeArtistRef(artistUrlOrId),
			);
			if (!artist) {
				console.log(`Artist not found: ${artistUrlOrId}`);
				return;
			}
			id = artist.id;
			username = artist.username;
		}

		const existingArtist = await this.database.getArtistById(id);

		if (existingArtist) {
			await this.database.removeArtist(id);
			console.log(`Removed ${username} from monitored artists.`);
		} else {
			console.log(`${username} is not being monitored.`);
		}
	}

	async listArtists(): Promise<void> {
		const artists = await this.database.getAllArtists();
		if (artists.length === 0) {
			console.log('No artists are being monitored.');
			return;
		}
		console.log(`Monitoring ${artists.length} artists:\n`);
		for (const artist of artists) {
			console.log(`  ${artist.username} (${artist.permalink}) [${artist.id}]`);
		}
	}

	async syncUserFollowing(userId: string): Promise<void> {
		console.log(`Syncing following list for user ID ${userId}`);

		const user = await this.soundcloud.users.get(userId);
		console.log(`Looking up who ${user.username} is following`);

		const following = await this.soundcloud.users.following(user.id);
		console.log(`Found ${following.length} artists followed by ${user.username}`);

		for (const followedArtist of following) {
			const existingArtist = await this.database.getArtistById(followedArtist.id);
			if (existingArtist?.is_active) continue;
			if (!existingArtist) {
				console.log(`Adding newly followed artist: ${followedArtist.username}`);
			}
			await this.addResolvedArtist(followedArtist);
		}
	}

	private async updateArtist(artistRow: ArtistRow, summary: RunSummary): Promise<void> {
		const { jobs, result: discovery } =
			await this.contentDiscovery.discoverAndQueueContent(artistRow);

		if (discovery.error) {
			summary.errors.push(`${artistRow.username}: ${discovery.error}`);
		}

		summary.deletedTracks += discovery.deletedTracks;
		summary.artworkRevisions += discovery.artworkRevisions;
		if (discovery.artistInactive) {
			summary.inactiveArtists.push(artistRow.username);
		}

		const stats = await this.jobProcessor.processQueue(jobs);
		if (jobs.length > 0) {
			await this.cleanupTempFiles();
		}
		summary.newTracks += stats.success;
		summary.upgradedTracks += stats.upgraded;
		summary.skippedTracks += stats.skipped;
		if (stats.failed > 0) {
			summary.errors.push(`${artistRow.username}: ${stats.failed} job(s) failed`);
		}

		if (
			stats.failed === 0 &&
			!discovery.artistInactive &&
			!discovery.error &&
			!this.stopController.signal.aborted
		) {
			await this.database.updateArtistLastChecked(artistRow.id);
		}
	}

	private async runUpdateCycle(specificArtist: string | null = null): Promise<RunSummary> {
		console.log(
			specificArtist
				? `Running update cycle for artist: ${specificArtist}`
				: 'Running update cycle for all monitored artists',
		);

		const summary: RunSummary = {
			newTracks: 0,
			upgradedTracks: 0,
			deletedTracks: 0,
			skippedTracks: 0,
			inactiveArtists: [],
			artworkRevisions: 0,
			errors: [],
		};

		let artists: ArtistRow[];
		if (specificArtist) {
			artists = [await this.resolveArtistRow(specificArtist)];
		} else {
			artists = await this.database.getAllArtists();
		}
		console.log(`Found ${artists.length} artist(s) to check.`);

		const intervalMs = this.config.discoveryIntervalHours * 60 * 60 * 1000;
		let skippedFresh = 0;

		for (const artist of artists) {
			if (this.stopController.signal.aborted) {
				console.log('\nStop requested; leaving the remaining artists for the next run.');
				break;
			}

			if (this.isExcluded(artist)) {
				console.log(`Skipping excluded artist during update cycle: ${artist.username}`);
				continue;
			}

			if (
				!specificArtist &&
				intervalMs > 0 &&
				artist.last_checked &&
				Date.now() - new Date(artist.last_checked).getTime() < intervalMs
			) {
				skippedFresh++;
				continue;
			}

			console.log(`\nUpdating ${artist.username} [${artist.id}]`);
			await this.updateArtist(artist, summary);

			await new Promise((resolve) => setTimeout(resolve, this.config.rateLimitMS));
		}

		if (skippedFresh > 0) {
			console.log(
				`\nSkipped ${skippedFresh} artist(s) checked within the last ${this.config.discoveryIntervalHours}h (SCS_DISCOVERY_INTERVAL).`,
			);
		}

		return summary;
	}

	private async resolveArtistRow(artistRef: string): Promise<ArtistRow> {
		const fromDb = await this.database.getActiveArtistByRef(this.normalizeArtistRef(artistRef));
		if (fromDb) return fromDb;

		console.log(`Adding artist: ${artistRef}`);
		let artist: SoundcloudUser;
		try {
			artist = await this.soundcloud.users.get(artistRef);
		} catch (error) {
			if (!isNotFoundError(error)) throw error;
			throw new Error(`Artist not found on SoundCloud: ${artistRef}`);
		}

		const row = await this.addResolvedArtist(artist);
		if (!row) {
			throw new Error(`${artist.username} is excluded by SCS_EXCLUDE_ARTISTS`);
		}
		return row;
	}

	private async sendRunSummary(summary: RunSummary): Promise<void> {
		const lines: string[] = [];
		if (summary.newTracks > 0) lines.push(`${summary.newTracks} new download(s)`);
		if (summary.upgradedTracks > 0)
			lines.push(`${summary.upgradedTracks} track(s) upgraded to original files`);
		if (summary.artworkRevisions > 0)
			lines.push(`${summary.artworkRevisions} artwork revision(s)`);
		if (summary.deletedTracks > 0)
			lines.push(`${summary.deletedTracks} track(s) removed from soundcloud`);
		if (summary.skippedTracks > 0)
			lines.push(`${summary.skippedTracks} track(s) skipped as unrecoverable`);
		if (summary.inactiveArtists.length > 0)
			lines.push(`Artists gone inactive: ${summary.inactiveArtists.join(', ')}`);
		if (summary.errors.length > 0)
			lines.push(`Errors:\n${summary.errors.slice(0, 10).join('\n')}`);

		if (lines.length === 0) return;
		await this.notifier.push('SCSuck run summary', lines.join('\n'));
	}

	async refresh(artist: string | null): Promise<void> {
		const summary = await this.runUpdateCycle(artist);
		await this.sendRunSummary(summary);
	}

	async backupNow(): Promise<void> {
		await runBackup(this.config);
	}

	async mergeDuplicateDirectories(): Promise<void> {
		await this.renameManager.mergeDuplicateDirectories();
	}

	async run(): Promise<void> {
		console.log('\n--- Starting Full Collection Cycle ---');

		await runBackupIfDue(this.config);

		if (this.config.additionalArtists.length > 0) {
			console.log(
				`\nProcessing ${this.config.additionalArtists.length} additional artists...`,
			);
			for (const artist of this.config.additionalArtists) {
				try {
					if (await this.database.getActiveArtistByRef(this.normalizeArtistRef(artist))) {
						continue;
					}
					await this.addArtistToLibrary(artist);
				} catch (error) {
					console.error(
						`Failed to add configured artist ${artist}: ${errorMessage(error)}`,
					);
				}
			}
		}

		if (this.config.syncFollowers.length > 0) {
			console.log(`\nSyncing followers for ${this.config.syncFollowers.length} users...`);
			for (const follower of this.config.syncFollowers) {
				try {
					await this.syncUserFollowing(follower);
				} catch (error) {
					console.error(
						`Failed to sync following list for ${follower}: ${errorMessage(error)}`,
					);
				}
			}
		}

		await this.refresh(null);

		console.log('\n--- Full Collection Cycle Completed ---');
	}

	requestStop(): void {
		this.stopController.abort();
	}

	async shutdown(): Promise<void> {
		console.log('\nShutting down...');
		try {
			await this.cleanupTempFiles();
		} finally {
			await this.database.close();
		}
	}

	async notifyFatal(message: string): Promise<void> {
		await this.notifier.push('SCSuck: run failed', message || 'Unknown error');
	}
}

export default SoundcloudCollector;
