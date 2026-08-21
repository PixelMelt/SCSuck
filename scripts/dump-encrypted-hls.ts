import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/configLoader.ts';

const HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
	Origin: 'https://soundcloud.com',
	Referer: 'https://soundcloud.com/',
	Accept: 'application/json, text/javascript, */*; q=0.1',
};

interface Transcoding {
	url: string;
	preset?: string;
	quality?: string;
	format: { protocol: string; mime_type: string };
}

const trackId = process.argv[2];
if (!trackId) {
	console.error('usage: bun scripts/dump-encrypted-hls.ts <trackId> [protocol]');
	process.exit(1);
}
const wantedProtocol = process.argv[3] ?? 'cbc-encrypted-hls';

const config = loadConfig();
const auth = `client_id=${config.clientId}${config.oauthToken ? `&oauth_token=${config.oauthToken}` : ''}`;
const outDir = path.join('scripts', 'dump', trackId);
await fs.promises.mkdir(outDir, { recursive: true });

const trackRes = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?${auth}`, {
	headers: HEADERS,
});
if (!trackRes.ok) throw new Error(`track fetch: HTTP ${trackRes.status}`);
const track = (await trackRes.json()) as {
	title?: string;
	media?: { transcodings?: Transcoding[] };
};
const transcodings = track.media?.transcodings ?? [];
console.log(`track: ${track.title}`);
for (const t of transcodings) {
	console.log(`  ${t.format.protocol} | ${t.preset} | ${t.format.mime_type} | ${t.quality}`);
}

const enc = transcodings.find((t) => t.format.protocol === wantedProtocol);
if (!enc) throw new Error(`no ${wantedProtocol} transcoding on this track`);
console.log(`\nresolving ${enc.format.protocol}...`);

const streamRes = await fetch(`${enc.url}${enc.url.includes('?') ? '&' : '?'}${auth}`, {
	headers: HEADERS,
});
if (!streamRes.ok) throw new Error(`stream resolve: HTTP ${streamRes.status}`);
const { url: playlistUrl } = (await streamRes.json()) as { url: string };

const playlist = await (await fetch(playlistUrl, { headers: HEADERS })).text();
await fs.promises.writeFile(path.join(outDir, 'playlist.m3u8'), playlist);
console.log(`playlist saved to ${outDir}/playlist.m3u8\n${playlist}`);

for (const line of playlist.split('\n')) {
	if (!line.startsWith('#EXT-X-KEY:') && !line.startsWith('#EXT-X-MAP:')) continue;
	const uri = /URI="([^"]+)"/.exec(line)?.[1];
	if (!uri) continue;
	const scheme = /^[a-z0-9+.-]+:/i.exec(uri)?.[0] ?? '(relative)';
	console.log(`\n${line}\n  -> scheme: ${scheme}`);
	if (scheme !== 'http:' && scheme !== 'https:') continue;
	const absolute = new URL(uri, playlistUrl).toString();
	const name = line.startsWith('#EXT-X-KEY:') ? 'key.bin' : 'init.mp4';
	const bytes = Buffer.from(await (await fetch(absolute, { headers: HEADERS })).arrayBuffer());
	await fs.promises.writeFile(path.join(outDir, name), bytes);
	console.log(
		`  -> saved ${name} (${bytes.length} bytes, hex: ${bytes.subarray(0, 16).toString('hex')})`,
	);
}

const firstSegment = playlist
	.split('\n')
	.map((l) => l.trim())
	.find((l) => l && !l.startsWith('#'));
if (firstSegment) {
	const absolute = new URL(firstSegment, playlistUrl).toString();
	const bytes = Buffer.from(await (await fetch(absolute, { headers: HEADERS })).arrayBuffer());
	await fs.promises.writeFile(path.join(outDir, 'seg-0.bin'), bytes);
	console.log(
		`first segment saved (${bytes.length} bytes, hex: ${bytes.subarray(0, 16).toString('hex')})`,
	);
}
