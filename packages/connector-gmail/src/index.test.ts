import { expect, test } from "bun:test";

import type {
	AppIo,
	AppPaths,
	ConnectorSyncRequest,
	GoogleResolvedAuth,
	IntegrationRuntimeProgress,
	SecretsStore,
	SourceRecord,
	SourceSnapshot,
	StateStore,
	StoredSourceSnapshot,
} from "@syncdown/core";
import {
	createDefaultConfig,
	getDefaultConnection,
	getDefaultIntegration,
} from "@syncdown/core";

import {
	createGmailConnector,
	extractMessageBody,
	type GmailAdapter,
	type GmailHistoryResult,
	type GmailMessage,
	type GmailProfile,
	type GmailThread,
	stripHtml,
} from "./index.js";

class MemoryStateStore implements StateStore {
	readonly records = new Map<string, SourceRecord>();
	readonly snapshots = new Map<string, StoredSourceSnapshot>();

	async getCursor(): Promise<string | null> {
		return null;
	}

	async setCursor(): Promise<void> {}

	async getLastSyncAt(): Promise<string | null> {
		return null;
	}

	async setLastSyncAt(): Promise<void> {}

	async resetIntegration(integrationId: string): Promise<SourceRecord[]> {
		const deletedRecords = [...this.records.values()].filter(
			(record) => record.integrationId === integrationId,
		);

		for (const record of deletedRecords) {
			this.records.delete(`${record.integrationId}:${record.sourceId}`);
			this.snapshots.delete(`${record.integrationId}:${record.sourceId}`);
		}

		return deletedRecords;
	}

	async getSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<SourceRecord | null> {
		return this.records.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async listSourceRecords(integrationId: string): Promise<SourceRecord[]> {
		return [...this.records.values()].filter(
			(record) => record.integrationId === integrationId,
		);
	}

	async upsertSourceRecord(record: SourceRecord): Promise<void> {
		this.records.set(`${record.integrationId}:${record.sourceId}`, record);
	}

	async deleteSourceRecord(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.records.delete(`${integrationId}:${sourceId}`);
	}

	async getSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<StoredSourceSnapshot | null> {
		return this.snapshots.get(`${integrationId}:${sourceId}`) ?? null;
	}

	async upsertSourceSnapshot(snapshot: StoredSourceSnapshot): Promise<void> {
		this.snapshots.set(
			`${snapshot.integrationId}:${snapshot.sourceId}`,
			snapshot,
		);
	}

	async deleteSourceSnapshot(
		integrationId: string,
		sourceId: string,
	): Promise<void> {
		this.snapshots.delete(`${integrationId}:${sourceId}`);
	}

	async describe(): Promise<string[]> {
		return [];
	}
}

class MemorySecretsStore implements SecretsStore {
	constructor(private readonly secrets = new Map<string, string>()) {}

	async hasSecret(name: string): Promise<boolean> {
		return this.secrets.has(name);
	}

	async getSecret(name: string): Promise<string | null> {
		return this.secrets.get(name) ?? null;
	}

	async setSecret(name: string, value: string): Promise<void> {
		this.secrets.set(name, value);
	}

	async deleteSecret(name: string): Promise<void> {
		this.secrets.delete(name);
	}

