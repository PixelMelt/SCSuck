import 'dotenv/config';
import Soundcloud from 'soundcloud.ts';
import { loadConfig } from '../src/configLoader.ts';
import { downloadClearHls, downloadEncryptedHls } from '../src/hlsStreams.ts';
import type { SoundcloudTrack } from '../src/types.ts';

const trackId = process.argv[2];
if (!trackId) {
	console.error('usage: bun scripts/prove-hls-chain.ts <trackId>');
	process.exit(1);
}

const config = loadConfig();
const soundcloud = new Soundcloud(config.clientId, config.oauthToken);
const trackRes = await fetch(
	`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${config.clientId}`,
	{ headers: { Authorization: `OAuth ${config.oauthToken}` } },
);
if (!trackRes.ok) throw new Error(`track fetch: HTTP ${trackRes.status}`);
const track = (await trackRes.json()) as SoundcloudTrack;
console.log(`track: ${track.title} [${track.id}]`);

const clear = await downloadClearHls(soundcloud, track, 'scripts/dump', `proof_${trackId}`);
if (clear.success) {
	console.log(`clear HLS: ${clear.filePath} (${clear.protocol} ${clear.preset})`);
} else {
	console.log(`clear HLS failed (permanent=${clear.permanent}): ${clear.message}`);
	const encrypted = await downloadEncryptedHls(
		soundcloud,
		track,
		'scripts/dump',
		`proof_${trackId}`,
	);
	if (encrypted.success) {
		console.log(
			`encrypted HLS: ${encrypted.filePath} (${encrypted.protocol} ${encrypted.preset})`,
		);
	} else {
		console.log(
			`encrypted HLS failed (permanent=${encrypted.permanent}): ${encrypted.message}`,
		);
	}
}
