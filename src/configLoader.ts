import 'dotenv/config';
import type { Config } from './types.ts';

type SpecEntry = {
	env: string;
	required?: boolean;
	default?: unknown;
	type?: 'integer' | 'boolean' | 'array';
};

type SpecNode = { [key: string]: SpecEntry | SpecNode };

type ConfigSpec<T> = {
	[K in keyof T]: [NonNullable<T[K]>] extends [string[]]
		? SpecEntry
		: NonNullable<T[K]> extends object
			? ConfigSpec<NonNullable<T[K]>>
			: SpecEntry;
};

function isSpecEntry(node: SpecEntry | SpecNode): node is SpecEntry {
	return Object.hasOwn(node, 'env');
}

export function loadConfig(): Config {
	const configSpec = {
		clientId: { env: 'SCS_CLIENT_ID', required: true },
		oauthToken: { env: 'SCS_OAUTH_TOKEN', required: true },
		tempDir: { env: 'SCS_TEMP_DIR', default: './temp' },
		outputDir: { env: 'SCS_LIBRARY_DIR', default: './library' },
		backupDir: { env: 'SCS_BACKUP_DIR', default: './backups' },
		backupIntervalHours: { env: 'SCS_BACKUP_INTERVAL', type: 'integer', default: 24 },
		discoveryIntervalHours: { env: 'SCS_DISCOVERY_INTERVAL', type: 'integer', default: 6 },

		syncFollowers: { env: 'SCS_SYNC_FOLLOWERS', type: 'array', default: [] },
		additionalArtists: { env: 'SCS_ADDITIONAL_ARTISTS', type: 'array', default: [] },
		excludeArtists: { env: 'SCS_EXCLUDE_ARTISTS', type: 'array', default: [] },

		rateLimitMS: { env: 'SCS_RATE_LIMIT', type: 'integer', default: 1000 },

		proxyHost: { env: 'SCS_PROXY_HOST', default: null },
		proxyPort: { env: 'SCS_PROXY_PORT', type: 'integer', default: null },
		proxyUsername: { env: 'SCS_PROXY_USERNAME', default: null },
		proxyPassword: { env: 'SCS_PROXY_PASSWORD', default: null },

		debug: { env: 'SCS_DEBUG', type: 'boolean', default: false },
		datadomeStub: { env: 'SCS_DATADOME_STUB', type: 'boolean', default: false },

		pushover: {
			appToken: { env: 'PUSHOVER_APP_TOKEN', default: null },
			userKey: { env: 'PUSHOVER_USER_KEY', default: null },
		},

		database: {
			host: { env: 'SCS_DB_HOST', default: 'localhost' },
			port: { env: 'SCS_DB_PORT', type: 'integer', default: 5432 },
			user: { env: 'SCS_DB_USER', required: true },
			password: { env: 'SCS_DB_PASSWORD', required: true },
			database: { env: 'SCS_DB_NAME', required: true },
		},
	} satisfies ConfigSpec<Config>;

	const missingVariables: string[] = [];

	function processSpec(spec: SpecNode): Record<string, unknown> {
		const configSection: Record<string, unknown> = {};

		for (const key in spec) {
			const subSpec = spec[key]!;

			if (isSpecEntry(subSpec)) {
				const value = process.env[subSpec.env];
				let finalValue: unknown;

				if (value !== undefined && value !== '') {
					switch (subSpec.type) {
						case 'integer': {
							const parsed = Number(value);
							if (!Number.isSafeInteger(parsed)) {
								throw new Error(`Invalid integer for ${subSpec.env}: "${value}"`);
							}
							finalValue = parsed;
							break;
						}
						case 'boolean':
							finalValue = value === 'true';
							break;
						case 'array':
							finalValue = value
								.split(',')
								.map((entry) => entry.trim())
								.filter(Boolean);
							break;
						default:
							finalValue = value;
					}
				} else if (subSpec.default !== undefined) {
					finalValue = subSpec.default;
				} else if (subSpec.required) {
					missingVariables.push(subSpec.env);
				}

				if (finalValue !== undefined) {
					configSection[key] = finalValue;
				}
			} else {
				configSection[key] = processSpec(subSpec);
			}
		}
		return configSection;
	}

	const finalConfig = processSpec(configSpec);

	if (missingVariables.length > 0) {
		throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
	}

	return finalConfig as unknown as Config;
}
