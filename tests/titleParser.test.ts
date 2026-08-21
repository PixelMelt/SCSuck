import { describe, expect, test } from 'bun:test';
import { displayTitle, extractCoArtists, stripRedundantArtistPrefix } from '../src/titleParser.ts';

describe('stripRedundantArtistPrefix', () => {
	const cases: [string, string[], string][] = [
		['OMFG - Dying', ['OMFG'], 'Dying'],
		['OMFG - OMFG - Dying', ['OMFG'], 'Dying'],
		['omfg - Dying', ['OMFG'], 'Dying'],
		['OMFG – Dying', ['OMFG'], 'Dying'],
		['OMFG — Dying', ['OMFG'], 'Dying'],
		['OMFG: Dying', ['OMFG'], 'Dying'],
		['Dying', ['OMFG'], 'Dying'],
		['Other Artist - Song', ['OMFG'], 'Other Artist - Song'],
		['OMFG - ', ['OMFG'], 'OMFG - '],
		['OMFGx - Song', ['OMFG'], 'OMFGx - Song'],
		['Old Name - Song', ['New Name', 'Old Name'], 'Song'],
	];

	for (const [title, names, expected] of cases) {
		test(`"${title}" -> "${expected}"`, () => {
			expect(stripRedundantArtistPrefix(title, names)).toBe(expected);
		});
	}

	test('regex metacharacters in artist name are escaped', () => {
		expect(stripRedundantArtistPrefix('A+B (x) - Song', ['A+B (x)'])).toBe('Song');
	});
});

describe('extractCoArtists', () => {
	test('feat. in parens', () => {
		expect(
			extractCoArtists({ title: 'Thailand (feat. Mike Poisson)', mainArtist: 'Guy' }),
		).toEqual(['Mike Poisson']);
	});

	test('ft. without parens', () => {
		expect(
			extractCoArtists({ title: 'A Warmer Breeze ft. Emmanuel Xidos', mainArtist: 'X' }),
		).toEqual(['Emmanuel Xidos']);
	});

	test('featuring with multiple artists', () => {
		expect(
			extractCoArtists({
				title: 'Since You Are Gone (Feat. Godxilla, Ninja & Sketch)',
				mainArtist: 'X',
			}),
		).toEqual(['Godxilla', 'Ninja', 'Sketch']);
	});

	test('leading collab segment including main artist', () => {
		expect(
			extractCoArtists({ title: 'OMFG x Virtual Riot - Collab', mainArtist: 'OMFG' }),
		).toEqual(['Virtual Riot']);
	});

	test('leading collab segment WITHOUT main artist is ignored', () => {
		expect(extractCoArtists({ title: 'Foo x Bar - Some Bootleg', mainArtist: 'OMFG' })).toEqual(
			[],
		);
	});

	test('main artist and aliases are excluded from results', () => {
		expect(
			extractCoArtists({
				title: 'Song (feat. OMFG & Friend)',
				mainArtist: 'OMFG',
				mainArtistAliases: ['OldOMFG'],
			}),
		).toEqual(['Friend']);
	});

	test('publisher metadata artist field', () => {
		expect(
			extractCoArtists({
				title: 'Plain Title',
				publisherArtist: 'Main & Second',
				mainArtist: 'Main',
			}),
		).toEqual(['Second']);
	});

	test('description feat marker', () => {
		expect(
			extractCoArtists({
				title: 'Plain',
				description: 'New single feat. Someone Cool\nmore text',
				mainArtist: 'X',
			}),
		).toEqual(['Someone Cool']);
	});

	test('"Nightcore x Remix" extracts nothing', () => {
		expect(extractCoArtists({ title: 'Nightcore x Remix', mainArtist: 'X' })).toEqual([]);
	});

	test('descriptor stop-words are rejected', () => {
		expect(extractCoArtists({ title: 'Song (feat. VIP Edit)', mainArtist: 'X' })).toEqual([]);
		expect(extractCoArtists({ title: 'Song ft. Sped Up Version', mainArtist: 'X' })).toEqual(
			[],
		);
	});

	test('prod. credit is not a co-artist', () => {
		expect(extractCoArtists({ title: 'Song (prod. SomeProducer)', mainArtist: 'X' })).toEqual(
			[],
		);
	});

	test('feat capture stops at title separator', () => {
		expect(
			extractCoArtists({ title: 'Song ft. Friend - Live at Venue', mainArtist: 'X' }),
		).toEqual(['Friend']);
	});

	test('overlong candidates are rejected', () => {
		expect(
			extractCoArtists({
				title: 'Song (feat. some extremely long non artist descriptive text here)',
				mainArtist: 'X',
			}),
		).toEqual([]);
	});

	test('dedupes case-insensitively across sources', () => {
		expect(
			extractCoArtists({
				title: 'Song (feat. Friend)',
				publisherArtist: 'Main & friend',
				mainArtist: 'Main',
			}),
		).toEqual(['friend']);
	});
});

describe('displayTitle', () => {
	test('strips prefix', () => {
		expect(displayTitle({ title: 'OMFG - Dying' }, ['OMFG'])).toBe('Dying');
	});
	test('appends revision date', () => {
		expect(displayTitle({ title: 'Dying', revisionDate: '2026-07-08' }, ['OMFG'])).toBe(
			'Dying (2026-07-08)',
		);
	});
});
