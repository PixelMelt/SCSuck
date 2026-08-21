import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { cleanupFile, errorMessage } from './utils.ts';
import type {
	HlsDownloadResult,
	MediaPlaylist,
	SoundcloudClient,
	SoundcloudTrack,
	SoundcloudTranscoding,
} from './types.ts';

const execFileAsync = promisify(execFile);

const PREFERRED_PROTOCOLS = ['cbc-encrypted-hls', 'ctr-encrypted-hls'];
const SUPPORTED_KEY_METHODS = ['AES-128', 'SAMPLE-AES'];

export function encryptedHlsTranscoding(track: SoundcloudTrack): SoundcloudTranscoding | null {
	for (const protocol of PREFERRED_PROTOCOLS) {
		const match = track.media.transcodings.find((t) => t.format.protocol === protocol);
		if (match) return match;
	}
	return null;
}

export function clearHlsTranscoding(track: SoundcloudTrack): SoundcloudTranscoding | null {
	const candidates = track.media.transcodings.filter(
		(t) => t.format.protocol === 'hls' && t.format.mime_type !== 'audio/mpegurl',
	);
	if (!candidates.length) return null;
	const rank = (t: SoundcloudTranscoding) =>
		(t.quality === 'sq' ? 0 : 10) + (t.format.mime_type.includes('mp4') ? 0 : 1);
	return candidates.sort((a, b) => rank(a) - rank(b))[0]!;
}

export function playlistKeyMethod(playlist: string): string | null {
	const keyLine = playlist.split('\n').find((line) => line.startsWith('#EXT-X-KEY:'));
	return /METHOD=([^,]+)/.exec(keyLine ?? '')?.[1] ?? null;
}

export function isSupportedKeyMethod(method: string | null): boolean {
	return method === null || SUPPORTED_KEY_METHODS.includes(method);
}

export function licenseDelivery(playlist: string): string | null {
	const keyLines = playlist.split('\n').filter((line) => line.startsWith('#EXT-X-KEY:'));
	for (const line of keyLines) {
		if (/URI="skd:\/\//.test(line)) return 'FairPlay (skd://)';
		if (/KEYFORMAT="com\.microsoft\.playready"/i.test(line)) return 'PlayReady';
		if (/KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/i.test(line))
			return 'Widevine (cenc PSSH)';
	}
	return null;
}

export function parseMediaPlaylist(playlist: string, baseUrl: string): MediaPlaylist {
	let keyUri: string | null = null;
	let initUri: string | null = null;
	const segmentUris: string[] = [];
	for (const line of playlist.split('\n').map((l) => l.trim())) {
		if (line.startsWith('#EXT-X-KEY:')) {
			if (!keyUri) {
				const uri = /URI="([^"]+)"/.exec(line)?.[1];
				keyUri = uri ? new URL(uri, baseUrl).toString() : null;
			}
		} else if (line.startsWith('#EXT-X-MAP:')) {
			const uri = /URI="([^"]+)"/.exec(line)?.[1];
			initUri = uri ? new URL(uri, baseUrl).toString() : null;
		} else if (line && !line.startsWith('#')) {
			segmentUris.push(new URL(line, baseUrl).toString());
		}
	}
	return { keyUri, initUri, segmentUris };
}

function failure(message: string, permanent: boolean): HlsDownloadResult {
	return { success: false, message, permanent };
}

async function fetchBytes(url: string): Promise<Buffer> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return Buffer.from(await response.arrayBuffer());
}

async function runFfmpeg(args: string[]): Promise<string | null> {
	try {
		await execFileAsync('ffmpeg', args);
		return null;
	} catch (error) {
		return (error as { stderr?: string }).stderr?.trim() || String(error);
	}
}

type ResolveFailure = { status: number | null; message: string };
type ResolvedStream = { url: string } | ResolveFailure;

async function resolveStreamUrl(
	soundcloud: SoundcloudClient,
	track: SoundcloudTrack,
	transcoding: SoundcloudTranscoding,
): Promise<ResolvedStream> {
	const params: Record<string, string> = {};
	if (track.track_authorization) params.track_authorization = track.track_authorization;
	try {
		const body = (await soundcloud.api.getURL(transcoding.url, params)) as { url?: string };
		if (!body.url) return { status: null, message: 'resolve response carried no url' };
		return { url: body.url };
	} catch (error) {
		const message = errorMessage(error);
		const status = /Status code (\d+)/.exec(message)?.[1];
		return { status: status ? Number(status) : null, message };
	}
}

function resolveFailure(prefix: string, resolved: ResolveFailure): HlsDownloadResult {
	return failure(`${prefix} resolve failed: ${resolved.message}`, resolved.status === 404);
}

