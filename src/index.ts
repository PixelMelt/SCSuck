import SoundcloudCollector from './collector.ts';
import { HELP_TEXT, parseCommand, type Command } from './cli.ts';
import { errorMessage } from './utils.ts';

async function dispatch(collector: SoundcloudCollector, command: Command): Promise<void> {
	switch (command.name) {
		case 'artist':
			await collector.addArtistToLibrary(command.value);
			console.log(`\nRun with '--run' to discover and download tracks.`);
			break;
		case 'delete':
			await collector.removeArtistFromLibrary(command.value);
			break;
		case 'list':
			await collector.listArtists();
			break;
		case 'following':
			await collector.syncUserFollowing(command.value);
			break;
		case 'refresh':
			await collector.refresh(command.value);
			break;
		case 'backup':
			await collector.backupNow();
			break;
		case 'merge-dirs':
			await collector.mergeDuplicateDirectories();
			break;
		case 'run':
			await collector.run();
			break;
	}
}

async function main(): Promise<void> {
	let collector: SoundcloudCollector | null = null;
	let stopRequested = false;

	const requestStop = (signal: string) => {
		if (stopRequested) {
			console.log(`\nReceived ${signal} again. Exiting immediately.`);
			process.exit(130);
		}
		stopRequested = true;
		console.log(`\nReceived ${signal}. Finishing the current step, then shutting down...`);
		collector?.requestStop();
	};

	process.on('SIGINT', () => requestStop('SIGINT'));
	process.on('SIGTERM', () => requestStop('SIGTERM'));

	try {
		if (process.argv.includes('-h') || process.argv.includes('--help')) {
			console.log(HELP_TEXT);
			return;
		}

		const command = parseCommand(process.argv.slice(2));

		collector = await SoundcloudCollector.create();
		if (!stopRequested) await dispatch(collector, command);
	} catch (error) {
		const message = errorMessage(error);
		console.error('\n--- Error During Execution ---');
		console.error(message);
		if (process.env.SCS_DEBUG === 'true' && error instanceof Error) {
			console.error(error.stack);
		}
		if (collector) {
			await collector.notifyFatal(message);
		}
		process.exitCode = 1;
	} finally {
		if (collector) {
			await collector.shutdown();
		}
		if (stopRequested) process.exitCode = 130;
	}
}

main();
