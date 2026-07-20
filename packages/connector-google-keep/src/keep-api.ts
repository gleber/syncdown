import {
	createGpsOAuthClient,
	type GpsOAuthClient,
	type GpsOAuthFetch,
} from "./gpsoauth.js";

const CHANGES_URL = "https://www.googleapis.com/notes/v1/changes";

export type KeepNodeType = "NOTE" | "LIST" | "LIST_ITEM" | "BLOB";

export interface KeepNodeTimestamps {
	created?: string | null;
	updated?: string | null;
	trashed?: string | null;
	deleted?: string | null;
}

export interface KeepNode {
	id?: string | null;
	serverId?: string | null;
	parentId?: string | null;
	type?: KeepNodeType | string | null;
	title?: string | null;
	text?: string | null;
	checked?: boolean | null;
	sortValue?: string | number | null;
	superListItemId?: string | null;
	color?: string | null;
	isArchived?: boolean | null;
	isPinned?: boolean | null;
	timestamps?: KeepNodeTimestamps | null;
	labelIds?: Array<{ labelId?: string | null } | string> | null;
}

export interface KeepLabelInfo {
	mainId?: string | null;
	name?: string | null;
}

export interface KeepChangesResponse {
	toVersion: string | null;
	truncated: boolean;
	forceFullResync: boolean;
	nodes: KeepNode[];
	labels: Array<{ id: string; name: string }>;
}

export interface GoogleKeepCredentials {
	email: string;
	masterToken: string;
}

export interface GoogleKeepAdapter {
	fetchChanges(
		credentials: GoogleKeepCredentials,
		targetVersion: string | null,
	): Promise<KeepChangesResponse>;
	exchangeAuthToken?(email: string, oauthToken: string): Promise<string>;
}

export class GoogleKeepApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GoogleKeepApiError";
	}
}

function randomSessionId(): string {
	return `s--${Date.now()}--${Math.random().toString(36).slice(2, 10)}`;
}

function buildRequestBody(
	targetVersion: string | null,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		nodes: [],
		clientTimestamp: new Date().toISOString(),
		requestHeader: {
			clientSessionId: randomSessionId(),
			clientPlatform: "ANDROID",
			clientVersion: {
				major: "9",
				minor: "9",
				build: "9",
				revision: "9",
			},
			capabilities: [
				{ type: "NC" },
				{ type: "PI" },
				{ type: "LB" },
				{ type: "AN" },
				{ type: "SH" },
				{ type: "DR" },
				{ type: "TR" },
				{ type: "IN" },
				{ type: "SNB" },
				{ type: "MI" },
				{ type: "CO" },
			],
		},
	};
	if (targetVersion) {
		body.targetVersion = targetVersion;
	}
	return body;
}

function parseLabels(
	payload: {
		userInfo?: { labels?: KeepLabelInfo[] | null } | null;
	} | null,
): Array<{ id: string; name: string }> {
	const labels: Array<{ id: string; name: string }> = [];
	for (const label of payload?.userInfo?.labels ?? []) {
		const id = label.mainId?.trim();
		const name = label.name?.trim();
		if (!id || !name) {
			continue;
		}
		labels.push({ id, name });
	}
	return labels;
}

class HttpGoogleKeepAdapter implements GoogleKeepAdapter {
	private readonly accessTokenCache = new Map<
		string,
		{ accessToken: string; expiresAtMs: number }
	>();

	constructor(
		private readonly oauthClient: GpsOAuthClient,
		private readonly fetchImpl: GpsOAuthFetch = fetch,
	) {}

	async exchangeAuthToken(email: string, oauthToken: string): Promise<string> {
		return this.oauthClient.exchangeAuthToken(email, oauthToken);
	}

	private async getAccessToken(
		credentials: GoogleKeepCredentials,
	): Promise<string> {
		const cached = this.accessTokenCache.get(credentials.masterToken);
		if (cached && cached.expiresAtMs > Date.now() + 30_000) {
			return cached.accessToken;
		}

		const token = await this.oauthClient.performOAuth(
			credentials.email,
			credentials.masterToken,
		);
		this.accessTokenCache.set(credentials.masterToken, token);
		return token.accessToken;
	}

	async fetchChanges(
		credentials: GoogleKeepCredentials,
		targetVersion: string | null,
	): Promise<KeepChangesResponse> {
		const accessToken = await this.getAccessToken(credentials);
		const response = await this.fetchImpl(CHANGES_URL, {
			method: "POST",
			headers: {
				authorization: `OAuth ${accessToken}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(buildRequestBody(targetVersion)),
		});

		const text = await response.text();
		type KeepChangesPayload = {
			toVersion?: string | null;
			truncated?: boolean | null;
			forceFullResync?: boolean | null;
			nodes?: KeepNode[] | null;
			userInfo?: { labels?: KeepLabelInfo[] | null } | null;
			error?: { message?: string };
		};
		let payload: KeepChangesPayload | null = null;

		if (text) {
			try {
				payload = JSON.parse(text) as KeepChangesPayload;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new GoogleKeepApiError(
					response.status,
					`Google Keep API response was not valid JSON: ${reason}`,
				);
			}
		}

		if (!response.ok) {
			throw new GoogleKeepApiError(
				response.status,
				payload?.error?.message ??
					`Google Keep API request failed: HTTP ${response.status}`,
			);
		}

		return {
			toVersion: payload?.toVersion ?? null,
			truncated: Boolean(payload?.truncated),
			forceFullResync: Boolean(payload?.forceFullResync),
			nodes: payload?.nodes ?? [],
			labels: parseLabels(payload),
		};
	}
}

export function createGoogleKeepAdapter(
	options: { fetchImpl?: GpsOAuthFetch; oauthClient?: GpsOAuthClient } = {},
): GoogleKeepAdapter {
	const fetchImpl = options.fetchImpl ?? fetch;
	const oauthClient = options.oauthClient ?? createGpsOAuthClient(fetchImpl);
	return new HttpGoogleKeepAdapter(oauthClient, fetchImpl);
}
