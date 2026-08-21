import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const name = process.argv[2];
const secondsArg = process.argv[3];
if (!name || (secondsArg && Number.isNaN(Number(secondsArg)))) {
	console.error('usage: bun scripts/capture-playback.ts <name> [seconds]');
	console.error('records the default output monitor to capture/<name>.flac');
	console.error('override the source with SCS_CAPTURE_SOURCE=<pactl source name>');
	process.exit(1);
}
const seconds = secondsArg ? Number(secondsArg) : null;

const source =
	process.env.SCS_CAPTURE_SOURCE ??
	`${execSync('pactl get-default-sink').toString().trim()}.monitor`;

const outDir = 'capture';
await fs.promises.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${name}.flac`);

console.log(` -> Recording from ${source}`);
console.log(
	` -> Play the track in your browser; ${seconds ? `stops automatically after ${seconds}s` : 'press Enter to stop'}`,
);

const parec = spawn('parec', ['-d', source, '--format=s16le', '--rate=48000', '--channels=2'], {
	stdio: ['ignore', 'pipe', 'inherit'],
});
const ffmpeg = spawn(
	'ffmpeg',
	[
		'-y',
		'-v',
		'error',
		'-f',
		's16le',
		'-ar',
		'48000',
		'-ac',
		'2',
		'-i',
		'pipe:0',
		'-c:a',
		'flac',
		'-compression_level',
		'8',
		outPath,
	],
	{ stdio: ['pipe', 'ignore', 'inherit'] },
);
parec.stdout.pipe(ffmpeg.stdin);

const stop = () => parec.kill('SIGINT');
parec.stdout.once('data', () => {
	if (seconds) setTimeout(stop, seconds * 1000);
});
if (!seconds) process.stdin.once('data', stop);

const exitCode = await new Promise<number>((resolvePromise) =>
	ffmpeg.on('exit', (code) => resolvePromise(code ?? 1)),
);
if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);
const stats = await fs.promises.stat(outPath);
console.log(` -> Saved ${outPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
