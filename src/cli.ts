export const HELP_TEXT = `Soundcloud Collector - Music Library Manager

Usage:
  bun src/index.ts [options]

Artist Management:
  -a, --artist <url/id>        Add artist to monitored list
  -d, --delete <url/id>        Remove artist from monitored list
  -l, --list                   List all monitored artists

Discovery & Download:
  -r, --refresh [artist]       Check monitored artists for new tracks and download (optionally specify one artist)
  -f, --following <user>       Add all artists a user follows to the monitored list
  --run                        Full cycle: backup if due, add config artists, sync followers, refresh all

Maintenance:
  --backup                     Back up the database now
  --retry-encrypted            Retry tracks previously skipped for encryption
  --merge-dirs                 Merge duplicate artist directories
  -h, --help                   Display this help information`;

export type Command =
	| { name: 'artist' | 'delete' | 'following'; value: string }
	| { name: 'refresh'; value: string | null }
	| { name: 'list' | 'backup' | 'merge-dirs' | 'run' | 'retry-encrypted' };

type Arity = 'required' | 'optional' | 'none';

const COMMANDS: Record<string, { name: Command['name']; arity: Arity }> = {
	'-a': { name: 'artist', arity: 'required' },
	'--artist': { name: 'artist', arity: 'required' },
	'-d': { name: 'delete', arity: 'required' },
	'--delete': { name: 'delete', arity: 'required' },
	'-l': { name: 'list', arity: 'none' },
	'--list': { name: 'list', arity: 'none' },
	'-f': { name: 'following', arity: 'required' },
	'--following': { name: 'following', arity: 'required' },
	'-r': { name: 'refresh', arity: 'optional' },
	'--refresh': { name: 'refresh', arity: 'optional' },
	'--backup': { name: 'backup', arity: 'none' },
	'--retry-encrypted': { name: 'retry-encrypted', arity: 'none' },
	'--merge-dirs': { name: 'merge-dirs', arity: 'none' },
	'--run': { name: 'run', arity: 'none' },
};

export function parseCommand(args: string[]): Command {
	if (args.length === 0) {
		console.log('No command provided. Running default cycle (--run).');
		return { name: 'run' };
	}

	const flag = args[0]!;
	const spec = COMMANDS[flag];
	if (!spec) {
		console.log(HELP_TEXT);
		throw new Error(`Unknown command: ${flag}`);
	}

	const values = args.slice(1);
	const allowed = spec.arity === 'none' ? 0 : 1;
	if (values.length > allowed) {
		throw new Error(`Unexpected argument(s) after ${flag}: ${values.slice(allowed).join(' ')}`);
	}
	if (spec.arity === 'required' && !values[0]) {
		throw new Error(`${flag} requires an artist URL/ID`);
	}

	if (spec.name === 'refresh') return { name: 'refresh', value: values[0] ?? null };
	if (spec.arity === 'none') return { name: spec.name } as Command;
	return { name: spec.name, value: values[0]! } as Command;
}
