import { File, Picture } from 'node-taglib-sharp';
import { errorMessage } from './utils.ts';
import type { EnrichedTrack } from './types.ts';
import { displayTitle, extractCoArtists } from './titleParser.ts';

export function rewriteArtistTag(filePath: string, newUsername: string): void {
	const file = File.createFromPath(filePath);
	try {
		const coArtists = file.tag.performers.slice(1);
		file.tag.performers = [newUsername, ...coArtists];
		file.tag.albumArtists = [newUsername];
		file.save();
	} finally {
		file.dispose();
	}
}

export function writeMetadata(
	track: EnrichedTrack,
	trackPath: string,
	imagePath: string | null,
	artistNames: string[],
): boolean {
	try {
		const mainArtist = track.user.username;
		const title = displayTitle(track, artistNames);
		const coArtists = extractCoArtists({
			title: track.title,
			description: track.description,
			publisherArtist: track.publisher_metadata?.artist,
			mainArtist,
			mainArtistAliases: artistNames,
		});

		const file = File.createFromPath(trackPath);
		try {
			file.tag.title = title;
			file.tag.performers = [mainArtist, ...coArtists];
			file.tag.albumArtists = [mainArtist];
			file.tag.album = track.album_title || title;
			file.tag.year = new Date(track.created_at).getFullYear();
			if (track.genre) file.tag.genres = [track.genre];
			file.tag.track = track.trackIndex;
			if (track.description) file.tag.comment = track.description;

			file.tag.pictures = [];
			if (imagePath) {
				try {
					file.tag.pictures = [Picture.fromPath(imagePath)];
				} catch (error) {
					console.warn(
						` -> Could not embed cover for ${track.title}: ${errorMessage(error)}`,
					);
				}
			}

			file.save();
		} finally {
			file.dispose();
		}
		return true;
	} catch (error) {
		console.error(` -> Error writing metadata for ${trackPath}: ${errorMessage(error)}`);
		return false;
	}
}
