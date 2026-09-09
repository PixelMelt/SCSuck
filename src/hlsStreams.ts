import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { cleanupFile, errorMessage } from './utils.ts';
import {
	isSupportedKeyMethod,
	licenseDelivery,
	parseMediaPlaylist,
	playlistKeyMethod,
	widevineKeyLines,
} from './hlsPlaylist.ts';
import type {
	HlsDownloadResult,
	DecryptionRequest,
	SoundcloudClient,
	SoundcloudTrack,
	SoundcloudTranscoding,
} from './types.ts';

const execFileAsync = promisify(execFile);

const PREFERRED_PROTOCOLS = ['cbc-encrypted-hls', 'ctr-encrypted-hls'];

export function encryptedHlsTranscodings(track: SoundcloudTrack): SoundcloudTranscoding[] {
	return track.media.transcodings.filter(
		(t) =>
			PREFERRED_PROTOCOLS.includes(t.format.protocol) &&
			t.format.mime_type !== 'audio/mpegurl',
	);
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
type ResolvedStream = { url: string; licenseAuthToken?: string } | ResolveFailure;

async function resolveStreamUrl(
	soundcloud: SoundcloudClient,
	track: SoundcloudTrack,
	transcoding: SoundcloudTranscoding,
): Promise<ResolvedStream> {
	const params: Record<string, string> = {};
	if (track.track_authorization) params.track_authorization = track.track_authorization;
	try {
		const body = (await soundcloud.api.getURL(transcoding.url, params)) as {
			url?: string;
			licenseAuthToken?: string;
		};
		if (!body.url) return { status: null, message: 'resolve response carried no url' };
		return { url: body.url, licenseAuthToken: body.licenseAuthToken };
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
	decryptionServiceUrl: string | null,
): Promise<HlsDownloadResult> {
	const preferred = decryptionServiceUrl ? 'ctr-encrypted-hls' : 'cbc-encrypted-hls';
	const rank = (t: SoundcloudTranscoding) =>
		(t.quality === 'sq' ? 0 : 10) + (t.format.protocol === preferred ? 0 : 1);
	const candidates = encryptedHlsTranscodings(track).sort((a, b) => rank(a) - rank(b));
	if (!candidates.length) return failure('no encrypted HLS transcoding offered', true);
	const errors: string[] = [];
	let permanent = true;
	for (const transcoding of candidates) {
		const label = `${transcoding.format.protocol} ${transcoding.preset}`;
		const result = await downloadEncryptedRendition(
			soundcloud,
			track,
			tempDir,
			trackKey,
			transcoding,
		);
		if ('widevine' in result) {
			if (decryptionServiceUrl) {
				return decryptViaService(
					decryptionServiceUrl,
					result.widevine,
					tempDir,
					trackKey,
					transcoding,
				);
			}
			errors.push(`${label}: key delivery is Widevine — no decryption service configured`);
			continue;
		}
		if (result.success) return result;
		errors.push(`${label}: ${result.message}`);
		permanent &&= result.permanent;
	}
	return failure(errors.join('; '), permanent);
}

async function decryptViaService(
	serviceUrl: string,
	request: DecryptionRequest,
	tempDir: string,
	trackKey: string,
	transcoding: SoundcloudTranscoding,
): Promise<HlsDownloadResult> {
	const filePath = path.join(tempDir, `${trackKey}.m4a`);
	let audio: ArrayBuffer;
	try {
		const response = await fetch(new URL('/decrypt', serviceUrl), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(3_660_000),
		});
		if (!response.ok) {
			return failure(
				`decryption service HTTP ${response.status}: ${await response.text()}`,
				true,
			);
		}
		audio = await response.arrayBuffer();
	} catch (error) {
		return failure(`decryption service unreachable: ${errorMessage(error)}`, true);
	}
	await fs.promises.writeFile(filePath, Buffer.from(audio));
	const decodeError = await runFfmpeg([
		'-v',
		'error',
		'-xerror',
		'-i',
		filePath,
		'-f',
		'null',
		'-',
	]);
	if (decodeError) {
		await cleanupFile(filePath, 'undecodable decryption service output');
		return failure(`decryption service returned undecodable audio: ${decodeError}`, true);
	}
	return {
		success: true,
		filePath,
		protocol: transcoding.format.protocol,
		preset: transcoding.preset,
		keyMethod: 'Widevine',
	};
}

async function downloadEncryptedRendition(
	soundcloud: SoundcloudClient,
	track: SoundcloudTrack,
	tempDir: string,
	trackKey: string,
	transcoding: SoundcloudTranscoding,
): Promise<HlsDownloadResult | { widevine: DecryptionRequest }> {
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
	if (widevineKeyLines(playlistText).length) {
		if (!resolved.licenseAuthToken)
			return failure('Widevine resolver omitted licenseAuthToken', true);
		return { widevine: { url: resolved.url, licenseAuthToken: resolved.licenseAuthToken } };
	}
	const licensed = licenseDelivery(playlistText);
	if (licensed)
		return failure(`key delivery is license-server DRM (${licensed}) — no https key`, true);
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