async function ffmpegPlaylistFetch(playlistUrl: string, filePath: string): Promise<string | null> {
	return runFfmpeg([
		'-y',
		'-loglevel',
		'error',
		'-allowed_extensions',
		'ALL',
		'-protocol_whitelist',
		'file,http,https,tcp,tls,crypto',
		'-i',
		playlistUrl,
		'-c',
		'copy',
		filePath,
	]);
}

export async function downloadClearHls(
	soundcloud: SoundcloudClient,
	track: SoundcloudTrack,
	tempDir: string,
	trackKey: string,
): Promise<HlsDownloadResult> {
	const transcoding = clearHlsTranscoding(track);
	if (!transcoding) return failure('no clear HLS transcoding offered', true);
	const resolved = await resolveStreamUrl(soundcloud, track, transcoding);
	if ('status' in resolved) return resolveFailure('clear HLS', resolved);
	const filePath = path.join(
		tempDir,
		`${trackKey}.${transcoding.format.mime_type.includes('mp4') ? 'm4a' : 'mp3'}`,
	);
	const fetchError = await ffmpegPlaylistFetch(resolved.url, filePath);
	if (fetchError) {
		await cleanupFile(filePath, 'failed clear HLS output');
		return failure(
			`ffmpeg clear HLS fetch failed: ${fetchError}`,
			/HTTP error 40[34]\b/.test(fetchError),
		);
	}
	return {
		success: true,
		filePath,
		protocol: 'hls',
		preset: transcoding.preset,
		keyMethod: null,
	};
}

export async function downloadEncryptedHls(
	soundcloud: SoundcloudClient,
	track: SoundcloudTrack,
	tempDir: string,
	trackKey: string,
): Promise<HlsDownloadResult> {
	const transcoding = encryptedHlsTranscoding(track);
	if (!transcoding) return failure('no encrypted HLS transcoding offered', true);
	const protocol = transcoding.format.protocol;
	const resolved = await resolveStreamUrl(soundcloud, track, transcoding);
	if ('status' in resolved) return resolveFailure('encrypted HLS', resolved);

	const playlistResponse = await fetch(resolved.url);
	if (!playlistResponse.ok) {
		const status = playlistResponse.status;
		return failure(
			`playlist fetch failed with HTTP ${status}`,
			status === 403 || status === 404,
		);
	}
	const playlistText = await playlistResponse.text();
	const licensed = licenseDelivery(playlistText);
	if (licensed) {
		return failure(`key delivery is license-server DRM (${licensed}) — no https key`, true);
	}
	const keyMethod = playlistKeyMethod(playlistText);
	if (!isSupportedKeyMethod(keyMethod)) {
		return failure(`unsupported HLS key method "${keyMethod}" on ${protocol}`, true);
	}
	const parsed = parseMediaPlaylist(playlistText, resolved.url);

	const filePath = path.join(tempDir, `${trackKey}.m4a`);
	if (keyMethod === 'SAMPLE-AES' && parsed.initUri) {
		if (!parsed.keyUri) return failure('SAMPLE-AES manifest has no key URI', true);
		let key: Buffer;
		try {
			key = await fetchBytes(parsed.keyUri);
		} catch (error) {
			return failure(`key fetch failed: ${errorMessage(error)}`, false);
		}
		const parts: Buffer[] = [];
		try {
			parts.push(await fetchBytes(parsed.initUri));
			for (const segmentUri of parsed.segmentUris) {
				parts.push(await fetchBytes(segmentUri));
			}
		} catch (error) {
			return failure(`segment fetch failed: ${errorMessage(error)}`, false);
		}
		const packedPath = path.join(tempDir, `packed_${trackKey}.mp4`);
		await fs.promises.writeFile(packedPath, Buffer.concat(parts));
		const decryptError = await runFfmpeg([
			'-y',
			'-loglevel',
			'error',
			'-decryption_key',
			key.toString('hex'),
			'-i',
			packedPath,
			'-c',
			'copy',
			filePath,
		]);
		await cleanupFile(packedPath, 'packed encrypted fmp4');
		if (decryptError) {
			await cleanupFile(filePath, 'failed fMP4 decrypt output');
			return failure(`ffmpeg fMP4 decrypt failed: ${decryptError}`, true);
		}
	} else {
		const fetchError = await ffmpegPlaylistFetch(resolved.url, filePath);
		if (fetchError) {
			await cleanupFile(filePath, 'failed encrypted HLS output');
			return failure(
				`ffmpeg encrypted HLS fetch failed: ${fetchError}`,
				/HTTP error 40[34]\b/.test(fetchError),
			);
		}
	}

	const decodeError = await runFfmpeg([
		'-v',
		'error',
		'-xerror',
		'-t',
		'60',
		'-i',
		filePath,
		'-f',
		'null',
		'-',
	]);
	if (decodeError) {
		await cleanupFile(filePath, 'undecodable encrypted HLS output');
		return failure(`stream still encrypted after fetch (decode probe): ${decodeError}`, true);
	}
	return { success: true, filePath, keyMethod, protocol, preset: transcoding.preset };
}
