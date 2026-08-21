import pg from 'pg';
import { extractCoArtists } from '../src/titleParser.ts';

const SAMPLE_SIZE = parseInt(process.argv[2] ?? '2000', 10);
const TABLE_FILTER = process.argv[3] ?? '';

const pool = new pg.Pool({
	host: process.env.EVAL_DB_HOST ?? 'localhost',
	port: parseInt(process.env.EVAL_DB_PORT ?? '5432', 10),
	user: process.env.EVAL_DB_USER ?? 'scraper',
	password: process.env.EVAL_DB_PASSWORD ?? 'testpassword123',
	database: process.env.EVAL_DB_NAME ?? 'soundcloud',
});

interface SampleRow {
	title: string;
	description: string | null;
	publisher_artist: string | null;
	username: string | null;
}

async function main() {
	const { rows: tables } = await pool.query<{ table_name: string }>(
		`SELECT c.relname AS table_name FROM pg_class c
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind = 'r'
		   AND c.relname LIKE 'tracks_%' AND c.relname LIKE $1
		   AND pg_relation_size(c.oid) > 10 * 1024 * 1024
		 ORDER BY c.relname DESC`,
		[`%${TABLE_FILTER}%`],
	);
	if (tables.length === 0) {
		console.error('No tracks_* tables matched.');
		process.exit(1);
	}

	const tablesToSample = tables.slice(0, 12);
	const perTable = Math.ceil(SAMPLE_SIZE / tablesToSample.length);
	const samples: SampleRow[] = [];

	for (const { table_name } of tablesToSample) {
		const { rows } = await pool.query<SampleRow>(
			`SELECT t.title, t.description,
			        t.publisher_metadata->>'artist' AS publisher_artist,
			        NULL AS username
			 FROM ${table_name} t TABLESAMPLE SYSTEM (1)
			 LIMIT ${perTable}`,
		);
		samples.push(...rows);
	}

	console.log(`Sampled ${samples.length} tracks from ${tablesToSample.length} tables\n`);

	let withExtractions = 0;
	const allNames = new Map<string, number>();

	for (const row of samples) {
		const coArtists = extractCoArtists({
			title: row.title,
			description: row.description,
			publisherArtist: row.publisher_artist,
			mainArtist: row.username ?? '\u0000none\u0000',
		});

		if (coArtists.length > 0) {
			withExtractions++;
			console.log(`${row.title}\n    -> [${coArtists.join(' | ')}]`);
			for (const name of coArtists) {
				allNames.set(name, (allNames.get(name) ?? 0) + 1);
			}
		}
	}

	console.log(`\n=== Summary ===`);
	console.log(`Tracks sampled:        ${samples.length}`);
	console.log(
		`With co-artists:       ${withExtractions} (${((withExtractions / samples.length) * 100).toFixed(1)}%)`,
	);
	console.log(`Distinct names:        ${allNames.size}`);

	const suspicious = [...allNames.entries()].filter(([n]) =>
		/remix|edit|download|free|out now|link|click|www|http|\d{4}/i.test(n),
	);
	if (suspicious.length > 0) {
		console.log(`\nSuspicious extractions (review stop-list):`);
		for (const [name, count] of suspicious) console.log(`  ${count}x  ${name}`);
	}

	await pool.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
