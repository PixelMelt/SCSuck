import { describe, expect, test } from 'bun:test';
import Soundcloud from 'soundcloud.ts';

describe('soundcloud client contract', () => {
	test('constructor exposes OAuth to entity requests', () => {
		const soundcloud = new Soundcloud('client-id', 'token');
		expect(soundcloud.api.headers.Authorization).toBe('OAuth token');
	});

	test('solver-free fork retains the album listing endpoint', () => {
		const soundcloud = new Soundcloud('client-id', 'token');
		expect(soundcloud.users.albums).toBeFunction();
	});

	test('pure numeric references stay ids', async () => {
		const soundcloud = new Soundcloud('client-id', 'token');
		expect(await soundcloud.resolve.get('123456')).toBe('123456');
	});
});
