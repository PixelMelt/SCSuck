import 'dotenv/config';
import { loadConfig } from '../src/configLoader.ts';

const trackId = process.argv[2];
if (!trackId) {
	console.error('usage: bun scripts/probe-auth-resolve.ts <trackId>');
	process.exit(1);
}

const config = loadConfig();
const HEADERS: Record<string, string> = {
	'User-Agent':
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
	Origin: 'https://soundcloud.com',
	Referer: 'https://soundcloud.com/',
	Accept: 'application/json, text/javascript, */*; q=0.1',
	Authorization: `OAuth ${config.oauthToken}`,
};

const trackRes = await fetch(
	`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${config.clientId}`,
	{ headers: HEADERS },
);
if (!trackRes.ok) throw new Error(`track fetch: HTTP ${trackRes.status}`);
const track = (await trackRes.json()) as {
	title?: string;
	track_authorization?: string | null;
	media?: {
		transcodings?: {
			url: string;
			preset?: string;
			quality?: string;
			format: { protocol: string; mime_type: string };
		}[];
	};
};
const ta = track.track_authorization ?? null;
console.log(`track: ${track.title}`);
console.log(
	`track_authorization: ${ta ? `present (${ta.length} chars, ${ta.slice(0, 24)}...)` : 'ABSENT'}`,
);
const auth = `client_id=${config.clientId}${ta ? `&track_authorization=${ta}` : ''}`;

for (const t of track.media?.transcodings ?? []) {
	const label = `${t.format.protocol} | ${t.preset} | ${t.format.mime_type} | ${t.quality}`;
	const res = await fetch(`${t.url}${t.url.includes('?') ? '&' : '?'}${auth}`, {
		headers: HEADERS,
	});
	if (!res.ok) {
		console.log(`${label}\n    resolve HTTP ${res.status}`);
		continue;
	}
	const { url } = (await res.json()) as { url: string };
	const playlist = await (
		await fetch(url, { headers: { Referer: 'https://soundcloud.com/' } })
	).text();
	const keyLines = playlist.split('\n').filter((l) => l.startsWith('#EXT-X-KEY:'));
	console.log(label);
	if (!keyLines.length) console.log('    CLEAR (no EXT-X-KEY lines)');
	for (const line of keyLines) console.log(`    ${line.slice(0, 140)}`);
}
