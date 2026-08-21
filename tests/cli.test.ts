import { describe, expect, test } from 'bun:test';
import { parseCommand } from '../src/cli.ts';

describe('parseCommand', () => {
	test('no arguments runs the default cycle', () => {
		expect(parseCommand([])).toEqual({ name: 'run' });
	});

	test('long and short aliases resolve to the same command', () => {
		expect(parseCommand(['-a', 'artist'])).toEqual({ name: 'artist', value: 'artist' });
		expect(parseCommand(['--artist', 'artist'])).toEqual({ name: 'artist', value: 'artist' });
		expect(parseCommand(['-l'])).toEqual({ name: 'list' });
		expect(parseCommand(['--merge-dirs'])).toEqual({ name: 'merge-dirs' });
	});

	test('refresh takes an optional artist', () => {
		expect(parseCommand(['--refresh'])).toEqual({ name: 'refresh', value: null });
		expect(parseCommand(['-r', 'someone'])).toEqual({ name: 'refresh', value: 'someone' });
	});

	test('a full URL reaches the command unmodified', () => {
		expect(parseCommand(['--artist', 'https://soundcloud.com/123456'])).toEqual({
			name: 'artist',
			value: 'https://soundcloud.com/123456',
		});
	});

	test('surplus arguments are refused, never ignored', () => {
		expect(() => parseCommand(['--list', 'extra'])).toThrow(/Unexpected argument\(s\)/);
		expect(() => parseCommand(['--run', 'oops'])).toThrow(/Unexpected argument\(s\)/);
		expect(() => parseCommand(['-r', 'a', 'b'])).toThrow(/after -r: b/);
		expect(() => parseCommand(['--artist', 'a', 'b'])).toThrow(/after --artist: b/);
	});

	test('missing required values are refused', () => {
		expect(() => parseCommand(['--artist'])).toThrow(/requires an artist/);
		expect(() => parseCommand(['-d'])).toThrow(/requires an artist/);
		expect(() => parseCommand(['--following'])).toThrow(/requires an artist/);
	});

	test('unknown commands are refused', () => {
		expect(() => parseCommand(['--bogus'])).toThrow(/Unknown command: --bogus/);
	});
});
