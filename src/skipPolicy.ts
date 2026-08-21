import { errorMessage } from './utils.ts';
import type { SkipReason, SoundcloudTrack } from './types.ts';

export function requiresEncryptedHls(track: SoundcloudTrack): boolean {
	const transcodings = track.media.transcodings;
	if (transcodings.length === 0) return false;
	const allEncrypted = transcodings.every((t) => t.format.protocol.includes('encrypted'));
	const downloadInstead = track.downloadable === true && track.has_downloads_left === true;
	return allEncrypted && !downloadInstead;
}

export function permanentSkipReason(error: unknown): SkipReason | null {
	const message = errorMessage(error);
	return /Could not get stream link|No supported transcodings|No transcodings found/i.test(
		message,
	)
		? 'drm-unrecoverable'
		: null;
}
