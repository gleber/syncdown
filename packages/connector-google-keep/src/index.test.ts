import { expect, test } from "bun:test";

import type {
	ConnectorSyncRequest,
	GenericTokenResolvedAuth,
	SourceRecord,
	SourceSnapshot,
	StoredSourceSnapshot,
} from "@syncdown/core";
import { MemoryStateStore } from "../../core/src/test-support.js";

import { GpsOAuthClient, type GpsOAuthError } from "./gpsoauth.js";
import {
	createGoogleKeepConnector,
	decodeGoogleKeepCursor,
	encodeGoogleKeepCursor,
	type StoredGoogleKeepCursor,
} from "./index.js";
import {
	type GoogleKeepAdapter,
	GoogleKeepApiError,
	type KeepChangesResponse,
	type KeepNode,
} from "./keep-api.js";

function createRequest(
	options: {
		since?: string | null;
		token?: string;
		accountEmail?: string;
		existingSourceIds?: string[];
	} = {},
	overrides: Partial<ConnectorSyncRequest> = {},
): ConnectorSyncRequest & {
	persisted: SourceSnapshot[];
	deleted: string[];
	secretsSet: Array<{ name: string; value: string }>;
} {
	const state = new MemoryStateStore();
	for (const sourceId of options.existingSourceIds ?? []) {
		void state.upsertSourceRecord({
			integrationId: "google-keep-integration",
			connectorId: "google-keep",
			sourceId,
			entityType: "keep-note",
			relativePath: `google-keep/notes/${sourceId}.md`,
			sourceHash: `hash-${sourceId}`,
			renderVersion: "test",
			snapshotHash: `snapshot-${sourceId}`,
			lastRenderedAt: "2026-07-20T00:00:00.000Z",
		} satisfies SourceRecord);
		void state.upsertSourceSnapshot({
			integrationId: "google-keep-integration",
			connectorId: "google-keep",
			sourceId,
			snapshotHash: `snapshot-${sourceId}`,
			snapshotSchemaVersion: "1",
			payload: {
				integrationId: "google-keep-integration",
				connectorId: "google-keep",
				sourceId,
				entityType: "keep-note",
				title: sourceId,
				slug: sourceId,
				pathHint: { kind: "keep-note" },
				metadata: { keepNoteId: sourceId },
				bodyMd: "",
				sourceHash: `hash-${sourceId}`,
				snapshotSchemaVersion: "1",
			},
		} satisfies StoredSourceSnapshot);
	}

	const persisted: SourceSnapshot[] = [];
	const deleted: string[] = [];
	const secretsSet: Array<{ name: string; value: string }> = [];
	const token = options.token ?? "aas_et/master-token";

	const request = {
		config: {
			oauthApps: [],
			connections: [],
			integrations: [
				{
					id: "google-keep-integration",
					connectorId: "google-keep" as const,
					connectionId: "google-keep-token-default",
					label: "Google Keep",
					enabled: true,
					interval: "1h" as const,
					config: {},
				},
			],
		},
		integration: {
			id: "google-keep-integration",
			connectorId: "google-keep" as const,
			connectionId: "google-keep-token-default",
			label: "Google Keep",
			enabled: true,
			interval: "1h" as const,
			config: {},
		},
		connection: {
			id: "google-keep-token-default",
			kind: "google-keep-token" as const,
			label: "Default Google Keep Connection",
			accountEmail: options.accountEmail ?? "user@example.com",
		},
		io: {
			write() {},
			error() {},
		},
		paths: {
			configDir: "/tmp/config",
			dataDir: "/tmp/data",
			configPath: "/tmp/config/config.json",
			statePath: "/tmp/data/state.db",
			secretsPath: "/tmp/data/secrets.enc",
			masterKeyPath: "/tmp/data/master.key",
			lockPath: "/tmp/data/sync.lock",
		},
		since: options.since ?? null,
		renderVersion: "test",
		secrets: {
			async hasSecret() {
				return true;
			},
			async getSecret() {
				return token;
			},
			async setSecret(name: string, value: string) {
				secretsSet.push({ name, value });
			},
			async deleteSecret() {},
			describe() {
				return "memory";
			},
		},
		state,
		resolvedAuth: {
			kind: "token",
			token,
			connectionKind: "google-keep-token",
		} satisfies GenericTokenResolvedAuth,
		throwIfCancelled() {},
		async persistSource(source: SourceSnapshot) {
			persisted.push(source);
		},
		async deleteSource(sourceId: string) {
			deleted.push(sourceId);
		},
		async resetIntegrationState() {},
		setProgress() {},
		...overrides,
		persisted,
		deleted,
		secretsSet,
	};

	return request;
}