	describe(): string {
		return "memory";
	}
}

function createRequest(
	_adapter: GmailAdapter,
	options: {
		since?: string | null;
		syncFilter?: "primary" | "primary-important" | "inbox";
		secrets?: SecretsStore;
		resolvedAuth?: GoogleResolvedAuth | null;
		persistSource?: (source: SourceSnapshot) => Promise<void>;
		deleteSource?: (sourceId: string) => Promise<void>;
		resetIntegrationState?: () => Promise<void>;
		io?: AppIo;
		setProgress?: ConnectorSyncRequest["setProgress"];
	} = {},
): ConnectorSyncRequest {
	const paths: AppPaths = {
		configDir: "/tmp/config",
		dataDir: "/tmp/data",
		configPath: "/tmp/config/config.json",
		statePath: "/tmp/data/state.db",
		secretsPath: "/tmp/data/secrets.enc",
		masterKeyPath: "/tmp/data/master.key",
		lockPath: "/tmp/data/sync.lock",
	};
	const config = createDefaultConfig();
	config.outputDir = "/tmp/output";
	const integration = getDefaultIntegration(config, "gmail");
	if (integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	integration.enabled = true;
	integration.config.syncFilter = options.syncFilter ?? "primary";
	const connection = getDefaultConnection(config, "gmail");

	return {
		config,
		integration,
		connection,
		io: options.io ?? { write() {}, error() {} },
		paths,
		since: options.since ?? null,
		renderVersion: "renderer-v1",
		secrets:
			options.secrets ??
			new MemorySecretsStore(
				new Map([
					["oauthApps.google-default.clientId", "client-id"],
					["oauthApps.google-default.clientSecret", "client-secret"],
					["connections.google-account-default.refreshToken", "refresh-token"],
				]),
			),
		state: new MemoryStateStore(),
		throwIfCancelled() {},
		resolvedAuth:
			options.resolvedAuth !== undefined
				? options.resolvedAuth
				: {
						kind: "google-oauth",
						clientId: "client-id",
						clientSecret: "client-secret",
						refreshToken: "refresh-token",
						requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
					},
		persistSource: options.persistSource ?? (async () => {}),
		deleteSource: options.deleteSource ?? (async () => {}),
		resetIntegrationState: options.resetIntegrationState ?? (async () => {}),
		setProgress: options.setProgress ?? (() => {}),
	};
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function createMessage(
	messageId: string,
	overrides: Partial<GmailMessage> = {},
): GmailMessage {
	return {
		id: messageId,
		threadId: overrides.threadId ?? `thread-${messageId}`,
		historyId: overrides.historyId ?? "200",
		internalDate:
			overrides.internalDate ?? String(Date.parse("2026-03-16T12:34:56.000Z")),
		labelIds: overrides.labelIds ?? ["INBOX", "CATEGORY_PERSONAL", "UNREAD"],
		snippet: overrides.snippet ?? `snippet-${messageId}`,
		payload: overrides.payload ?? {
			headers: [
				{ name: "Subject", value: `Subject ${messageId}` },
				{ name: "From", value: "Sender <sender@example.com>" },
				{
					name: "To",
					value: "Alpha <alpha@example.com>, Beta <beta@example.com>",
				},
				{ name: "Cc", value: "Gamma <gamma@example.com>" },
				{ name: "Date", value: "Mon, 16 Mar 2026 12:34:56 +0000" },
			],
			parts: [
				{
					mimeType: "text/plain",
					body: { data: encode(`Body ${messageId}`) },
				},
			],
		},
	};
}

function createThread(threadId: string, messages: GmailMessage[]): GmailThread {
	return {
		id: threadId,
		historyId: "200",
		messages: messages.map((message) => ({ ...message, threadId })),
	};
}

function createAdapter(overrides: Partial<GmailAdapter> = {}): GmailAdapter {
	return {
		async validate(): Promise<void> {},
		async getProfile(): Promise<GmailProfile> {
			return {
				historyId: "300",
				emailAddress: "owner@example.com",
			};
		},
		async listInboxThreadIds(): Promise<string[]> {
			return [];
		},
		async listHistory(): Promise<GmailHistoryResult> {
			return { history: [] };
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			return createThread(threadId, [createMessage(`${threadId}-m1`)]);
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			return createMessage(messageId);
		},
		...overrides,
	};
}

test("validation fails when gmail secrets are incomplete", async () => {
	const connector = createGmailConnector({ adapter: createAdapter() });
	const request = createRequest(createAdapter(), {
		secrets: new MemorySecretsStore(),
		resolvedAuth: null,
	});

	expect(await connector.validate(request)).toEqual({
		status: "error",
		message: "credentials missing in encrypted store",
	});
});

test("default adapter validates credentials with fetch-based Gmail API calls", async () => {
	const originalFetch = globalThis.fetch;
	const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		fetchCalls.push({ url, init });
		if (url === "https://oauth2.googleapis.com/token") {
			return new Response(
				JSON.stringify({ access_token: "access-token", expires_in: 3600 }),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
			expect(init?.headers).toEqual({
				authorization: "Bearer access-token",
				accept: "application/json",
			});
			return new Response(JSON.stringify({ historyId: "300" }), {
				status: 200,
				headers: {
					"content-type": "application/json",
				},
			});
		}

		if (
			url ===
			"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token"
		) {
			return new Response(
				JSON.stringify({
					scope: "https://www.googleapis.com/auth/gmail.readonly",
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
					},
				},
			);
		}

		throw new Error(`unexpected url: ${url}`);
	}) as typeof fetch;

	try {
		const connector = createGmailConnector();
		await expect(
			connector.validate(createRequest(createAdapter())),
		).resolves.toEqual({
			status: "ok",
			message: "credentials valid",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(fetchCalls).toHaveLength(4);
	expect(fetchCalls[0]?.url).toBe("https://oauth2.googleapis.com/token");
	expect(fetchCalls[1]?.url).toBe(
		"https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=access-token",
	);
	expect(fetchCalls[2]?.url).toBe("https://oauth2.googleapis.com/token");
	expect(fetchCalls[3]?.url).toBe(
		"https://gmail.googleapis.com/gmail/v1/users/me/profile",
	);
});

test("initial inbox sync persists one snapshot per thread and stores next history id", async () => {
	const persisted: SourceSnapshot[] = [];
	let requestedFilter: string | undefined;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listInboxThreadIds(_credentials, syncFilter): Promise<string[]> {
			requestedFilter = syncFilter;
			return ["t1", "t2"];
		},
	});
	const connector = createGmailConnector({ adapter });

	const result = await connector.sync(
		createRequest(adapter, {
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
			persistSource: async (source) => {
				persisted.push(source);
			},
		}),
	);

	expect(result.nextCursor).toBe(
		JSON.stringify({
			historyId: "300",
			syncFilter: "primary",
			grouping: "thread",
		}),
	);
	expect(requestedFilter).toBe("primary");
	expect(persisted.map((source) => source.sourceId).sort()).toEqual([
		"t1",
		"t2",
	]);
	expect(persisted.map((source) => source.entityType)).toEqual([
		"thread",
		"thread",
	]);
	expect(persisted.map((source) => source.metadata.gmailAccountEmail)).toEqual([
		"owner@example.com",
		"owner@example.com",
	]);
	expect(persisted.map((source) => source.pathHint.gmailAccountEmail)).toEqual([
		"owner@example.com",
		"owner@example.com",
	]);
	expect(writes).toContain(
		"Gmail progress: streaming inbox scan concurrency=10",
	);
});

test("thread snapshots merge messages chronologically into one body", async () => {
	const persisted: SourceSnapshot[] = [];
	const older = createMessage("m-old", {
		internalDate: String(Date.parse("2026-03-15T08:00:00.000Z")),
		snippet: "older snippet",
		payload: {
			headers: [
				{ name: "Subject", value: "Trip plan" },
				{ name: "From", value: "Ada <ada@example.com>" },
				{ name: "To", value: "Bob <bob@example.com>" },
			],
			parts: [
				{ mimeType: "text/plain", body: { data: encode("First message") } },
			],
		},
	});
	const newer = createMessage("m-new", {
		internalDate: String(Date.parse("2026-03-16T09:30:00.000Z")),
		snippet: "latest snippet",
		payload: {
			headers: [
				{ name: "Subject", value: "Re: Trip plan" },
				{ name: "From", value: "Bob <bob@example.com>" },
			],
			parts: [
				{ mimeType: "text/plain", body: { data: encode("Second message") } },
			],
		},
	});
	const adapter = createAdapter({
		async listInboxThreadIds(): Promise<string[]> {
			return ["t1"];
		},
		async getThread(): Promise<GmailThread | null> {
			// Return out of order to verify sorting.
			return createThread("t1", [newer, older]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			persistSource: async (source) => {
				persisted.push(source);
			},
		}),
	);

	expect(persisted).toHaveLength(1);
	const snapshot = persisted[0]!;
	expect(snapshot.sourceId).toBe("t1");
	expect(snapshot.title).toBe("Trip plan");
	expect(snapshot.metadata.createdAt).toBe("2026-03-15T08:00:00.000Z");
	expect(snapshot.metadata.updatedAt).toBe("2026-03-16T09:30:00.000Z");
	expect(snapshot.metadata.gmailMessageCount).toBe(2);
	expect(snapshot.metadata.gmailParticipants).toEqual([
		"Ada <ada@example.com>",
		"Bob <bob@example.com>",
	]);
	expect(snapshot.metadata.gmailSnippet).toBe("latest snippet");
	expect(snapshot.metadata.sourceUrl).toBe(
		"https://mail.google.com/mail/u/0/#inbox/t1",
	);
	const firstIndex = snapshot.bodyMd.indexOf("First message");
	const secondIndex = snapshot.bodyMd.indexOf("Second message");
	expect(firstIndex).toBeGreaterThanOrEqual(0);
	expect(secondIndex).toBeGreaterThan(firstIndex);
	expect(snapshot.bodyMd).toContain(
		"## Ada <ada@example.com> — 2026-03-15T08:00:00.000Z",
	);
	expect(snapshot.bodyMd).toContain(
		"## Bob <bob@example.com> — 2026-03-16T09:30:00.000Z",
	);
	expect(snapshot.bodyMd).toContain("\n\n---\n\n");
});

test("threads with only ineligible messages are deleted, mixed threads keep eligible messages", async () => {
	const persisted: SourceSnapshot[] = [];
	const deleted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listInboxThreadIds(): Promise<string[]> {
			return ["t-mixed", "t-archived"];
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			if (threadId === "t-mixed") {
				return createThread("t-mixed", [
					createMessage("m1"),
					createMessage("m2", { labelIds: ["CATEGORY_UPDATES"] }),
				]);
			}
			return createThread("t-archived", [
				createMessage("m3", { labelIds: ["CATEGORY_UPDATES"] }),
			]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			persistSource: async (source) => {
				persisted.push(source);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(persisted).toHaveLength(1);
	expect(persisted[0]?.sourceId).toBe("t-mixed");
	expect(persisted[0]?.metadata.gmailMessageCount).toBe(1);
	expect(persisted[0]?.bodyMd).toContain("Body m1");
	expect(persisted[0]?.bodyMd).not.toContain("Body m2");
	expect(deleted).toEqual(["t-archived"]);
	expect(writes).toContain(
		"Gmail thread removed from the active primary filter during sync: t-archived",
	);
});

test("gmail sync falls back to the configured connection email when profile email is missing", async () => {
	const persisted: SourceSnapshot[] = [];
	const adapter = createAdapter({
		async getProfile(): Promise<GmailProfile> {
			return { historyId: "300" };
		},
		async listInboxThreadIds(): Promise<string[]> {
			return ["t1"];
		},
	});
	const request = createRequest(adapter, {
		persistSource: async (source) => {
			persisted.push(source);
		},
	});
	if (request.connection.kind !== "google-account") {
		throw new Error("expected google account connection");
	}
	request.connection.accountEmail = "fallback@example.com";

	await createGmailConnector({ adapter }).sync(request);

	expect(persisted).toHaveLength(1);
	expect(persisted[0]?.metadata.gmailAccountEmail).toBe("fallback@example.com");
	expect(persisted[0]?.pathHint.gmailAccountEmail).toBe("fallback@example.com");
});

test("incremental history sync refetches only changed threads", async () => {
	const requested: string[] = [];
	const persisted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{
						messagesAdded: [{ message: { id: "m1", threadId: "t1" } }],
						labelsRemoved: [{ message: { id: "m2", threadId: "t2" } }],
					},
				],
			};
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			requested.push(threadId);
			return createThread(threadId, [createMessage(`${threadId}-m1`)]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary",
				grouping: "thread",
			}),
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
		}),
	);

	expect(requested.sort()).toEqual(["t1", "t2"]);
	expect(persisted.sort()).toEqual(["t1", "t2"]);
	expect(writes).toContain("Gmail progress: threads=2 concurrency=10");
});

test("incremental history resolves thread ids via getMessage when history omits them", async () => {
	const persisted: string[] = [];
	const messageLookups: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
			};
		},
		async getMessage(
			_credentials,
			messageId: string,
		): Promise<GmailMessage | null> {
			messageLookups.push(messageId);
			return createMessage(messageId, { threadId: "t9" });
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			return createThread(threadId, [createMessage(`${threadId}-m1`)]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary",
				grouping: "thread",
			}),
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
		}),
	);

	expect(messageLookups).toEqual(["m1"]);
	expect(persisted).toEqual(["t9"]);
});

