import fs from 'fs';
import path from 'path';
import { cleanupFile, errorMessage } from './utils.ts';
import type { SoundcloudTrack } from './types.ts';

const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

async function fetchImage(url: string): Promise<Response | null> {
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(30000),
		});
		if (response.status === 200) {
			return response;
		}
		await response.body?.cancel();
		console.warn(`Failed to fetch ${url}: Status Code ${response.status}`);
		return null;
	} catch (error) {
		console.error(`Error fetching image from ${url}:`, errorMessage(error));
		return null;
	}
}

function getSizeIdentifierFromUrl(url: string): string | null {
	const match = url.match(/-([a-z0-9]+)\.jpg$/);
	return match ? match[1]! : null;
}

function getPriorityFromSize(sizeIdentifier: string | null): number {
	if (!sizeIdentifier) return 0;
	if (sizeIdentifier === 't1080x1080') return 5;
	if (sizeIdentifier === 't500x500') return 4;
	if (sizeIdentifier === 'original') return 3;
	if (sizeIdentifier === 'large') return 2;

	return 1;
}

async function fetchAndSelectLargest(urls: string[]): Promise<Response | null> {
	const responses = await Promise.all(urls.map((url) => fetchImage(url)));

	const successfulFetches: { url: string; response: Response }[] = [];
	responses.forEach((response, i) => {
		if (response) successfulFetches.push({ url: urls[i]!, response });
	});

	if (successfulFetches.length === 0) {
		return null;
	}

	let best: Response | null = null;
	let highestPriority = -1;

	for (const { url, response } of successfulFetches) {
		const priority = getPriorityFromSize(getSizeIdentifierFromUrl(url));

		if (priority > highestPriority) {
			if (best) {
				await best.body?.cancel();
			}
			highestPriority = priority;
			best = response;
		} else {
			await response.body?.cancel();
		}
	}

	return best;
}

async function getLargestImageVariant(imageUrl: string): Promise<Response | null> {
	const baseJpgUrl = imageUrl.replace(/\.\w+$/, '.jpg');

	const potentialUrls = new Set<string>();
	potentialUrls.add(baseJpgUrl);

	const addVariations = (baseUrl: string, marker: string, sizes: string[]) => {
		if (baseUrl.includes(marker)) {
			sizes.forEach((size) => potentialUrls.add(baseUrl.replace(marker, `-${size}.`)));
		}
	};

	const commonSizes = ['t1080x1080', 't500x500'];

	addVariations(baseJpgUrl, '-large.', commonSizes);
	addVariations(baseJpgUrl, '-original.', commonSizes);

	if (!baseJpgUrl.includes('-large.') && !baseJpgUrl.includes('-original.')) {
		const nameWithoutExt = baseJpgUrl.substring(0, baseJpgUrl.lastIndexOf('.'));
		if (nameWithoutExt) {
			commonSizes.forEach((size) => potentialUrls.add(`${nameWithoutExt}-${size}.jpg`));
		}
	}

	return fetchAndSelectLargest([...potentialUrls]);
}

const DEFAULT_AVATAR = 'https://a1.sndcdn.com/images/default_avatar_large.png';

export function nonDefaultAvatarUrl(url: string | null | undefined): string | null {
	return url && url !== DEFAULT_AVATAR ? url : null;
}

export function getTrackBannerUrl(track: SoundcloudTrack): string | null {
	const visuals = track.visuals as unknown;
	if (!visuals) return null;
	if (typeof visuals === 'string') {
		return visuals.startsWith('http') ? visuals : null;
	}
	if (typeof visuals === 'object') {
		const list = (visuals as { visuals?: { visual_url?: string }[] }).visuals;
		const url = list?.[0]?.visual_url;
		return typeof url === 'string' && url.startsWith('http') ? url : null;
	}
	return null;
}

export function resolveTrackCoverUrl(
	track: SoundcloudTrack,
	releaseArtworkUrl: string | null = null,
): string | null {
	return track.artwork_url ?? releaseArtworkUrl ?? nonDefaultAvatarUrl(track.user.avatar_url);
}

export async function saveImage(imageUrl: string, outputPath: string): Promise<boolean> {
	const stagedPath = `${outputPath}.partial`;
	try {
		const response = await getLargestImageVariant(imageUrl);
		if (!response) {
			console.log(`No image obtained for ${outputPath} from ${imageUrl}`);
			return false;
		}

		const bytes = await response.arrayBuffer();
		await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
		await Bun.write(stagedPath, bytes);
		await fs.promises.rename(stagedPath, outputPath);

		return true;
	} catch (error) {
		console.error(`Error saving image to ${outputPath}:`, errorMessage(error));
		await cleanupFile(stagedPath, 'partial image');
		return false;
	}
}
