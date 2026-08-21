import type { CoArtistInput, EnrichedTrack } from './types.ts';

const SEPARATORS = /[-–—:]/;

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripRedundantArtistPrefix(title: string, artistNames: string[]): string {
	let result = title;
	let strippedAny = false;
	let changed = true;
	while (changed) {
		changed = false;
		for (const name of artistNames) {
			if (!name) continue;
			const pattern = new RegExp(
				`^\\s*${escapeRegex(name)}\\s*${SEPARATORS.source}\\s+`,
				'i',
			);
			const stripped = result.replace(pattern, '');
			if (stripped !== result && stripped.trim().length > 0) {
				result = stripped;
				changed = true;
				strippedAny = true;
			}
		}
	}
	if (!strippedAny) return title;
	return result.trim();
}

const STOP_WORDS =
	/\b(remix|rmx|edit|bootleg|flip|vip|mashup|mash-up|cover|remaster(ed)?|instrumental|acapella|mix|version|sped ?up|slowed|reverb|nightcore|bass ?boost(ed)?|free (download|dl)|out now|preview|snippet|wip|demo|full|original|extended|radio|clip|prod\.?|lyrics?|video|audio|official|hq|hd)\b/i;

const FEAT_MARKER = /\b(?:feat\.?|ft\.?|featuring)\s+/gi;
const W_SLASH_MARKER = /(?:^|[\s([])w\/\s*/gi;

const MAX_CANDIDATE_WORDS = 4;
const MAX_CANDIDATE_LENGTH = 40;
const MAX_CO_ARTISTS = 6;

const GENERIC_NAMES = new Set(['music', 'records', 'recordings', 'label', 'sounds', 'archive']);

function cleanCandidate(raw: string): string | null {
	let name = raw.trim();
	name = name.replace(/^["'“”*\s]+|["'“”.,;!*\s]+$/g, '').trim();
	if (!name) return null;
	if (name.length > MAX_CANDIDATE_LENGTH) return null;
	if (name.split(/\s+/).length > MAX_CANDIDATE_WORDS) return null;
	if (/^\d+$/.test(name)) return null;
	if (STOP_WORDS.test(name)) return null;
	if (GENERIC_NAMES.has(name.toLowerCase())) return null;
	if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\b(19|20)\d{2}\b/.test(name)) return null;
	if (/\.(mp3|m4a|wav|flac|ogg|aiff)$/i.test(name)) return null;
	return name;
}

function splitArtistList(segment: string): string[] {
	return segment
		.split(/\s*(?:,|&|\+|\||\bvs\.?\b)\s*|\s+[xX]\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function captureAfterMarkers(text: string, marker: RegExp): string[] {
	const segments: string[] = [];
	marker.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = marker.exec(text)) !== null) {
		const rest = text.slice(match.index + match[0].length);
		const end = rest.search(/[()[\]]|\s+[-–—]\s+|[\r\n]/);
		segments.push(end === -1 ? rest : rest.slice(0, end));
	}
	return segments;
}

function looksLikeProperName(name: string): boolean {
	return /\p{Lu}|\d/u.test(name);
}

function beforeFirstMarker(text: string, marker: RegExp): string {
	marker.lastIndex = 0;
	const match = marker.exec(text);
	return match ? text.slice(0, match.index) : text;
}

function normalizeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

export function extractCoArtists(input: CoArtistInput): string[] {
	const { title, description, publisherArtist, mainArtist } = input;
	const excluded = new Set(
		[mainArtist, ...(input.mainArtistAliases ?? [])].filter(Boolean).map(normalizeName),
	);

	const found: string[] = [];
	const seen = new Set<string>();

	const add = (raw: string) => {
		const name = cleanCandidate(raw);
		if (!name) return;
		const key = normalizeName(name);
		if (!key || excluded.has(key) || seen.has(key)) return;
		seen.add(key);
		found.push(name);
	};

	if (publisherArtist) {
		for (const segment of captureAfterMarkers(publisherArtist, FEAT_MARKER)) {
			for (const part of splitArtistList(segment)) add(part);
		}
		const headParts = splitArtistList(beforeFirstMarker(publisherArtist, FEAT_MARKER));
		if (headParts.length >= 2 && headParts.some((p) => excluded.has(normalizeName(p)))) {
			for (const part of headParts) add(part);
		}
	}

	for (const segment of captureAfterMarkers(title, FEAT_MARKER)) {
		for (const part of splitArtistList(segment)) add(part);
	}
	for (const segment of captureAfterMarkers(title, W_SLASH_MARKER)) {
		for (const part of splitArtistList(segment)) add(part);
	}

	const sepMatch = /\s[-–—]\s/.exec(title);
	if (sepMatch) {
		const artistSegment = title.slice(0, sepMatch.index);
		if (/\s[xX]\s|&|,/.test(artistSegment)) {
			const parts = splitArtistList(beforeFirstMarker(artistSegment, FEAT_MARKER));
			const includesMain = parts.some((p) => excluded.has(normalizeName(p)));
			if (includesMain) {
				for (const part of parts) add(part);
			}
		}
	}

	if (description) {
		const firstLines = description.split(/\r?\n/).slice(0, 2).join('\n');
		for (const segment of captureAfterMarkers(firstLines, FEAT_MARKER)) {
			for (const part of splitArtistList(segment)) {
				if (looksLikeProperName(part)) add(part);
			}
		}
	}

	return found.slice(0, MAX_CO_ARTISTS);
}

export function displayTitle(
	track: Pick<EnrichedTrack, 'title' | 'revisionDate'>,
	artistNames: string[],
): string {
	const base = stripRedundantArtistPrefix(track.title, artistNames);
	return track.revisionDate ? `${base} (${track.revisionDate})` : base;
}
