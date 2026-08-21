import fs from 'fs';
import path from 'path';
import { rewriteArtistTag } from './metadataWriter.ts';
import {
	artistDirName,
	errorMessage,
	pathExists,
	removeIfEmpty,
	resolveStoredTrackPath,
} from './utils.ts';
import type Database from './database.ts';

async function mergeDirectoryContents(
	srcDir: string,
	destDir: string,
): Promise<{ moved: number; skipped: string[] }> {
	const items = await fs.promises.readdir(srcDir);
	let moved = 0;
	const skipped: string[] = [];
	for (const item of items) {
		const srcItem = path.join(srcDir, item);
		const destItem = path.join(destDir, item);

		if (!(await pathExists(destItem))) {
			await fs.promises.rename(srcItem, destItem);
			moved++;
			continue;
		}

		const [srcStat, destStat] = await Promise.all([
			fs.promises.stat(srcItem),
			fs.promises.stat(destItem),
		]);
		if (srcStat.isDirectory() && destStat.isDirectory()) {
			const sub = await mergeDirectoryContents(srcItem, destItem);
			moved += sub.moved;
			skipped.push(...sub.skipped.map((s) => path.join(item, s)));
			await removeIfEmpty(srcItem);
		} else {
			skipped.push(item);
		}
	}
	return { moved, skipped };
}

class ArtistRenameManager {
	private database: Database;
	private outputDir: string;

	constructor(database: Database, outputDir: string) {
		this.database = database;
		this.outputDir = outputDir;
	}

	async handleRename(artistId: number, newUsername: string, oldUsername: string): Promise<void> {
		console.log(`Updating artist name from "${oldUsername}" to "${newUsername}"...`);

		const oldDirName = artistDirName(oldUsername, artistId);
		const newDirName = artistDirName(newUsername, artistId);
		if (oldDirName !== newDirName) {
			const oldArtistDir = path.join(this.outputDir, oldDirName);
			const newArtistDir = path.join(this.outputDir, newDirName);

			if (!(await pathExists(oldArtistDir))) {
				console.log(` -> Artist directory not found (may already be renamed)`);
			} else if (await pathExists(newArtistDir)) {
				console.log(` -> Merging old artist directory into new one...`);
				const { moved, skipped } = await mergeDirectoryContents(oldArtistDir, newArtistDir);
				for (const item of skipped) {
					console.log(`    SKIP (exists): ${item}`);
				}
				console.log(` -> Moved ${moved} items from old directory`);
				console.log(
					(await removeIfEmpty(oldArtistDir))
						? ` -> Removed empty old directory`
						: ` -> Old directory not empty, keeping it`,
				);
			} else {
				await fs.promises.rename(oldArtistDir, newArtistDir);
				console.log(` -> Renamed artist directory on disk`);
			}

			const updated = await this.database.updateArtistTrackPathPrefix(
				artistId,
				oldDirName,
				newDirName,
				path.resolve(this.outputDir),
			);
			console.log(` -> Updated ${updated} file paths in database`);
		}

		await this.rewriteArtistTags(artistId, newUsername);
	}

	private async rewriteArtistTags(artistId: number, newUsername: string): Promise<void> {
		const tracks = await this.database.getTracksByArtist(artistId);

		if (tracks.length === 0) {
			console.log(` -> No tracks found in database for artist ${artistId}`);
			return;
		}

		let successCount = 0;
		let failCount = 0;

		for (const track of tracks) {
			if (!track.file_path) continue;
			try {
				rewriteArtistTag(
					resolveStoredTrackPath(this.outputDir, track.file_path),
					newUsername,
				);
				successCount++;
			} catch (error) {
				failCount++;
				console.warn(
					` -> Failed to update metadata for ${track.file_path}: ${errorMessage(error)}`,
				);
			}
		}

		console.log(
			` -> Updated metadata: ${successCount} succeeded, ${failCount} failed (out of ${tracks.length} tracks)`,
		);
	}

	async mergeDuplicateDirectories(): Promise<void> {
		console.log('Scanning for duplicate artist directories...');

		const entries = await fs.promises.readdir(this.outputDir, { withFileTypes: true });
		const dirsByArtistId = new Map<string, string[]>();

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const match = entry.name.match(/\[(\d+)\]$/);
			if (!match) continue;
			const artistId = match[1]!;
			dirsByArtistId.set(artistId, [...(dirsByArtistId.get(artistId) ?? []), entry.name]);
		}

		const duplicates = [...dirsByArtistId.entries()].filter(([, dirs]) => dirs.length > 1);

		if (duplicates.length === 0) {
			console.log('No duplicate directories found.');
			return;
		}

		console.log(`Found ${duplicates.length} artists with duplicate directories.\n`);

		for (const [artistId, dirs] of duplicates) {
			const artist = await this.database.getArtistById(artistId);
			if (!artist) {
				console.log(`[${artistId}] Not in database, skipping: ${dirs.join(', ')}`);
				continue;
			}

			const correctDirName = artistDirName(artist.username, artistId);
			const correctDirPath = path.join(this.outputDir, correctDirName);

			console.log(`[${artistId}] ${artist.username}`);
			console.log(`  Correct: ${correctDirName}`);

			await fs.promises.mkdir(correctDirPath, { recursive: true });

			for (const dirName of dirs) {
				if (dirName === correctDirName) continue;

				const srcPath = path.join(this.outputDir, dirName);
				console.log(`  Merging: ${dirName}`);

				const { moved, skipped } = await mergeDirectoryContents(srcPath, correctDirPath);
				console.log(`    Moved ${moved} items, skipped ${skipped.length} existing`);

				const updated = await this.database.updateArtistTrackPathPrefix(
					artistId,
					dirName,
					correctDirName,
					path.resolve(this.outputDir),
				);
				if (updated > 0) {
					console.log(`    Updated ${updated} file paths in database`);
				}

				if (await removeIfEmpty(srcPath)) {
					console.log(`    Removed empty directory`);
				} else {
					const remaining = await fs.promises.readdir(srcPath);
					console.log(`    Directory not empty (${remaining.length} items remain)`);
				}
			}
			console.log('');
		}

		console.log('Merge complete.');
	}
}

export default ArtistRenameManager;
