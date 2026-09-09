import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildTrackKey, cleanupFile, errorMessage, isLosslessFormat } from './utils.ts';
import { permanentSkipReason, requiresEncryptedHls } from './skipPolicy.ts';
import {
	clearHlsTranscoding,
	downloadClearHls,
	downloadEncryptedHls,
	encryptedHlsTranscodings,
} from './hlsStreams.ts';
import type {
	AudioQuality,
	EnrichedTrack,
	PreparationResult,
	SkipReason,
	SoundcloudClient,
} from './types.ts';

const execFileAsync = promisify(execFile);

type StreamDownloadResult =
	| { success: true; filePath: string }
	| { success: false; skipReason: SkipReason | null; message: string };

class TrackProcessor {
	private soundcloud: SoundcloudClient;
	private tempDir: string;
	private debug: boolean;
	private decryptionServiceUrl: string | null;

	constructor(
		soundcloud: SoundcloudClient,
		tempDir: string,
		debug: boolean,
		decryptionServiceUrl: string | null,
	) {
		this.soundcloud = soundcloud;
		this.tempDir = tempDir;
		this.debug = debug;
		this.decryptionServiceUrl = decryptionServiceUrl;
	}

	private async withQuietLibLogs<T>(fn: () => Promise<T>): Promise<T> {
		if (this.debug) return fn();
		const originalLog = console.log;
		const originalError = console.error;
		console.log = () => {};
		console.error = (...args: unknown[]) =>
			originalError(
				...args.map((value) => (value instanceof Error ? errorMessage(value) : value)),
			);
		try {
			return await fn();
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
	}

	private async downloadEncryptedOnly(
		track: EnrichedTrack,
		trackKey: string,
		sawRetryable: boolean,
	): Promise<StreamDownloadResult> {
		const encrypted = await downloadEncryptedHls(
			this.soundcloud,
			track,
			this.tempDir,
			trackKey,
			this.decryptionServiceUrl,
		);
		if (!encrypted.success) {
			return {
				success: false,
				skipReason: encrypted.permanent && !sawRetryable ? 'drm-unrecoverable' : null,
				message: `Encrypted HLS download failed for ${track.title} [${track.id}]: ${encrypted.message}`,
			};
		}
		console.log(
			` -> Encrypted HLS (${encrypted.protocol} ${encrypted.preset}, key method: ${encrypted.keyMethod ?? 'none'}) fetched`,
		);
		return { success: true, filePath: encrypted.filePath };
	}

	private async downloadHlsAlternatives(
		track: EnrichedTrack,
		trackKey: string,
		sawRetryable: boolean,
	): Promise<StreamDownloadResult> {
		if (clearHlsTranscoding(track)) {
			const clear = await downloadClearHls(this.soundcloud, track, this.tempDir, trackKey);
			if (clear.success) {
				console.log(` -> Clear HLS (${clear.preset}) fetched`);
				return { success: true, filePath: clear.filePath };
			}
			console.error(` -> Clear HLS failed (${clear.message})`);
			if (!clear.permanent) sawRetryable = true;
			if (!encryptedHlsTranscodings(track).length) {
				return {
					success: false,
					skipReason: sawRetryable ? null : 'drm-unrecoverable',
					message: `Clear HLS download failed for ${track.title} [${track.id}]: ${clear.message}`,
				};
			}
		}
		return this.downloadEncryptedOnly(track, trackKey, sawRetryable);
	}

	private async downloadViaStreams(
		track: EnrichedTrack,
		trackKey: string,
	): Promise<StreamDownloadResult> {
		if (requiresEncryptedHls(track)) {
			return this.downloadEncryptedOnly(track, trackKey, false);
		}
		try {
			const filePath = await this.withQuietLibLogs(() =>
				this.soundcloud.util.downloadTrack(track, this.tempDir),
			);
			return { success: true, filePath };
		} catch (error) {
			const message = errorMessage(error);
			const streamSkipReason = permanentSkipReason(error);
			if (track.upgradeOf) {
				return {
					success: false,
					skipReason: streamSkipReason,
					message: `Original-file upgrade failed for ${track.title} [${track.id}]: ${message}`,
				};
			}
			if (!clearHlsTranscoding(track) && !encryptedHlsTranscodings(track).length) {
				return {
					success: false,
					skipReason: streamSkipReason,
					message: `Error in downloadAndPrepare for ${track.title} [${track.id}]: ${message}`,
				};
			}
			console.error(` -> Stream download failed (${message}); trying HLS alternatives`);
			return this.downloadHlsAlternatives(track, trackKey, streamSkipReason === null);
		}
	}

	async downloadAndPrepare(track: EnrichedTrack): Promise<PreparationResult> {
		const trackKey = buildTrackKey(track);
		let downloadedFilePath: string | null = null;
		let tempOrigPath: string | null = null;
		let processedPath: string | null = null;

		try {
			console.log(` -> Downloading: ${track.title} [${track.id}]`);
			const download = await this.downloadViaStreams(track, trackKey);
			if (!download.success) {
				console.error(` -> ${download.message}`);
				return { success: false, skipReason: download.skipReason };
			}
			downloadedFilePath = download.filePath;

			await fs.promises.access(downloadedFilePath);

			let origExt = path.extname(downloadedFilePath).substring(1).toLowerCase();
			const probedExt = await this.detectExtension(downloadedFilePath);
			if (!origExt) {
				if (!probedExt) {
					throw new Error(
						`Download has no extension and ffprobe could not identify it: ${downloadedFilePath}`,
					);
				}
				origExt = probedExt;
				console.log(` -> Download had no extension; probed as .${origExt}`);
			} else if (probedExt && probedExt !== origExt) {
				console.log(
					` -> Download claimed .${origExt} but is actually .${probedExt}; using probed format`,
				);
				origExt = probedExt;
			}
			tempOrigPath = path.join(this.tempDir, `orig_${trackKey}.${origExt}`);
			await fs.promises.rename(downloadedFilePath, tempOrigPath);
			downloadedFilePath = null;

			processedPath = tempOrigPath;
			let fileExt = origExt;

			if (isLosslessFormat(origExt)) {
				console.log(` -> Converting to FLAC: ${track.title}`);
				const flacPath = path.join(this.tempDir, `${trackKey}.flac`);
				const converted = await this.convertToFlac(tempOrigPath, flacPath);

				if (converted) {
					processedPath = flacPath;
					fileExt = 'flac';
					await cleanupFile(tempOrigPath, `original temp ${origExt}`);
					tempOrigPath = null;
				} else {
					console.warn(
						` -> FLAC conversion failed for ${track.title}. Attempting to use original ${origExt}.`,
					);
				}
			}

			console.log(` -> Getting audio quality: ${track.title}`);
			const audioQuality = await this.getAudioQuality(processedPath, fileExt);

			return {
				success: true,
				tempPath: processedPath,
				fileExt,
				audioQuality,
			};
		} catch (error) {
			const message = errorMessage(error);
			console.error(
				` -> Error in downloadAndPrepare for ${track.title} [${track.id}]: ${message}`,
			);
			await cleanupFile(downloadedFilePath, 'initial download');
			await cleanupFile(tempOrigPath, 'original temp');
			await cleanupFile(
				processedPath && processedPath !== tempOrigPath ? processedPath : null,
				'processed temp',
			);
			return { success: false, skipReason: permanentSkipReason(error) };
		}
	}

	private async detectExtension(filePath: string): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync('ffprobe', [
				'-v',
				'error',
				'-show_entries',
				'format=format_name',
				'-of',
				'json',
				filePath,
			]);
			const formatName: string =
				(JSON.parse(stdout) as { format?: { format_name?: string } }).format?.format_name ??
				'';
			for (const ext of ['flac', 'wav', 'aiff', 'ogg', 'aac', 'mp3']) {
				if (formatName.includes(ext)) return ext;
			}
			if (/mp4|m4a|mov/.test(formatName)) return 'm4a';
		} catch (error) {
			console.warn(
				` -> Could not probe format of ${path.basename(filePath)}: ${errorMessage(error)}`,
			);
		}
		return null;
	}

	private async convertToFlac(inputFile: string, outputFile: string): Promise<boolean> {
		try {
			await execFileAsync('ffmpeg', [
				'-y',
				'-i',
				inputFile,
				'-map_metadata',
				'0',
				'-c:a',
				'flac',
				'-compression_level',
				'8',
				outputFile,
			]);
			await fs.promises.access(outputFile);
			return true;
		} catch (error) {
			console.error(
				` -> Error converting ${path.basename(inputFile)} to FLAC: ${errorMessage(error)}`,
			);
			await cleanupFile(outputFile, 'incomplete FLAC');
			return false;
		}
	}

	private async getAudioQuality(filePath: string, fileExt: string): Promise<AudioQuality> {
		try {
			const { stdout } = await execFileAsync('ffprobe', [
				'-v',
				'error',
				'-select_streams',
				'a:0',
				'-show_entries',
				'stream=bit_depth,sample_rate,sample_fmt,bits_per_raw_sample,bit_rate',
				'-of',
				'json',
				filePath,
			]);
			const data = JSON.parse(stdout) as {
				streams?: {
					sample_rate?: string;
					bit_rate?: string;
					bits_per_raw_sample?: string;
					bit_depth?: string;
					sample_fmt?: string;
				}[];
			};

			let bitDepth = 16;
			let sampleRate = 44100;
			let bitRate = 0;
			const isLossless = isLosslessFormat(fileExt);

			const stream = data?.streams?.[0];
			if (stream) {
				const probedRate = parseInt(stream.sample_rate ?? '', 10);
				if (probedRate > 0) sampleRate = probedRate;
				if (stream.bit_rate && stream.bit_rate !== 'N/A')
					bitRate = Math.round(parseInt(stream.bit_rate, 10) / 1000);

				if (isLossless) {
					if (stream.bits_per_raw_sample && stream.bits_per_raw_sample !== 'N/A') {
						bitDepth = parseInt(stream.bits_per_raw_sample, 10);
					} else if (stream.bit_depth && stream.bit_depth !== 'N/A') {
						bitDepth = parseInt(stream.bit_depth, 10);
					} else if (stream.sample_fmt) {
						if (stream.sample_fmt.includes('s32')) bitDepth = 32;
						else if (stream.sample_fmt.includes('s24')) bitDepth = 24;
						else if (stream.sample_fmt.includes('s16')) bitDepth = 16;
						else if (stream.sample_fmt.includes('u8')) bitDepth = 8;
					}
					if (bitDepth <= 0 || isNaN(bitDepth)) bitDepth = 16;
				} else {
					if (bitRate <= 0 || isNaN(bitRate)) {
						bitRate = fileExt === 'm4a' || fileExt === 'aac' ? 256 : 128;
					}
				}
			} else {
				console.warn(
					` -> Could not get valid stream info via ffprobe for ${path.basename(filePath)}. Using defaults.`,
				);
			}

			return {
				isLossless,
				bitDepth,
				sampleRate,
				bitRate: isLossless ? 0 : bitRate,
			};
		} catch (error) {
			console.error(
				` -> Error getting audio quality for ${path.basename(filePath)}: ${errorMessage(error)}`,
			);
			const isLosslessOnError = isLosslessFormat(fileExt);
			return {
				isLossless: isLosslessOnError,
				bitDepth: 16,
				sampleRate: 44100,
				bitRate: isLosslessOnError ? 0 : 128,
			};
		}
	}
}

export default TrackProcessor;
