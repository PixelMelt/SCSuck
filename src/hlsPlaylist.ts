import type { MediaPlaylist } from './types.ts';

const SUPPORTED_KEY_METHODS = ['AES-128', 'SAMPLE-AES'];

export const WIDEVINE_KEYFORMAT = 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';

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
		if (line.includes(`KEYFORMAT="${WIDEVINE_KEYFORMAT}"`)) return 'Widevine (cenc PSSH)';
	}
	return null;
}

export function widevineKeyLines(playlist: string): string[] {
	return playlist
		.split('\n')
		.filter((line) => line.includes(`KEYFORMAT="${WIDEVINE_KEYFORMAT}"`));
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
