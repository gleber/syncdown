const AUTH_URL = "https://android.clients.google.com/auth";
const USER_AGENT = "GoogleAuth/1.4";

export type GpsOAuthFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class GpsOAuthError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "GpsOAuthError";
	}
}

function deriveAndroidId(email: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(email)
		.digest("hex")
		.slice(0, 16);
}

function parseKeyValueBody(body: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const separator = trimmed.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		result.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
	}
	return result;
}

async function postAuth(
	fetchImpl: GpsOAuthFetch,
	fields: Record<string, string>,
): Promise<Map<string, string>> {
	const body = new URLSearchParams(fields);
	const response = await fetchImpl(AUTH_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": USER_AGENT,
		},
		body,
	});
	const text = await response.text();
	const parsed = parseKeyValueBody(text);
	const errorCode = parsed.get("Error");
	if (!response.ok || errorCode) {
		throw new GpsOAuthError(
			errorCode
				? `Google auth failed: ${errorCode}`
				: `Google auth request failed: HTTP ${response.status}`,
			errorCode,
		);
	}
	return parsed;
}

export class GpsOAuthClient {
	constructor(private readonly fetchImpl: GpsOAuthFetch = fetch) {}

	async exchangeAuthToken(email: string, oauthToken: string): Promise<string> {
		const parsed = await postAuth(this.fetchImpl, {
			Token: oauthToken,
			ACCESS_TOKEN: "1",
			add_account: "1",
			service: "ac2dm",
			accountType: "HOSTED_OR_GOOGLE",
			// The consumer-account EmbeddedSetup oauth_token already carries the
			// user's grant, so has_permission=1 lets Google skip DroidGuard device
			// attestation on this endpoint (otherwise it returns
			// `Error=MissingDroidguard`).
			has_permission: "1",
			Email: email,
			androidId: deriveAndroidId(email),
			source: "android",
			device_country: "us",
			operatorCountry: "us",
			lang: "en",
			sdk_version: "17",
		});

		const masterToken = parsed.get("Token");
		if (!masterToken) {
			throw new GpsOAuthError("Google auth response did not include a Token");
		}
		return masterToken;
	}

	async performOAuth(
		email: string,
		masterToken: string,
	): Promise<{ accessToken: string; expiresAtMs: number }> {
		const parsed = await postAuth(this.fetchImpl, {
			EncryptedPasswd: masterToken,
			service:
				"oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders",
			app: "com.google.android.keep",
			client_sig: "38918a453d07199354f8b19af05ec6562ced5788",
			accountType: "HOSTED_OR_GOOGLE",
			Email: email,
			androidId: deriveAndroidId(email),
			source: "android",
			device_country: "us",
			operatorCountry: "us",
			lang: "en",
			sdk_version: "17",
		});

		const accessToken = parsed.get("Auth");
		if (!accessToken) {
			throw new GpsOAuthError("Google auth response did not include Auth");
		}

		const expirySeconds = Number(parsed.get("Expiry") ?? "3600");
		const ttlMs = Number.isFinite(expirySeconds)
			? Math.max(30, expirySeconds) * 1000
			: 3600_000;
		return {
			accessToken,
			expiresAtMs: Date.now() + ttlMs,
		};
	}
}

export function createGpsOAuthClient(
	fetchImpl: GpsOAuthFetch = fetch,
): GpsOAuthClient {
	return new GpsOAuthClient(fetchImpl);
}