test("incremental history sync publishes structured determinate progress", async () => {
	const progressUpdates: Array<IntegrationRuntimeProgress | null> = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{
						messagesAdded: [{ message: { id: "m1", threadId: "t1" } }],
						labelsRemoved: [{ message: { id: "m2", threadId: "t2" } }],
					},
				],
			};
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary",
				grouping: "thread",
			}),
			setProgress(progress) {
				progressUpdates.push(progress ? { ...progress } : null);
			},
		}),
	);

	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Checking mailbox history",
		detail: null,
		completed: null,
		total: null,
		unit: "threads",
	});
	expect(progressUpdates).toContainEqual({
		mode: "determinate",
		phase: "Fetching changed threads",
		detail: "processed 2 of 2 | concurrency 10",
		completed: 2,
		total: 2,
		unit: "threads",
	});
});

test("initial inbox sync scans the full filtered inbox", async () => {
	let requestedFilter: string | undefined;
	const adapter = createAdapter({
		async listInboxThreadIds(_credentials, syncFilter): Promise<string[]> {
			requestedFilter = syncFilter;
			return ["t1"];
		},
	});
	const connector = createGmailConnector({ adapter });
	await connector.sync(createRequest(adapter));

	expect(requestedFilter).toBe("primary");
});

test("thread fetches honor configured concurrency", async () => {
	let active = 0;
	let peak = 0;
	let releaseCurrentBatch!: () => void;
	let markSecondStart!: () => void;
	let currentBatch = new Promise<void>((resolve) => {
		releaseCurrentBatch = resolve;
	});
	const secondStart = new Promise<void>((resolve) => {
		markSecondStart = resolve;
	});

	const adapter = createAdapter({
		async listInboxThreadIds(): Promise<string[]> {
			return ["t1", "t2", "t3", "t4"];
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			active += 1;
			peak = Math.max(peak, active);
			if (active === 2) {
				markSecondStart();
			}
			await currentBatch;
			active -= 1;
			return createThread(threadId, [createMessage(`${threadId}-m1`)]);
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter);
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.fetchConcurrency = 2;

	const syncPromise = connector.sync(request);
	await secondStart;
	releaseCurrentBatch();
	currentBatch = Promise.resolve();
	await syncPromise;

	expect(peak).toBe(2);
});

test("initial inbox sync persists completed threads without waiting for slower fetches", async () => {
	const persisted: string[] = [];
	let releaseSlowFetch!: () => void;
	let markFastPersisted!: () => void;
	const slowFetch = new Promise<void>((resolve) => {
		releaseSlowFetch = resolve;
	});
	const fastPersisted = new Promise<void>((resolve) => {
		markFastPersisted = resolve;
	});

	const adapter = createAdapter({
		async *iterateInboxThreadIds(): AsyncIterable<string> {
			yield "t1";
			yield "t2";
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			if (threadId === "t2") {
				await slowFetch;
			}
			return createThread(threadId, [createMessage(`${threadId}-m1`)]);
		},
	});
	const connector = createGmailConnector({ adapter });
	const request = createRequest(adapter, {
		persistSource: async (source) => {
			persisted.push(source.sourceId);
			if (source.sourceId === "t1") {
				markFastPersisted();
			}
		},
	});
	if (request.integration.connectorId !== "gmail") {
		throw new Error("expected gmail integration");
	}
	request.integration.config.fetchConcurrency = 2;

	let completed = false;
	const syncPromise = connector.sync(request).then(() => {
		completed = true;
	});

	await fastPersisted;
	expect(persisted).toEqual(["t1"]);
	expect(completed).toBe(false);

	releaseSlowFetch();
	await syncPromise;

	expect(persisted).toEqual(["t1", "t2"]);
	expect(completed).toBe(true);
});

test("invalid history id falls back to a full scoped rescan", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	const persisted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [], invalidCursor: true };
		},
		async listInboxThreadIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["t3"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "stale-history",
				syncFilter: "primary",
				grouping: "thread",
			}),
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
		}),
	);

	expect(historyCalls).toBe(1);
	expect(inboxCalls).toBe(1);
	expect(persisted).toEqual(["t3"]);
	expect(writes).toContain(
		"Gmail history cursor expired. Falling back to a full scoped rescan.",
	);
	expect(writes).toContain(
		"Gmail progress: streaming inbox scan concurrency=10",
	);
});

