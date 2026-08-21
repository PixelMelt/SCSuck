import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { cleanupFile, errorMessage } from './utils.ts';
import type { BackupConfig } from './types.ts';

const BACKUP_PREFIX = 'scsuck-';
const BACKUP_SUFFIX = '.sql.gz';
const KEEP_BACKUPS = 14;

function timestamp(): string {
	return new Date().toISOString().replace(/:/g, '-').replace(/\..*$/, '');
}

async function listBackups(backupDir: string): Promise<{ file: string; mtimeMs: number }[]> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(backupDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}

	const backups: { file: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.startsWith(BACKUP_PREFIX) || !entry.endsWith(BACKUP_SUFFIX)) continue;
		const stat = await fs.promises.stat(path.join(backupDir, entry));
		backups.push({ file: entry, mtimeMs: stat.mtimeMs });
	}
	return backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export async function runBackup(config: BackupConfig): Promise<void> {
	const { database } = config;
	await fs.promises.mkdir(config.backupDir, { recursive: true });

	const outPath = path.join(config.backupDir, `${BACKUP_PREFIX}${timestamp()}${BACKUP_SUFFIX}`);
	const partialPath = `${outPath}.partial`;
	console.log(`Backing up database "${database.database}" to ${outPath}`);

	const child = spawn(
		'pg_dump',
		[
			'-h',
			database.host,
			'-p',
			String(database.port),
			'-U',
			database.user,
			'-d',
			database.database,
			'--no-password',
		],
		{
			env: { ...process.env, PGPASSWORD: database.password },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);

	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

	const exited = new Promise<void>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`)),
		);
	});

	const [piped, dumped] = await Promise.allSettled([
		pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(partialPath)),
		exited,
	]);
	const failed =
		piped.status === 'rejected' ? piped : dumped.status === 'rejected' ? dumped : null;
	if (failed) {
		await cleanupFile(partialPath, 'partial backup');
		throw failed.reason;
	}
	await fs.promises.rename(partialPath, outPath);

	const backups = await listBackups(config.backupDir);
	for (const old of backups.slice(KEEP_BACKUPS)) {
		await fs.promises.unlink(path.join(config.backupDir, old.file));
		console.log(` -> Pruned old backup ${old.file}`);
	}

	console.log(` -> Backup complete: ${outPath}`);
}

export async function runBackupIfDue(config: BackupConfig): Promise<void> {
	if (config.backupIntervalHours <= 0) {
		return;
	}

	try {
		const backups = await listBackups(config.backupDir);
		const newest = backups[0];
		const intervalMs = config.backupIntervalHours * 60 * 60 * 1000;

		if (newest && Date.now() - newest.mtimeMs < intervalMs) {
			return;
		}

		await runBackup(config);
	} catch (error) {
		console.error('Database backup failed (continuing run):', errorMessage(error));
	}
}
