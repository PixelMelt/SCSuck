import { errorMessage } from './utils.ts';
import type { PushoverConfig } from './types.ts';

class Notifier {
	private appToken: string | null;
	private userKey: string | null;

	constructor(pushover: PushoverConfig) {
		if (Boolean(pushover.appToken) !== Boolean(pushover.userKey)) {
			throw new Error(
				'Pushover needs both PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY, or neither',
			);
		}
		this.appToken = pushover.appToken;
		this.userKey = pushover.userKey;
	}

	async push(title: string, message: string): Promise<void> {
		if (!this.appToken || !this.userKey) return;

		try {
			const response = await fetch('https://api.pushover.net/1/messages.json', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					token: this.appToken,
					user: this.userKey,
					title,
					message,
				}),
				signal: AbortSignal.timeout(15000),
			});

			const data = (await response.json()) as { status?: number; errors?: string[] };
			if (data.status === 1) {
				console.log('Pushover notification sent successfully');
			} else {
				console.error('Pushover API error:', data);
			}
		} catch (error) {
			console.error('Failed to send Pushover notification:', errorMessage(error));
		}
	}
}

export default Notifier;