test("history fallback publishes structured scanning progress", async () => {
	const progressUpdates: Array<IntegrationRuntimeProgress | null> = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return { history: [], invalidCursor: true };
		},
		async listInboxThreadIds(): Promise<string[]> {
			return ["t3"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "stale-history",
				syncFilter: "primary",
				grouping: "thread",
			}),
			setProgress(progress) {
				progressUpdates.push(progress ? { ...progress } : null);
			},
		}),
	);

	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Checking mailbox history",
		detail: null,
		completed: null,
		total: null,
		unit: "threads",
	});
	expect(progressUpdates).toContainEqual({
		mode: "indeterminate",
		phase: "Scanning inbox",
		detail: "processed 1 | concurrency 10",
		completed: null,
		total: null,
		unit: "threads",
	});
});

test("legacy gmail cursor resets integration state before a scoped resync", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	let resetCalls = 0;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [] };
		},
		async listInboxThreadIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["t1"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: "legacy-history-id",
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(resetCalls).toBe(1);
	expect(historyCalls).toBe(0);
	expect(inboxCalls).toBe(1);
	expect(writes).toContain(
		"Gmail legacy cursor detected. Resetting integration state before the next scoped sync.",
	);
});

test("per-message cursors without thread grouping reset integration state", async () => {
	let resetCalls = 0;
	let inboxCalls = 0;
	const adapter = createAdapter({
		async listInboxThreadIds(): Promise<string[]> {
			inboxCalls += 1;
			return [];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({ historyId: "250", syncFilter: "primary" }),
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
		}),
	);

	expect(resetCalls).toBe(1);
	expect(inboxCalls).toBe(1);
});

