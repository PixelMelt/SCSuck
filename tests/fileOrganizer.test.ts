import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import FileOrganizer, { formatFolderName } from '../src/fileOrganizer.ts';
import { byteLength, MAX_FILENAME_LENGTH, MAX_PATH_LENGTH } from '../src/utils.ts';
import type { AudioQuality, EnrichedTrack } from '../src/types.ts';

const lossless: AudioQuality = {
	isLossless: true,
	bitDepth: 24,
	sampleRate: 96000,
	bitRate: 0,
};

const lossy: AudioQuality = {
	isLossless: false,
	bitDepth: 16,
	sampleRate: 44100,
	bitRate: 320,
};

describe('formatFolderName', () => {
	test('lossless: bit depth and sample rate in brackets', () => {
		expect(formatFolderName('Artist', 'Song', 2025, 'flac', lossless, 42)).toBe(
			'Artist - Song (2025) [WEB-FLAC] [24B-96kHz] [42]',
		);
	});

	test('lossy: bitrate in brackets', () => {
		expect(formatFolderName('Artist', 'Song', 2025, 'mp3', lossy, 42)).toBe(
			'Artist - Song (2025) [WEB-MP3] [320kbps] [42]',
		);
	});

	test('sanitizes hostile characters', () => {
		const name = formatFolderName('A/B', 'C:D', 2025, 'mp3', lossy, 1);
		expect(name).not.toMatch(/[/:]/);
	});

	test('long names are truncated within filename byte limit', () => {
		const name = formatFolderName(
			'X'.repeat(150),
			'Y'.repeat(150),
			2025,
			'flac',
			lossless,
			1234567890,
		);
		expect(byteLength(name)).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
		expect(name).toContain('[1234567890]');
	});

	test('multibyte long names are truncated within byte limit', () => {
		const name = formatFolderName('伶'.repeat(80), '緒'.repeat(80), 2025, 'flac', lossless, 99);
		expect(byteLength(name)).toBeLessThanOrEqual(MAX_FILENAME_LENGTH);
	});

	test('explicit byte budget is honored', () => {
		const name = formatFolderName('Artist', 'T'.repeat(200), 2025, 'mp3', lossy, 7, 120);
		expect(byteLength(name)).toBeLessThanOrEqual(120);
		expect(name).toContain('[7]');
	});

	test('a budget barely over the suffix still keeps the id intact', () => {
		const suffixOnly = formatFolderName('', '', 2025, 'mp3', lossy, 111).slice(3);
		const name = formatFolderName(
			'A'.repeat(80),
			'B'.repeat(80),
			2025,
			'mp3',
			lossy,
			111,
			byteLength(suffixOnly) + 2,
		);
		expect(name).toContain('[111]');
		expect(byteLength(name)).toBeLessThanOrEqual(byteLength(suffixOnly) + 2);
	});

	test('two releases never collapse to the same name under a tight budget', () => {
		const suffixOnly = formatFolderName('', '', 2026, 'mp3', lossy, 111).slice(3);
		const budget = byteLength(suffixOnly) + 1;
		const first = formatFolderName('Artist', 'Song', 2026, 'mp3', lossy, 111, budget);
		const second = formatFolderName('Artist', 'Song', 2026, 'mp3', lossy, 222, budget);
		expect(first).not.toBe(second);
	});

	test('a budget too small for the identity suffix fails loudly', () => {
		expect(() => formatFolderName('Artist', 'Song', 2025, 'mp3', lossy, 42, 10)).toThrow(
			/identity suffix/,
		);
	});
});

describe('organizeSingle empty-title fallback (regression: "01. ." files)', () => {
	test('title that sanitizes to nothing falls back to permalink', async () => {
		const libDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scsuck-notitle-'));
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scsuck-tmp-'));
		try {
			const org = new FileOrganizer(libDir, tempDir);
			const source = path.join(tempDir, 'in.mp3');
			await Bun.write(source, 'fake audio');

			const track = {
				id: 1034915785,
				user_id: 685667159,
				title: '  ',
				permalink: 'some-untitled-track',
				created_at: '2021-05-01T00:00:00Z',
				artwork_url: null,
				visuals: null,
				trackIndex: 1,
				album_id: null,
				album_title: null,
				user: { id: 685667159, username: '¥_@', avatar_url: null },
			} as unknown as EnrichedTrack;

			const result = await org.organizeSingle(track, source, 'mp3', lossy, [
				track.user.username,
			]);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(path.basename(result.finalPath)).toBe('01. some-untitled-track.mp3');
			}
		} finally {
			await fs.promises.rm(libDir, { recursive: true, force: true });
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe('organizeSingle path budget (regression: basmala artist)', () => {
	test('multibyte artist dir + long title still fits MAX_PATH_LENGTH', async () => {
		const libDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scsuck-pathbudget-'));
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scsuck-tmp-'));
		try {
			const org = new FileOrganizer(libDir, tempDir);
			const source = path.join(tempDir, 'in.mp3');
			await Bun.write(source, 'fake audio');

			const track = {
				id: 849998209,
				user_id: 708788506,
				title: 'yo yo yo what the FUCk is that homer simpson on the beat what a fucking clown',
				created_at: '2020-05-01T00:00:00Z',
				artwork_url: null,
				visuals: null,
				trackIndex: 1,
				album_id: null,
				album_title: null,
				user: { id: 708788506, username: '﷽﷽﷽ '.repeat(12), avatar_url: null },
			} as unknown as EnrichedTrack;

			const result = await org.organizeSingle(track, source, 'mp3', lossy, [
				track.user.username,
			]);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(byteLength(result.finalPath)).toBeLessThanOrEqual(MAX_PATH_LENGTH);
				expect(fs.existsSync(result.finalPath)).toBe(true);
			}
		} finally {
			await fs.promises.rm(libDir, { recursive: true, force: true });
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	});
});
