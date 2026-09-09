import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DecryptionRequest } from '../../src/types.ts';

const manifest = JSON.parse(
	await fs.readFile('/opt/google/chrome/WidevineCdm/manifest.json', 'utf8'),
);
if (manifest.version !== '4.10.3050.0') throw new Error('Unsupported Widevine version');
const cdm = await fs.readFile(
	'/opt/google/chrome/WidevineCdm/_platform_specific/linux_x64/libwidevinecdm.so',
);
if (
	createHash('sha256').update(cdm).digest('hex') !==
	'529de3168220c0a8784e19499bfcb84a3fb47001f2175a53b2e8477ece9e97b5'
)
	throw new Error('Unsupported Widevine binary');
await fs.access('/app/capture.so');
let busy = false;
const server = Bun.serve({
	hostname: '0.0.0.0',
	port: 8080,
	idleTimeout: 0,
	maxRequestBodySize: 64 * 1024,
	async fetch(request) {
		const route = new URL(request.url).pathname;
		if (route === '/health' && request.method === 'GET')
			return Response.json({ ready: true, busy });
		if (route !== '/decrypt' || request.method !== 'POST')
			return new Response('Not found', { status: 404 });
		if (busy) return new Response('Worker busy', { status: 503 });
		let job: DecryptionRequest;
		try {
			const body = await request.json();
			if (
				typeof body.url !== 'string' ||
				typeof body.licenseAuthToken !== 'string' ||
				!body.licenseAuthToken
			)
				throw new Error('Invalid request');
			const url = new URL(body.url);
			if (
				url.protocol !== 'https:' ||
				!(
					url.hostname.endsWith('.sndcdn.com') ||
					url.hostname === 'playback.media-streaming.soundcloud.cloud'
				) ||
				url.port ||
				url.username ||
				url.password
			)
				throw new Error('Invalid media URL');
			job = { url: body.url, licenseAuthToken: body.licenseAuthToken };
		} catch {
			return new Response('Expected a SoundCloud CDN URL and licenseAuthToken', {
				status: 400,
			});
		}
		if (busy) return new Response('Worker busy', { status: 503 });
		busy = true;
		let directory: string | undefined;
		let worker: ReturnType<typeof spawn> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			if (worker?.pid) {
				try {
					process.kill(-worker.pid, 'SIGKILL');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
				}
			}
		};
		try {
			directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sc-decrypt-'));
			await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify(job), {
				mode: 0o600,
			});
			worker = spawn('bun', ['services/decryption/worker.ts', directory], {
				detached: true,
				stdio: ['ignore', 'ignore', 'pipe'],
			});
			let stderr = '';
			worker.stderr!.on('data', (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-4096);
			});
			const completed = new Promise<number | null>((resolve, reject) => {
				worker!.on('error', reject);
				worker!.on('exit', resolve);
			});
			request.signal.addEventListener('abort', stop, { once: true });
			timer = setTimeout(stop, 3_600_000);
			if (request.signal.aborted) stop();
			const exitCode = await completed;
			if (exitCode !== 0) {
				const detail = /^error: (.*)$/m.exec(stderr)?.[1] ?? stderr.trim();
				console.error(`Decryption job exited ${exitCode}: ${detail}`);
				return new Response(`Decryption job exited ${exitCode}: ${detail}`, {
					status: 502,
				});
			}
			const audio = await fs.readFile(path.join(directory, 'audio.m4a'));
			return new Response(audio, {
				headers: {
					'Content-Type': 'audio/mp4',
					'X-Audio-SHA256': createHash('sha256').update(audio).digest('hex'),
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Decryption worker failed: ${message}`);
			return new Response(`Decryption worker failed: ${message}`, { status: 502 });
		} finally {
			clearTimeout(timer);
			request.signal.removeEventListener('abort', stop);
			stop();
			try {
				if (directory) await fs.rm(directory, { recursive: true, force: true });
			} finally {
				busy = false;
			}
		}
	},
});
process.on('SIGTERM', () => {
	server.stop(true);
	process.exit(0);
});
console.log('Decryption service listening on port 8080');
