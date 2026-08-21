import { describe, expect, test } from 'bun:test';
import { permanentSkipReason, requiresEncryptedHls } from '../src/skipPolicy.ts';
import type { SoundcloudTrack } from '../src/types.ts';

function trackWithProtocols(...protocols: string[]): SoundcloudTrack {
	return {
		media: {
			transcodings: protocols.map((protocol) => ({
				url: `https://api-v2.soundcloud.com/${protocol}`,
				preset: 'aac_160k',
				duration: 1,
				snipped: false,
				format: { protocol, mime_type: 'audio/mp4' },
				quality: 'sq',
			})),
		},
	} as SoundcloudTrack;
}

describe('permanentSkipReason', () => {
	test('classifies library errors that can never succeed', () => {
		expect(
			permanentSkipReason(new Error('Could not get stream link for progressive download')),
		).toBe('drm-unrecoverable');
		expect(permanentSkipReason(new Error('No supported transcodings'))).toBe(
			'drm-unrecoverable',
		);
		expect(permanentSkipReason('No transcodings found')).toBe('drm-unrecoverable');
	});

	test('retries authentication and network failures', () => {
		expect(permanentSkipReason(new Error('Status code 401'))).toBeNull();
		expect(permanentSkipReason(new Error('socket hang up'))).toBeNull();
	});
});

describe('requiresEncryptedHls', () => {
	test('true when every transcoding is encrypted', () => {
		expect(requiresEncryptedHls(trackWithProtocols('cbc-encrypted-hls'))).toBe(true);
		expect(
			requiresEncryptedHls(trackWithProtocols('cbc-encrypted-hls', 'ctr-encrypted-hls')),
		).toBe(true);
	});

	test('false when a clear stream is offered', () => {
		expect(requiresEncryptedHls(trackWithProtocols('progressive', 'cbc-encrypted-hls'))).toBe(
			false,
		);
		expect(requiresEncryptedHls(trackWithProtocols('hls', 'cbc-encrypted-hls'))).toBe(false);
	});

	test('false when a purchasable download is available instead', () => {
		const track = trackWithProtocols('cbc-encrypted-hls');
		track.downloadable = true;
		(track as SoundcloudTrack & { has_downloads_left: boolean }).has_downloads_left = true;
		expect(requiresEncryptedHls(track)).toBe(false);
	});

	test('false when no transcodings are listed at all', () => {
		expect(requiresEncryptedHls(trackWithProtocols())).toBe(false);
	});
});
