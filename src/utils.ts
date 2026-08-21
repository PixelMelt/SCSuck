import fs from 'fs';
import path from 'path';
import sanitize from 'sanitize-filename';
import type { TrackKeyInput } from './types.ts';

const LOSSLESS_FORMATS = ['wav', 'flac', 'aiff', 'alac', 'raw'];
export const MAX_PATH_LENGTH = 250;
export const MAX_FILENAME_LENGTH = 240;

export function byteLength(str: string): number {
	return Buffer.byteLength(str, 'utf8');
}

export function truncateToBytes(str: string, maxBytes: number, suffix = '...'): string {
	if (byteLength(str) <= maxBytes) return str;
	const suffixBytes = byteLength(suffix);
	let result = str;
	while (byteLength(result) + suffixBytes > maxBytes && result.length > 0) {
		result = result.slice(0, -1);
	}
	return result + suffix;
}

export async function cleanupFile(filePath: string | null, description: string): Promise<void> {
	if (filePath === null) return;
	try {
		await fs.promises.unlink(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.warn(
				` -> Warn: Failed to cleanup ${description} ${path.basename(filePath)}: ${(error as Error).message}`,
			);
		}
	}
}

export function isLosslessFormat(format: string): boolean {
	return LOSSLESS_FORMATS.includes(format.toLowerCase());
}

export async function removeIfEmpty(dir: string): Promise<boolean> {
	try {
		await fs.promises.rmdir(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return false;
		throw error;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isNotFoundError(error: unknown): boolean {
	const err = error as { status?: number; response?: { status?: number }; message?: string };
	if (err?.status === 404 || err?.response?.status === 404) return true;
	return typeof err?.message === 'string' && /\bStatus code 404\b/.test(err.message);
}

export function sanitizeNameComponent(name: string): string {
	let saniName = sanitize(name);
	if (byteLength(saniName) > 100) {
		saniName = truncateToBytes(saniName, 97);
	}
	return saniName;
}

export function buildTrackKey(track: TrackKeyInput): string {
	const base = `${track.id}-${track.user_id}-${track.album_id ?? 'single'}`;
	return track.revisionDate ? `${base}-r${track.revisionDate}` : base;
}

export function artistDirName(username: string, artistId: number | string): string {
	return `${sanitizeNameComponent(username)} [${artistId}]`;
}

export function resolveStoredTrackPath(outputDir: string, filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(outputDir, filePath);
}

export function formatDateStamp(input: string | Date = new Date()): string {
	const d = input instanceof Date ? input : new Date(input);
	if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
	return d.toISOString().slice(0, 10);
}
