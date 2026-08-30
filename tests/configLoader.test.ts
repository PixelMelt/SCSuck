import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/configLoader.ts';

const REQUIRED = {
	SCS_CLIENT_ID: 'cid',
	SCS_OAUTH_TOKEN: 'token',
	SCS_DB_USER: 'user',
	SCS_DB_PASSWORD: 'pass',
	SCS_DB_NAME: 'db',
};

const ALL_KEYS = [
	...Object.keys(REQUIRED),
	'SCS_TEMP_DIR',
	'SCS_LIBRARY_DIR',
	'SCS_BACKUP_DIR',
	'SCS_BACKUP_INTERVAL',
	'SCS_DISCOVERY_INTERVAL',
	'SCS_SYNC_FOLLOWERS',
	'SCS_ADDITIONAL_ARTISTS',
	'SCS_EXCLUDE_ARTISTS',
	'SCS_RATE_LIMIT',
	'SCS_PROXY_HOST',
	'SCS_PROXY_PORT',
	'SCS_PROXY_USERNAME',
	'SCS_PROXY_PASSWORD',
	'SCS_DEBUG',
	'PUSHOVER_APP_TOKEN',
	'PUSHOVER_USER_KEY',
	'SCS_DB_HOST',
	'SCS_DB_PORT',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const key of ALL_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	Object.assign(process.env, REQUIRED);
});

afterEach(() => {
	for (const key of ALL_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

describe('loadConfig', () => {
	test('applies defaults', () => {
		const config = loadConfig();
		expect(config.tempDir).toBe('./temp');
		expect(config.outputDir).toBe('./library');
		expect(config.backupDir).toBe('./backups');
		expect(config.backupIntervalHours).toBe(24);
		expect(config.discoveryIntervalHours).toBe(6);
		expect(config.rateLimitMS).toBe(1000);
		expect(config.debug).toBe(false);
		expect(config.syncFollowers).toEqual([]);
		expect(config.database.host).toBe('localhost');
		expect(config.database.port).toBe(5432);
	});

	test('missing required variables throw with names listed', () => {
		delete process.env.SCS_OAUTH_TOKEN;
		delete process.env.SCS_DB_NAME;
		expect(() => loadConfig()).toThrow(/SCS_OAUTH_TOKEN.*SCS_DB_NAME/);
	});

	test('integer parsing', () => {
		process.env.SCS_RATE_LIMIT = '2500';
		process.env.SCS_BACKUP_INTERVAL = '0';
		const config = loadConfig();
		expect(config.rateLimitMS).toBe(2500);
		expect(config.backupIntervalHours).toBe(0);
	});

	test('boolean parsing', () => {
		process.env.SCS_DEBUG = 'true';
		expect(loadConfig().debug).toBe(true);
		process.env.SCS_DEBUG = 'yes';
		expect(loadConfig().debug).toBe(false);
	});

	test('array parsing with empty entries filtered', () => {
		process.env.SCS_EXCLUDE_ARTISTS = 'foo,bar,,baz';
		expect(loadConfig().excludeArtists).toEqual(['foo', 'bar', 'baz']);
	});

	test('array entries are trimmed so consumers can compare them directly', () => {
		process.env.SCS_EXCLUDE_ARTISTS = 'foo, bar ,\tbaz , ';
		expect(loadConfig().excludeArtists).toEqual(['foo', 'bar', 'baz']);
	});

	test('integers must be whole numbers, not merely start with one', () => {
		process.env.SCS_RATE_LIMIT = '12garbage';
		expect(() => loadConfig()).toThrow(/SCS_RATE_LIMIT/);
		process.env.SCS_RATE_LIMIT = '1.5';
		expect(() => loadConfig()).toThrow(/SCS_RATE_LIMIT/);
		process.env.SCS_RATE_LIMIT = 'abc';
		expect(() => loadConfig()).toThrow(/SCS_RATE_LIMIT/);
	});

	test('empty string treated as unset (default applies)', () => {
		process.env.SCS_TEMP_DIR = '';
		expect(loadConfig().tempDir).toBe('./temp');
	});
});