function noteNode(id: string, overrides: Partial<KeepNode> = {}): KeepNode {
	return {
		id,
		parentId: "root",
		type: "NOTE",
		title: "Shopping",
		timestamps: {
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-02T00:00:00.000Z",
			trashed: "1970-01-01T00:00:00.000Z",
			deleted: "1970-01-01T00:00:00.000Z",
		},
		labelIds: [{ labelId: "label-1" }],
		color: "DEFAULT",
		isArchived: false,
		isPinned: true,
		...overrides,
	};
}

function listNode(id: string, overrides: Partial<KeepNode> = {}): KeepNode {
	return {
		id,
		parentId: "root",
		type: "LIST",
		title: "Todos",
		timestamps: {
			created: "2026-01-01T00:00:00.000Z",
			updated: "2026-01-02T00:00:00.000Z",
			trashed: "1970-01-01T00:00:00.000Z",
			deleted: "1970-01-01T00:00:00.000Z",
		},
		...overrides,
	};
}

function itemNode(
	id: string,
	parentId: string,
	overrides: Partial<KeepNode> = {},
): KeepNode {
	return {
		id,
		parentId,
		type: "LIST_ITEM",
		text: "milk",
		checked: false,
		sortValue: "2000",
		...overrides,
	};
}

test("full sync renders NOTE and LIST snapshots and stores cursor cache", async () => {
	const adapter: GoogleKeepAdapter = {
		async fetchChanges(_credentials, targetVersion) {
			expect(targetVersion).toBeNull();
			return {
				toVersion: "v1",
				truncated: false,
				forceFullResync: false,
				labels: [{ id: "label-1", name: "Work" }],
				nodes: [
					noteNode("note-1"),
					itemNode("item-note", "note-1", { text: "Buy milk" }),
					listNode("list-1"),
					itemNode("item-1", "list-1", {
						text: "unchecked high",
						checked: false,
						sortValue: "3000",
					}),
					itemNode("item-2", "list-1", {
						text: "checked",
						checked: true,
						sortValue: "4000",
					}),
					itemNode("item-3", "list-1", {
						text: "unchecked low",
						checked: false,
						sortValue: "1000",
					}),
					itemNode("item-child", "list-1", {
						text: "nested",
						checked: false,
						sortValue: "2500",
						superListItemId: "item-1",
					}),
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest();
	const result = await connector.sync(request);

	expect(request.persisted).toHaveLength(2);
	const note = request.persisted.find((entry) => entry.sourceId === "note-1");
	const list = request.persisted.find((entry) => entry.sourceId === "list-1");
	expect(note?.bodyMd).toBe("Buy milk");
	expect(note?.metadata.keepLabels).toEqual(["Work"]);
	expect(note?.metadata.keepPinned).toBe(true);
	expect(note?.pathHint).toEqual({ kind: "keep-note" });
	expect(list?.bodyMd).toBe(
		[
			"- [ ] unchecked high",
			"  - [ ] nested",
			"- [ ] unchecked low",
			"- [x] checked",
		].join("\n"),
	);

	const cursor = decodeGoogleKeepCursor(result.nextCursor);
	expect(cursor?.keepVersion).toBe("v1");
	expect(cursor?.labels["label-1"]).toBe("Work");
	expect(Object.keys(cursor?.nodes ?? {}).sort()).toEqual([
		"item-1",
		"item-2",
		"item-3",
		"item-child",
		"item-note",
		"list-1",
		"note-1",
	]);
});

test("truncated paging merges into one cache", async () => {
	const calls: Array<string | null> = [];
	const adapter: GoogleKeepAdapter = {
		async fetchChanges(_credentials, targetVersion) {
			calls.push(targetVersion);
			if (targetVersion === null) {
				return {
					toVersion: "page-1",
					truncated: true,
					forceFullResync: false,
					labels: [],
					nodes: [
						noteNode("note-1"),
						itemNode("item-1", "note-1", { text: "a" }),
					],
				};
			}
			return {
				toVersion: "page-2",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [
					noteNode("note-2", { title: "Second" }),
					itemNode("item-2", "note-2", { text: "b" }),
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest();
	const result = await connector.sync(request);

	expect(calls).toEqual([null, "page-1"]);
	expect(request.persisted.map((entry) => entry.sourceId).sort()).toEqual([
		"note-1",
		"note-2",
	]);
	expect(decodeGoogleKeepCursor(result.nextCursor)?.keepVersion).toBe("page-2");
});

test("incremental list-item edit re-renders the full list from cache", async () => {
	const initialCursor: StoredGoogleKeepCursor = {
		version: 1,
		keepVersion: "v1",
		labels: {},
		nodes: {
			"list-1": {
				id: "list-1",
				parentId: "root",
				type: "LIST",
				title: "Todos",
			},
			"item-1": {
				id: "item-1",
				parentId: "list-1",
				type: "LIST_ITEM",
				text: "one",
				checked: false,
				sortValue: "2000",
			},
			"item-2": {
				id: "item-2",
				parentId: "list-1",
				type: "LIST_ITEM",
				text: "two",
				checked: false,
				sortValue: "1000",
			},
		},
	};

	const adapter: GoogleKeepAdapter = {
		async fetchChanges(_credentials, targetVersion) {
			expect(targetVersion).toBe("v1");
			return {
				toVersion: "v2",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [
					itemNode("item-1", "list-1", {
						text: "one edited",
						checked: false,
						sortValue: "2000",
					}),
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({
		since: encodeGoogleKeepCursor(initialCursor),
	});
	await connector.sync(request);

	expect(request.persisted).toHaveLength(1);
	expect(request.persisted[0]?.sourceId).toBe("list-1");
	expect(request.persisted[0]?.bodyMd).toBe("- [ ] one edited\n- [ ] two");
});

test("trash and permanent delete call deleteSource and drop cache entries", async () => {
	const initialCursor: StoredGoogleKeepCursor = {
		version: 1,
		keepVersion: "v1",
		labels: {},
		nodes: {
			"note-1": {
				id: "note-1",
				parentId: "root",
				type: "NOTE",
				title: "Keep",
			},
			"note-2": {
				id: "note-2",
				parentId: "root",
				type: "NOTE",
				title: "Delete me",
			},
			"item-2": {
				id: "item-2",
				parentId: "note-2",
				type: "LIST_ITEM",
				text: "body",
			},
		},
	};

	const adapter: GoogleKeepAdapter = {
		async fetchChanges() {
			return {
				toVersion: "v2",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [
					noteNode("note-1", {
						timestamps: {
							created: "2026-01-01T00:00:00.000Z",
							updated: "2026-01-02T00:00:00.000Z",
							trashed: "2026-01-03T00:00:00.000Z",
							deleted: "1970-01-01T00:00:00.000Z",
						},
					}),
					{
						id: "note-2",
						timestamps: {
							deleted: "2026-01-04T00:00:00.000Z",
						},
					},
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({
		since: encodeGoogleKeepCursor(initialCursor),
	});
	const result = await connector.sync(request);

	expect(request.deleted.sort()).toEqual(["note-1", "note-2"]);
	expect(request.persisted).toHaveLength(0);
	const cursor = decodeGoogleKeepCursor(result.nextCursor);
	expect(cursor?.nodes["note-1"]?.trashed).toBe(true);
	expect(cursor?.nodes["note-2"]).toBeUndefined();
});

test("stale version forces full resync and purges missing sources", async () => {
	let calls = 0;
	const adapter: GoogleKeepAdapter = {
		async fetchChanges(_credentials, targetVersion) {
			calls += 1;
			if (calls === 1) {
				expect(targetVersion).toBe("stale");
				throw new GoogleKeepApiError(400, "bad version");
			}
			expect(targetVersion).toBeNull();
			return {
				toVersion: "fresh",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [
					noteNode("note-live"),
					itemNode("item-live", "note-live", { text: "alive" }),
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({
		since: encodeGoogleKeepCursor({
			version: 1,
			keepVersion: "stale",
			nodes: {
				"note-old": {
					id: "note-old",
					parentId: "root",
					type: "NOTE",
					title: "Old",
				},
			},
			labels: {},
		}),
		existingSourceIds: ["note-old", "note-live"],
	});
	const result = await connector.sync(request);

	expect(calls).toBe(2);
	expect(request.persisted.map((entry) => entry.sourceId)).toEqual([
		"note-live",
	]);
	expect(request.deleted).toContain("note-old");
	expect(decodeGoogleKeepCursor(result.nextCursor)?.keepVersion).toBe("fresh");
});

test("forceFullResync restarts as a full sync", async () => {
	let calls = 0;
	const adapter: GoogleKeepAdapter = {
		async fetchChanges(_credentials, targetVersion) {
			calls += 1;
			if (calls === 1) {
				return {
					toVersion: null,
					truncated: false,
					forceFullResync: true,
					labels: [],
					nodes: [],
				} satisfies KeepChangesResponse;
			}
			expect(targetVersion).toBeNull();
			return {
				toVersion: "v-new",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [
					noteNode("note-1"),
					itemNode("item-1", "note-1", { text: "hi" }),
				],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({
		since: encodeGoogleKeepCursor({
			version: 1,
			keepVersion: "old",
			nodes: {},
			labels: {},
		}),
	});
	const result = await connector.sync(request);
	expect(calls).toBe(2);
	expect(request.persisted).toHaveLength(1);
	expect(decodeGoogleKeepCursor(result.nextCursor)?.keepVersion).toBe("v-new");
});

test("cursor codec round-trips and rejects invalid payloads", () => {
	const cursor: StoredGoogleKeepCursor = {
		version: 1,
		keepVersion: "abc",
		nodes: {
			n1: {
				id: "n1",
				parentId: "root",
				type: "NOTE",
				title: "Hi",
			},
		},
		labels: { l1: "Label" },
	};
	const encoded = encodeGoogleKeepCursor(cursor);
	expect(decodeGoogleKeepCursor(encoded)).toEqual(cursor);
	expect(decodeGoogleKeepCursor(null)).toBeNull();
	expect(decodeGoogleKeepCursor("{")).toBeNull();
	expect(decodeGoogleKeepCursor(JSON.stringify({ version: 2 }))).toBeNull();
	expect(
		decodeGoogleKeepCursor(
			JSON.stringify({ version: 1, keepVersion: "", nodes: {}, labels: {} }),
		),
	).toBeNull();
});

test("oauth2_4 token is exchanged once and stored as master token", async () => {
	let exchanged = 0;
	const adapter: GoogleKeepAdapter = {
		async exchangeAuthToken(email, oauthToken) {
			exchanged += 1;
			expect(email).toBe("user@example.com");
			expect(oauthToken).toBe("oauth2_4/cookie");
			return "aas_et/exchanged";
		},
		async fetchChanges(credentials) {
			expect(credentials.masterToken).toBe("aas_et/exchanged");
			return {
				toVersion: "v1",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({ token: "oauth2_4/cookie" });
	await connector.sync(request);

	expect(exchanged).toBe(1);
	expect(request.secretsSet).toEqual([
		{ name: "google-keep-token-default", value: "aas_et/exchanged" },
	]);
});

test("gpsoauth parses key=value bodies and surfaces Error lines", async () => {
	const client = new GpsOAuthClient(async () => {
		return new Response("Error=BadAuthentication\n", { status: 200 });
	});

	await expect(
		client.exchangeAuthToken("user@example.com", "oauth2_4/x"),
	).rejects.toMatchObject({
		name: "GpsOAuthError",
		code: "BadAuthentication",
		message: "Google auth failed: BadAuthentication",
	} satisfies Partial<GpsOAuthError>);

	const okClient = new GpsOAuthClient(async () => {
		return new Response("Token=aas_et/master\nEmail=user@example.com\n", {
			status: 200,
		});
	});
	await expect(
		okClient.exchangeAuthToken("user@example.com", "oauth2_4/x"),
	).resolves.toBe("aas_et/master");

	// has_permission=1 keeps Google from demanding DroidGuard device
	// attestation (Error=MissingDroidguard) on the ac2dm exchange.
	let capturedBody = "";
	const capturingClient = new GpsOAuthClient(async (_input, init) => {
		capturedBody = String(init?.body ?? "");
		return new Response("Token=aas_et/master\n", { status: 200 });
	});
	await capturingClient.exchangeAuthToken("user@example.com", "oauth2_4/x");
	const fields = new URLSearchParams(capturedBody);
	expect(fields.get("has_permission")).toBe("1");
	expect(fields.get("service")).toBe("ac2dm");

	const authClient = new GpsOAuthClient(async () => {
		return new Response("Auth=access-token\nExpiry=3600\n", { status: 200 });
	});
	const token = await authClient.performOAuth(
		"user@example.com",
		"aas_et/master",
	);
	expect(token.accessToken).toBe("access-token");
	expect(token.expiresAtMs).toBeGreaterThan(Date.now());
});

test("parentId-less deletion nodes are treated as permanent deletes", async () => {
	const adapter: GoogleKeepAdapter = {
		async fetchChanges() {
			return {
				toVersion: "v2",
				truncated: false,
				forceFullResync: false,
				labels: [],
				nodes: [{ id: "note-gone" }],
			};
		},
	};

	const connector = createGoogleKeepConnector({ adapter });
	const request = createRequest({
		since: encodeGoogleKeepCursor({
			version: 1,
			keepVersion: "v1",
			labels: {},
			nodes: {
				"note-gone": {
					id: "note-gone",
					parentId: "root",
					type: "NOTE",
					title: "Gone",
				},
			},
		}),
	});
	const result = await connector.sync(request);
	expect(request.deleted).toEqual(["note-gone"]);
	expect(
		decodeGoogleKeepCursor(result.nextCursor)?.nodes["note-gone"],
	).toBeUndefined();
});
