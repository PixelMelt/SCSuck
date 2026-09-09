import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseMediaPlaylist, widevineKeyLines } from '../../src/hlsPlaylist.ts';
import type { DecryptionRequest } from '../../src/types.ts';

const exec = promisify(execFile);
const directory = process.argv[2]!;
const job = JSON.parse(
	await fs.readFile(path.join(directory, 'request.json'), 'utf8'),
) as DecryptionRequest;

async function media(url: string): Promise<Response> {
	const parsed = new URL(url);
	if (
		parsed.protocol !== 'https:' ||
		!(
			parsed.hostname.endsWith('.sndcdn.com') ||
			parsed.hostname === 'playback.media-streaming.soundcloud.cloud'
		) ||
		parsed.port ||
		parsed.username ||
		parsed.password
	)
		throw new Error('Unsupported media host');
	const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`Media HTTP ${response.status}`);
	return response;
}

const playlist = await (await media(job.url)).text();
if (
	!playlist.includes('#EXT-X-ENDLIST') ||
	/#EXT-X-(BYTERANGE|DISCONTINUITY|STREAM-INF):?/.test(playlist)
)
	throw new Error('Unsupported segmented playlist layout');
if (playlist.split('\n').filter((line) => line.startsWith('#EXT-X-MAP:')).length !== 1)
	throw new Error('Expected one init segment');
const parsed = parseMediaPlaylist(playlist, job.url);
if (!parsed.initUri || !parsed.segmentUris.length) throw new Error('Missing media segments');
const keyLines = widevineKeyLines(playlist);
if (new Set(keyLines).size !== 1) throw new Error('Expected one Widevine key declaration');
const encoded = /URI="data:[^,]+,([^"\s]+)"/.exec(keyLines[0]!)?.[1];
if (!encoded) throw new Error('Missing PSSH');
const pssh = Buffer.from(encoded, 'base64');
const inputPath = path.join(directory, 'encrypted.mp4');
const input = await fs.open(inputPath, 'wx');
try {
	for (const url of [parsed.initUri, ...parsed.segmentUris]) {
		const response = await media(url);
		if (!response.body) throw new Error('Missing media body');
		for await (const chunk of response.body) await input.writeFile(chunk);
	}
} finally {
	await input.close();
}
const probe = JSON.parse(
	(
		await exec('ffprobe', [
			'-v',
			'error',
			'-show_streams',
			'-show_format',
			'-of',
			'json',
			inputPath,
		])
	).stdout,
);
if (
	probe.streams.length !== 1 ||
	probe.streams[0].codec_name !== 'aac' ||
	probe.streams[0].profile !== 'LC'
)
	throw new Error('Expected a single AAC-LC stream');
const duration = Number(probe.format.duration);
if (!Number.isFinite(duration) || duration <= 0) throw new Error('Missing input duration');
const timeoutMs = Math.ceil((duration / 16) * 1000 + 120_000);
if (timeoutMs > 3_500_000) throw new Error('Track exceeds worker time limit');
const licenseUrl = new URL('https://license.media-streaming.soundcloud.cloud/playback/widevine');
licenseUrl.searchParams.set('license_token', job.licenseAuthToken);
const result = Promise.withResolvers<Record<string, unknown>>();
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	idleTimeout: 120,
	async fetch(request) {
		const route = new URL(request.url).pathname;
		if (route === '/')
			return new Response(Bun.file('services/decryption/player.html'), {
				headers: { 'Content-Type': 'text/html' },
			});
		if (route === '/config') return Response.json({ timeoutMs });
		if (route === '/pssh') return new Response(pssh);
		if (route === '/media') return new Response(Bun.file(inputPath));
		if (route === '/license' && request.method === 'POST') {
			try {
				const response = await fetch(licenseUrl, {
					method: 'POST',
					redirect: 'error',
					signal: AbortSignal.timeout(60_000),
					headers: {
						'Content-Type': 'application/octet-stream',
						Origin: 'https://soundcloud.com',
						Referer: 'https://soundcloud.com/',
					},
					body: await request.arrayBuffer(),
				});
				return new Response(await response.arrayBuffer(), { status: response.status });
			} catch {
				result.reject(new Error('License exchange failed'));
				return new Response('License exchange failed', { status: 502 });
			}
		}
		if (route === '/result' && request.method === 'POST') {
			result.resolve((await request.json()) as Record<string, unknown>);
			return new Response('ok');
		}
		return new Response('Not found', { status: 404 });
	},
});
const capturedPath = path.join(directory, 'clear.aac');
const browser = spawn(
	'google-chrome',
	[
		'--headless=new',
		'--no-sandbox',
		'--disable-component-update',
		'--no-first-run',
		'--no-default-browser-check',
		`--user-data-dir=${path.join(directory, 'profile')}`,
		'--autoplay-policy=no-user-gesture-required',
		`http://127.0.0.1:${server.port}/`,
	],
	{
		stdio: 'ignore',
		env: { ...process.env, LD_PRELOAD: '/app/capture.so', SC_CAPTURE_PATH: capturedPath },
	},
);
browser.on('error', (error) => result.reject(error));
browser.on('exit', (code) => result.reject(new Error(`Browser exited ${code}`)));
const timer = setTimeout(() => result.reject(new Error('Decryption timed out')), timeoutMs + 5000);
try {
	const evidence = await result.promise;
	if (!evidence.success) throw new Error(`Decryption failed: ${evidence.error}`);
	const bytes = (await fs.stat(capturedPath)).size;
	if (!bytes || bytes !== evidence.decodedAudioBytes) throw new Error('Incomplete AAC capture');
	const output = path.join(directory, 'audio.m4a');
	await exec('ffmpeg', ['-v', 'error', '-i', capturedPath, '-c:a', 'copy', output]);
	await exec('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
	const verified = JSON.parse(
		(await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', output])).stdout,
	);
	if (Math.abs(Number(verified.format.duration) - duration) > 0.1)
		throw new Error('Decrypted duration does not match input');
} finally {
	clearTimeout(timer);
	browser.kill('SIGTERM');
	server.stop(true);
}
