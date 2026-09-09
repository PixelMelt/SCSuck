import { describe, expect, test } from 'bun:test';
import {
	isSupportedKeyMethod,
	licenseDelivery,
	parseMediaPlaylist,
	playlistKeyMethod,
	widevineKeyLines,
} from '../src/hlsPlaylist.ts';

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

describe('widevineKeyLines', () => {
	test('returns only the Widevine key declarations', () => {
		const playlist = [
			'#EXTM3U',
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"',
			'#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,AAAAa3Bzc2g=",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
		].join('\n');
		expect(widevineKeyLines(playlist)).toHaveLength(1);
		expect(widevineKeyLines('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k"')).toEqual([]);
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
