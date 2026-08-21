import { describe, expect, test } from 'bun:test';
import {
	artistDirName,
	byteLength,
	formatDateStamp,
	isLosslessFormat,
	truncateToBytes,
} from '../src/utils.ts';

describe('byteLength', () => {
	test('ascii', () => {
		expect(byteLength('hello')).toBe(5);
	});
	test('multibyte', () => {
		expect(byteLength('伶緒')).toBe(6);
		expect(byteLength('♩✦')).toBe(6);
	});
});

describe('truncateToBytes', () => {
	test('returns unchanged when within limit', () => {
		expect(truncateToBytes('short', 100)).toBe('short');
	});
	test('truncates with suffix', () => {
		const result = truncateToBytes('abcdefghij', 8);
		expect(result).toBe('abcde...');
		expect(byteLength(result)).toBeLessThanOrEqual(8);
	});
	test('never splits multibyte characters past the limit', () => {
		const result = truncateToBytes('伶緒伶緒伶緒伶緒', 10);
		expect(byteLength(result)).toBeLessThanOrEqual(10);
		expect(result.endsWith('...')).toBe(true);
	});
	test('custom suffix', () => {
		const result = truncateToBytes('abcdefghij', 6, '');
		expect(result).toBe('abcdef');
	});
});

describe('isLosslessFormat', () => {
	test('lossless formats', () => {
		for (const fmt of ['wav', 'flac', 'aiff', 'alac', 'FLAC', 'WAV']) {
			expect(isLosslessFormat(fmt)).toBe(true);
		}
	});
	test('lossy formats', () => {
		for (const fmt of ['mp3', 'm4a', 'ogg', 'aac']) {
			expect(isLosslessFormat(fmt)).toBe(false);
		}
	});
});

describe('artistDirName', () => {
	test('simple name', () => {
		expect(artistDirName('OMFG', 123)).toBe('OMFG [123]');
	});
	test('sanitizes filesystem-hostile characters', () => {
		expect(artistDirName('a/b:c', 5)).toBe('abc [5]');
	});
	test('truncates very long names', () => {
		const long = 'x'.repeat(300);
		const result = artistDirName(long, 42);
		expect(byteLength(result)).toBeLessThanOrEqual(100 + ' [42]'.length);
		expect(result.endsWith(' [42]')).toBe(true);
	});
});

describe('formatDateStamp', () => {
	test('parses ISO strings', () => {
		expect(formatDateStamp('2025-03-14T12:00:00Z')).toBe('2025-03-14');
	});
	test('soundcloud last_modified format', () => {
		expect(formatDateStamp('2025/03/14 12:00:00 +0000')).toBe('2025-03-14');
	});
	test('garbage falls back to today', () => {
		const today = new Date().toISOString().slice(0, 10);
		expect(formatDateStamp('not a date')).toBe(today);
	});
});