test("gmail sync filter changes reset integration state before a scoped resync", async () => {
	let historyCalls = 0;
	let inboxCalls = 0;
	let resetCalls = 0;
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			historyCalls += 1;
			return { history: [] };
		},
		async listInboxThreadIds(): Promise<string[]> {
			inboxCalls += 1;
			return ["t1"];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary-important",
				grouping: "thread",
			}),
			syncFilter: "primary",
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(resetCalls).toBe(1);
	expect(historyCalls).toBe(0);
	expect(inboxCalls).toBe(1);
	expect(writes).toContain(
		"Gmail sync filter changed. Resetting integration state before the next scoped sync.",
	);
});

test("threads removed from the active filter delete local files instead of persisting archived state", async () => {
	const persisted: SourceSnapshot[] = [];
	const deleted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{ labelsRemoved: [{ message: { id: "m4", threadId: "t4" } }] },
				],
			};
		},
		async getThread(): Promise<GmailThread | null> {
			return createThread("t4", [
				createMessage("m4", { labelIds: ["CATEGORY_UPDATES"] }),
			]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary",
				grouping: "thread",
			}),
			persistSource: async (source) => {
				persisted.push(source);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(persisted).toEqual([]);
	expect(deleted).toEqual(["t4"]);
	expect(writes).toContain(
		"Gmail thread removed from the active primary filter during sync: t4",
	);
});

