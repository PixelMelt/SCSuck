import { describe, expect, test } from 'bun:test';
import {
	clearHlsTranscoding,
	encryptedHlsTranscoding,
	isSupportedKeyMethod,
	licenseDelivery,
	parseMediaPlaylist,
	playlistKeyMethod,
} from '../src/hlsStreams.ts';
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

describe('encryptedHlsTranscoding', () => {
	test('prefers cbc over ctr', () => {
		const match = encryptedHlsTranscoding(
			trackWith({ protocol: 'ctr-encrypted-hls' }, { protocol: 'cbc-encrypted-hls' }),
		);
		expect(match?.format.protocol).toBe('cbc-encrypted-hls');
	});

	test('returns null when nothing is encrypted', () => {
		expect(
			encryptedHlsTranscoding(trackWith({ protocol: 'progressive' }, { protocol: 'hls' })),
		).toBeNull();
	});

	test('returns null with no transcodings', () => {
		expect(encryptedHlsTranscoding(trackWith())).toBeNull();
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

describe('isSupportedKeyMethod', () => {
	test('accepts the methods ffmpeg decrypts at demux time', () => {
		expect(isSupportedKeyMethod('AES-128')).toBe(true);
		expect(isSupportedKeyMethod('SAMPLE-AES')).toBe(true);
		expect(isSupportedKeyMethod(null)).toBe(true);
	});

	test('rejects unknown methods so they fail loudly', () => {
		expect(isSupportedKeyMethod('SAMPLE-AES-CTR')).toBe(false);
		expect(isSupportedKeyMethod('FAIRPLAY')).toBe(false);
	});
});

describe('licenseDelivery', () => {
	test('detects FairPlay skd:// key URIs', () => {
		const playlist =
			'#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://86648633094c522c84698b0c7108a36b",KEYFORMAT="com.apple.streamingkeydelivery"';
		expect(licenseDelivery(playlist)).toBe('FairPlay (skd://)');
	});

	test('detects cenc PSSH and PlayReady data URIs', () => {
		const playlist = [
			'#EXTM3U',
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAAa3Bzc2g=",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
			'#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;charset=UTF-16;base64,0AMAAA==",KEYFORMAT="com.microsoft.playready"',
		].join('\n');
		expect(licenseDelivery(playlist)).toBe('Widevine (cenc PSSH)');
	});

	test('passes https-keyed and keyless playlists', () => {
		expect(
			licenseDelivery(
				'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"',
			),
		).toBeNull();
		expect(licenseDelivery('#EXTM3U\n#EXTINF:6,\nseg.ts')).toBeNull();
	});
});

describe('parseMediaPlaylist', () => {
	test('extracts key, init and segments with relative resolution', () => {
		const playlist = [
			'#EXTM3U',
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example.com/key.bin"',
			'#EXT-X-MAP:URI="init.mp4"',
			'#EXTINF:9.985,',
			'seg-0.m4s',
			'#EXTINF:9.985,',
			'https://cdn.example.com/abs/seg-1.m4s',
		].join('\n');
		const parsed = parseMediaPlaylist(playlist, 'https://cdn.example.com/hls/track.m3u8?sig=1');
		expect(parsed.keyUri).toBe('https://cdn.example.com/key.bin');
		expect(parsed.initUri).toBe('https://cdn.example.com/hls/init.mp4');
		expect(parsed.segmentUris).toEqual([
			'https://cdn.example.com/hls/seg-0.m4s',
			'https://cdn.example.com/abs/seg-1.m4s',
		]);
	});

	test('returns nulls for keyless playlists', () => {
		const parsed = parseMediaPlaylist(
			'#EXTM3U\n#EXTINF:6,\nseg.ts',
			'https://cdn.example.com/x/p.m3u8',
		);
		expect(parsed.keyUri).toBeNull();
		expect(parsed.initUri).toBeNull();
		expect(parsed.segmentUris).toEqual(['https://cdn.example.com/x/seg.ts']);
	});
});

describe('playlistKeyMethod', () => {
	test('reads the EXT-X-KEY method', () => {
		const playlist = [
			'#EXTM3U',
			'#EXT-X-KEY:METHOD=AES-128,URI="https://cf-media.sndcdn.com/key",IV=0x0',
			'#EXTINF:6.0,',
			'seg0.ts',
		].join('\n');
		expect(playlistKeyMethod(playlist)).toBe('AES-128');
	});

	test('returns null for keyless playlists', () => {
		expect(playlistKeyMethod('#EXTM3U\n#EXTINF:6.0,\nseg0.ts')).toBeNull();
	});
});
