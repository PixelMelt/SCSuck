import { describe, expect, test } from 'bun:test';
import { clearHlsTranscoding, encryptedHlsTranscodings } from '../src/hlsStreams.ts';
import type { SoundcloudTrack } from '../src/types.ts';

interface TranscodingSpec {
	protocol: string;
	mime?: string;
	quality?: string;
	preset?: string;
}

function trackWith(...transcodings: TranscodingSpec[]): SoundcloudTrack {
	return {
		media: {
			transcodings: transcodings.map((t) => ({
				url: `https://api-v2.soundcloud.com/${t.protocol}/${t.preset ?? 'x'}`,
				preset: t.preset ?? 'aac_160k',
				duration: 1,
				snipped: false,
				format: { protocol: t.protocol, mime_type: t.mime ?? 'audio/mp4' },
				quality: t.quality ?? 'sq',
			})),
		},
	} as SoundcloudTrack;
}

describe('encryptedHlsTranscodings', () => {
	test('keeps every encrypted media rendition', () => {
		const matches = encryptedHlsTranscodings(
			trackWith({ protocol: 'ctr-encrypted-hls' }, { protocol: 'cbc-encrypted-hls' }, { protocol: 'hls' }),
		);
		expect(matches.map((t) => t.format.protocol)).toEqual(['ctr-encrypted-hls', 'cbc-encrypted-hls']);
	});

	test('excludes encrypted master playlists', () => {
		expect(
			encryptedHlsTranscodings(trackWith({ protocol: 'cbc-encrypted-hls', mime: 'audio/mpegurl' })),
		).toEqual([]);
	});

	test('is empty when nothing is encrypted', () => {
		expect(
			encryptedHlsTranscodings(trackWith({ protocol: 'progressive' }, { protocol: 'hls' })),
		).toEqual([]);
	});
});

describe('clearHlsTranscoding', () => {
	test('prefers sq aac over sq mp3 and lq aac', () => {
		const match = clearHlsTranscoding(
			trackWith(
				{ protocol: 'hls', mime: 'audio/mpeg', quality: 'sq', preset: 'mp3_1_0' },
				{ protocol: 'hls', mime: 'audio/mp4', quality: 'lq', preset: 'aac_96k' },
				{ protocol: 'hls', mime: 'audio/mp4', quality: 'sq', preset: 'aac_160k' },
			),
		);
		expect(match?.preset).toBe('aac_160k');
	});

	test('prefers sq mp3 over lq aac', () => {
		const match = clearHlsTranscoding(
			trackWith(
				{ protocol: 'hls', mime: 'audio/mp4', quality: 'lq', preset: 'aac_96k' },
				{ protocol: 'hls', mime: 'audio/mpeg', quality: 'sq', preset: 'mp3_1_0' },
			),
		);
		expect(match?.preset).toBe('mp3_1_0');
	});

	test('skips abr master playlists', () => {
		const match = clearHlsTranscoding(
			trackWith(
				{ protocol: 'hls', mime: 'audio/mpegurl', preset: 'abr_sq' },
				{ protocol: 'hls', mime: 'audio/mp4', preset: 'aac_160k' },
			),
		);
		expect(match?.preset).toBe('aac_160k');
		expect(
			clearHlsTranscoding(trackWith({ protocol: 'hls', mime: 'audio/mpegurl' })),
		).toBeNull();
	});

	test('ignores encrypted and progressive protocols', () => {
		expect(
			clearHlsTranscoding(
				trackWith({ protocol: 'cbc-encrypted-hls' }, { protocol: 'progressive' }),
			),
		).toBeNull();
	});

	test('returns null with no transcodings', () => {
		expect(clearHlsTranscoding(trackWith())).toBeNull();
	});
});