test("hard-deleted threads remove local files and do not fail sync", async () => {
	const writes: string[] = [];
	const deleted: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{ messagesDeleted: [{ message: { id: "m5", threadId: "t5" } }] },
				],
			};
		},
		async getThread(): Promise<GmailThread | null> {
			return null;
		},
	});
	const connector = createGmailConnector({ adapter });

	const result = await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "primary",
				grouping: "thread",
			}),
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(result.nextCursor).toBe(
		JSON.stringify({
			historyId: "300",
			syncFilter: "primary",
			grouping: "thread",
		}),
	);
	expect(deleted).toEqual(["t5"]);
	expect(writes).toContain("Gmail thread deleted during sync: t5");
});

test("primary-important sync only persists threads with the IMPORTANT label", async () => {
	const persisted: string[] = [];
	const deleted: string[] = [];
	let requestedFilter: string | undefined;
	const adapter = createAdapter({
		async listInboxThreadIds(_credentials, syncFilter): Promise<string[]> {
			requestedFilter = syncFilter;
			return ["t1", "t2"];
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			return threadId === "t1"
				? createThread("t1", [
						createMessage("m1", {
							labelIds: ["INBOX", "CATEGORY_PERSONAL", "IMPORTANT"],
						}),
					])
				: createThread("t2", [
						createMessage("m2", { labelIds: ["INBOX", "CATEGORY_PERSONAL"] }),
					]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			syncFilter: "primary-important",
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
		}),
	);

	expect(requestedFilter).toBe("primary-important");
	expect(persisted).toEqual(["t1"]);
	expect(deleted).toEqual(["t2"]);
});

test("body extraction prefers text plain and falls back to stripped html", () => {
	expect(
		extractMessageBody(
			createMessage("m6", {
				payload: {
					headers: [],
					parts: [
						{ mimeType: "text/plain", body: { data: encode("Plain body") } },
						{
							mimeType: "text/html",
							body: { data: encode("<p>HTML body</p>") },
						},
					],
				},
			}),
		),
	).toBe("Plain body");

	expect(
		extractMessageBody(
			createMessage("m7", {
				payload: {
					headers: [],
					parts: [
						{
							mimeType: "text/html",
							body: { data: encode("<p>Hello <strong>world</strong></p>") },
						},
					],
				},
			}),
		),
	).toBe("Hello world");
});

test("html stripping handles common markup cleanup", () => {
	expect(stripHtml("<p>Hello<br>world</p><script>ignore()</script>")).toBe(
		"Hello\nworld",
	);
});

test("inbox sync filter passes syncFilter=inbox to listInboxThreadIds", async () => {
	let requestedFilter: string | undefined;
	const adapter = createAdapter({
		async listInboxThreadIds(_credentials, syncFilter): Promise<string[]> {
			requestedFilter = syncFilter;
			return ["t1"];
		},
	});
	const connector = createGmailConnector({ adapter });
	await connector.sync(createRequest(adapter, { syncFilter: "inbox" }));

	expect(requestedFilter).toBe("inbox");
});

test("inbox sync filter persists threads with INBOX but without CATEGORY_PERSONAL", async () => {
	const persisted: string[] = [];
	const deleted: string[] = [];
	const adapter = createAdapter({
		async listInboxThreadIds(): Promise<string[]> {
			return ["t1", "t2"];
		},
		async getThread(
			_credentials,
			threadId: string,
		): Promise<GmailThread | null> {
			return threadId === "t1"
				? createThread("t1", [
						createMessage("m1", { labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] }),
					])
				: createThread("t2", [
						createMessage("m2", { labelIds: ["INBOX", "CATEGORY_PERSONAL"] }),
					]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			syncFilter: "inbox",
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
		}),
	);

	expect(persisted.sort()).toEqual(["t1", "t2"]);
	expect(deleted).toEqual([]);
});

test("inbox sync filter deletes threads without INBOX label", async () => {
	const persisted: string[] = [];
	const deleted: string[] = [];
	const writes: string[] = [];
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return {
				history: [
					{ labelsRemoved: [{ message: { id: "m1", threadId: "t1" } }] },
				],
			};
		},
		async getThread(): Promise<GmailThread | null> {
			return createThread("t1", [
				createMessage("m1", { labelIds: ["CATEGORY_PROMOTIONS"] }),
			]);
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "inbox",
				grouping: "thread",
			}),
			syncFilter: "inbox",
			persistSource: async (source) => {
				persisted.push(source.sourceId);
			},
			deleteSource: async (sourceId) => {
				deleted.push(sourceId);
			},
			io: {
				write(line) {
					writes.push(line);
				},
				error() {},
			},
		}),
	);

	expect(persisted).toEqual([]);
	expect(deleted).toEqual(["t1"]);
	expect(writes).toContain(
		"Gmail thread removed from the active inbox filter during sync: t1",
	);
});

test("inbox cursor is accepted as valid and not treated as legacy", async () => {
	let resetCalls = 0;
	let inboxCalls = 0;
	const adapter = createAdapter({
		async listHistory(): Promise<GmailHistoryResult> {
			return { history: [] };
		},
		async listInboxThreadIds(): Promise<string[]> {
			inboxCalls += 1;
			return [];
		},
	});
	const connector = createGmailConnector({ adapter });

	await connector.sync(
		createRequest(adapter, {
			since: JSON.stringify({
				historyId: "250",
				syncFilter: "inbox",
				grouping: "thread",
			}),
			syncFilter: "inbox",
			resetIntegrationState: async () => {
				resetCalls += 1;
			},
		}),
	);

	expect(resetCalls).toBe(0);
	expect(inboxCalls).toBe(0);
});
