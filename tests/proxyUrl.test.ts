import { describe, expect, test } from 'bun:test';
import { buildProxyUrl } from '../src/collector.ts';
import type { Config } from '../src/types.ts';

function proxyConfig(overrides: Partial<Config>): Config {
	return {
		proxyHost: null,
		proxyPort: null,
		proxyUsername: null,
		proxyPassword: null,
		...overrides,
	} as Config;
}

describe('buildProxyUrl', () => {
	test('no proxy configured', () => {
		expect(buildProxyUrl(proxyConfig({}))).toBeNull();
	});

	test('bare host', () => {
		expect(buildProxyUrl(proxyConfig({ proxyHost: 'proxy.example' }))).toBe(
			'http://proxy.example/',
		);
	});

	test('host and port', () => {
		expect(buildProxyUrl(proxyConfig({ proxyHost: 'proxy.example', proxyPort: 8080 }))).toBe(
			'http://proxy.example:8080/',
		);
	});

	test('credentials with reserved characters are encoded', () => {
		const url = buildProxyUrl(
			proxyConfig({
				proxyHost: 'proxy.example',
				proxyPort: 8080,
				proxyUsername: 'user@corp',
				proxyPassword: 'p a:ss/word',
			}),
		);
		expect(url).toContain('%40');
		expect(new URL(url!).username).toBe('user%40corp');
		expect(new URL(url!).hostname).toBe('proxy.example');
		expect(new URL(url!).port).toBe('8080');
	});

	test('a full URL in the host is passed through', () => {
		expect(buildProxyUrl(proxyConfig({ proxyHost: 'socks5://proxy.example:1080' }))).toBe(
			'socks5://proxy.example:1080',
		);
	});

	test('a full URL plus components is rejected rather than half-applied', () => {
		expect(() =>
			buildProxyUrl(proxyConfig({ proxyHost: 'http://proxy.example', proxyPort: 8080 })),
		).toThrow(/full URL/);
	});

	test('one credential without its pair is rejected', () => {
		expect(() =>
			buildProxyUrl(proxyConfig({ proxyHost: 'proxy.example', proxyUsername: 'user' })),
		).toThrow(/USERNAME and SCS_PROXY_PASSWORD/);
	});

	test('components without a host are rejected', () => {
		expect(() => buildProxyUrl(proxyConfig({ proxyPort: 8080 }))).toThrow(
			/without SCS_PROXY_HOST/,
		);
	});
});
