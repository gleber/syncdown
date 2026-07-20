import { randomUUID } from "node:crypto";

import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	GoogleKeepTokenConnectionConfig,
	HealthCheck,
	IntegrationConfig,
	SourceSnapshot,
} from "@syncdown/core";
import {
	DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
	defineConnectorPlugin,
	stableStringify,
} from "@syncdown/core";

import {
	createGoogleKeepAdapter,
	type GoogleKeepAdapter,
	GoogleKeepApiError,
	type GoogleKeepCredentials,
	type KeepNode,
	type KeepNodeType,
} from "./keep-api.js";

const CURSOR_VERSION = 1;
const EPOCH_MS = Date.parse("1970-01-01T00:00:00.000Z");

export type CachedKeepNodeType = "NOTE" | "LIST" | "LIST_ITEM" | "BLOB";

export interface CachedKeepNode {
	id: string;
	parentId: string;
	type: CachedKeepNodeType;
	title?: string;
	text?: string;
	checked?: boolean;
	sortValue?: string;
	superListItemId?: string;
	color?: string;
	archived?: boolean;
	pinned?: boolean;
	trashed?: boolean;
	created?: string;
	updated?: string;
	labelIds?: string[];
	serverId?: string;
}

export interface StoredGoogleKeepCursor {
	version: 1;
	keepVersion: string;
	nodes: Record<string, CachedKeepNode>;
	labels: Record<string, string>;
}

export interface CreateGoogleKeepConnectorOptions {
	adapter?: GoogleKeepAdapter;
}

function isTimestampSet(value: string | null | undefined): boolean {
	if (!value) {
		return false;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed > EPOCH_MS;
}

function isKeepNodeType(
	value: string | null | undefined,
): value is KeepNodeType {
	return (
		value === "NOTE" ||
		value === "LIST" ||
		value === "LIST_ITEM" ||
		value === "BLOB"
	);
}

function extractLabelIds(node: KeepNode): string[] | undefined {
	if (!Array.isArray(node.labelIds) || node.labelIds.length === 0) {
		return undefined;
	}
	const ids = node.labelIds
		.map((entry) => {
			if (typeof entry === "string") {
				return entry.trim();
			}
			return entry.labelId?.trim() ?? "";
		})
		.filter((value) => value.length > 0);
	return ids.length > 0 ? ids : undefined;
}

function projectNode(node: KeepNode): CachedKeepNode | null {
	const id = node.id?.trim();
	const type = node.type ?? null;
	if (!id || !isKeepNodeType(type)) {
		return null;
	}

	const parentId = node.parentId?.trim() || "root";
	const sortValue =
		node.sortValue === undefined || node.sortValue === null
			? undefined
			: String(node.sortValue);

	return {
		id,
		parentId,
		type,
		title: node.title ?? undefined,
		text: node.text ?? undefined,
		checked: node.checked ?? undefined,
		sortValue,
		superListItemId: node.superListItemId ?? undefined,
		color: node.color ?? undefined,
		archived: node.isArchived ?? undefined,
		pinned: node.isPinned ?? undefined,
		trashed: isTimestampSet(node.timestamps?.trashed),
		created: node.timestamps?.created ?? undefined,
		updated: node.timestamps?.updated ?? undefined,
		labelIds: extractLabelIds(node),
		serverId: node.serverId ?? undefined,
	};
}

function isPermanentlyDeleted(node: KeepNode): boolean {
	if (isTimestampSet(node.timestamps?.deleted)) {
		return true;
	}
	return !node.parentId;
}

function slugifySegment(input: string): string {
	return (
		input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "untitled"
	);
}

function computeSourceHash(
	snapshot: Omit<SourceSnapshot, "sourceHash">,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			stableStringify({
				connectorId: snapshot.connectorId,
				sourceId: snapshot.sourceId,
				title: snapshot.title,
				entityType: snapshot.entityType,
				pathHint: snapshot.pathHint,
				metadata: snapshot.metadata,
				bodyMd: snapshot.bodyMd,
			}),
		)
		.digest("hex");
}

function compareSortValueDescending(
	a: CachedKeepNode,
	b: CachedKeepNode,
): number {
	const left = Number(a.sortValue ?? "0");
	const right = Number(b.sortValue ?? "0");
	const leftValue = Number.isFinite(left) ? left : 0;
	const rightValue = Number.isFinite(right) ? right : 0;
	return rightValue - leftValue;
}

function sortListItems(items: CachedKeepNode[]): CachedKeepNode[] {
	const unchecked = items
		.filter((item) => !item.checked)
		.sort(compareSortValueDescending);
	const checked = items
		.filter((item) => Boolean(item.checked))
		.sort(compareSortValueDescending);
	return [...unchecked, ...checked];
}

function renderListItem(item: CachedKeepNode, indent: string): string {
	const marker = item.checked ? "- [x]" : "- [ ]";
	const text = (item.text ?? "").replace(/\r?\n/g, " ");
	return `${indent}${marker} ${text}`.trimEnd();
}

function renderListBody(
	rootId: string,
	cache: Record<string, CachedKeepNode>,
): string {
	const children = Object.values(cache).filter(
		(node) => node.parentId === rootId && node.type === "LIST_ITEM",
	);
	const byParent = new Map<string | undefined, CachedKeepNode[]>();
	for (const child of children) {
		const key = child.superListItemId?.trim() || undefined;
		const bucket = byParent.get(key) ?? [];
		bucket.push(child);
		byParent.set(key, bucket);
	}

	const lines: string[] = [];
	const visit = (parentId: string | undefined, indent: string) => {
		const items = sortListItems(byParent.get(parentId) ?? []);
		for (const item of items) {
			lines.push(renderListItem(item, indent));
			visit(item.id, `${indent}  `);
		}
	};
	visit(undefined, "");
	return lines.join("\n");
}

function renderNoteBody(
	rootId: string,
	cache: Record<string, CachedKeepNode>,
): string {
	const child = Object.values(cache).find(
		(node) => node.parentId === rootId && node.type === "LIST_ITEM",
	);
	return child?.text ?? "";
}

function resolveLabelNames(
	labelIds: string[] | undefined,
	labels: Record<string, string>,
): string[] | undefined {
	if (!labelIds || labelIds.length === 0) {
		return undefined;
	}
	const names = labelIds
		.map((id) => labels[id] ?? id)
		.filter((name) => name.trim().length > 0);
	return names.length > 0 ? names : undefined;
}

function buildSnapshot(
	integrationId: string,
	note: CachedKeepNode,
	cache: Record<string, CachedKeepNode>,
	labels: Record<string, string>,
): SourceSnapshot {
	const title = note.title?.trim() || "Untitled";
	const bodyMd =
		note.type === "LIST"
			? renderListBody(note.id, cache)
			: renderNoteBody(note.id, cache);

	const snapshotBase: Omit<SourceSnapshot, "sourceHash"> = {
		integrationId,
		connectorId: "google-keep",
		sourceId: note.id,
		entityType: "keep-note",
		title,
		slug: slugifySegment(title),
		pathHint: {
			kind: "keep-note",
		},
		metadata: {
			sourceUrl: `https://keep.google.com/#NOTE/${note.id}`,
			createdAt: note.created,
			updatedAt: note.updated,
			archived: note.archived,
			keepNoteId: note.id,
			keepColor: note.color,
			keepPinned: note.pinned,
			keepLabels: resolveLabelNames(note.labelIds, labels),
		},
		bodyMd,
		snapshotSchemaVersion: "1",
	};

	return {
		...snapshotBase,
		sourceHash: computeSourceHash(snapshotBase),
	};
}

export function decodeGoogleKeepCursor(
	value: string | null,
): StoredGoogleKeepCursor | null {
	if (!value) {
		return null;
	}

	try {
		const parsed = JSON.parse(value) as Partial<StoredGoogleKeepCursor>;
		if (
			parsed.version !== CURSOR_VERSION ||
			typeof parsed.keepVersion !== "string" ||
			parsed.keepVersion.trim().length === 0 ||
			typeof parsed.nodes !== "object" ||
			parsed.nodes === null ||
			typeof parsed.labels !== "object" ||
			parsed.labels === null
		) {
			return null;
		}

		const nodes: Record<string, CachedKeepNode> = {};
		for (const [id, node] of Object.entries(parsed.nodes)) {
			if (
				!node ||
				typeof node !== "object" ||
				typeof node.id !== "string" ||
				typeof node.parentId !== "string" ||
				!isKeepNodeType(node.type)
			) {
				continue;
			}
			nodes[id] = node as CachedKeepNode;
		}

		const labels: Record<string, string> = {};
		for (const [id, name] of Object.entries(parsed.labels)) {
			if (typeof name === "string" && name.trim().length > 0) {
				labels[id] = name;
			}
		}

		return {
			version: CURSOR_VERSION,
			keepVersion: parsed.keepVersion,
			nodes,
			labels,
		};
	} catch {
		return null;
	}
}

export function encodeGoogleKeepCursor(cursor: StoredGoogleKeepCursor): string {
	return JSON.stringify({
		version: CURSOR_VERSION,
		keepVersion: cursor.keepVersion,
		nodes: cursor.nodes,
		labels: cursor.labels,
	} satisfies StoredGoogleKeepCursor);
}

function getAccountEmail(
	connection: ConnectorSyncRequest["connection"],
): string | null {
	if (connection.kind !== "google-keep-token") {
		return null;
	}
	const email = connection.accountEmail?.trim();
	return email && email.length > 0 ? email : null;
}

async function resolveCredentials(
	request: ConnectorSyncRequest,
	adapter: GoogleKeepAdapter,
): Promise<GoogleKeepCredentials> {
	if (
		request.resolvedAuth?.kind !== "token" ||
		request.resolvedAuth.connectionKind !== "google-keep-token"
	) {
		throw new Error("Missing Google Keep credentials in encrypted store");
	}

	const email = getAccountEmail(request.connection);
	if (!email) {
		throw new Error("Google Keep connection is missing accountEmail");
	}

	let masterToken = request.resolvedAuth.token.trim();
	if (masterToken.startsWith("oauth2_4/")) {
		if (!adapter.exchangeAuthToken) {
			throw new Error("Google Keep adapter cannot exchange oauth tokens");
		}
		masterToken = await adapter.exchangeAuthToken(email, masterToken);
		await request.secrets.setSecret(
			request.connection.id,
			masterToken,
			request.paths,
		);
	}

	if (!masterToken.startsWith("aas_et/")) {
		throw new Error(
			"Google Keep secret must be an oauth2_4/ cookie or aas_et/ master token",
		);
	}

	return { email, masterToken };
}

function affectedRootId(
	node: KeepNode,
	projected: CachedKeepNode | null,
): string {
	const parentId = node.parentId?.trim();
	if (!parentId || parentId === "root") {
		return (projected?.id ?? node.id)?.trim() || "";
	}
	return parentId;
}

class GoogleKeepConnector implements Connector {
	readonly id = "google-keep";
	readonly label = "Google Keep";
	readonly setupMethods = [
		{
			kind: "token" as const,
			connectionId: DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
			connectionKind: "google-keep-token",
			label: "Master Token",
			secretName: (connectionId: string) => connectionId,
		},
	];

	constructor(private readonly adapter: GoogleKeepAdapter) {}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return { status: "warn", message: "integration disabled" };
		}
		if (
			!request.resolvedAuth ||
			request.resolvedAuth.kind !== "token" ||
			request.resolvedAuth.connectionKind !== "google-keep-token"
		) {
			return {
				status: "error",
				message: "missing or invalid Google Keep token",
			};
		}
		if (!getAccountEmail(request.connection)) {
			return {
				status: "error",
				message:
					"missing account email; re-run `syncdown connect google-keep --email <addr> --token <value>`",
			};
		}
		return { status: "ok", message: "Google Keep token available" };
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		if (request.integration.connectorId !== "google-keep") {
			throw new Error(
				`Invalid integration for Google Keep connector: ${request.integration.connectorId}`,
			);
		}

		const credentials = await resolveCredentials(request, this.adapter);
		const decoded = decodeGoogleKeepCursor(request.since);
		let full = decoded === null;
		let cache: Record<string, CachedKeepNode> = {};
		let labels: Record<string, string> = {};
		let version: string | null = null;
		if (decoded) {
			cache = { ...decoded.nodes };
			labels = { ...decoded.labels };
			version = decoded.keepVersion;
		}
		const affectedRoots = new Set<string>();

		for (let attempt = 0; attempt < 2; attempt += 1) {
			let restart = false;
			let truncated = false;

			do {
				request.throwIfCancelled();
				let response: Awaited<ReturnType<GoogleKeepAdapter["fetchChanges"]>>;
				try {
					response = await this.adapter.fetchChanges(credentials, version);
				} catch (error) {
					if (
						error instanceof GoogleKeepApiError &&
						error.status === 400 &&
						version !== null
					) {
						full = true;
						cache = {};
						labels = {};
						version = null;
						affectedRoots.clear();
						restart = true;
						break;
					}
					throw error;
				}

				if (response.forceFullResync) {
					full = true;
					cache = {};
					labels = {};
					version = null;
					affectedRoots.clear();
					restart = true;
					break;
				}

				for (const label of response.labels) {
					labels[label.id] = label.name;
				}

				for (const node of response.nodes) {
					const projected = projectNode(node);
					const rootId = affectedRootId(node, projected);
					if (rootId) {
						affectedRoots.add(rootId);
					}

					if (isPermanentlyDeleted(node)) {
						const deletedId = node.id?.trim();
						if (deletedId) {
							delete cache[deletedId];
						}
						continue;
					}

					if (projected) {
						cache[projected.id] = projected;
					}
				}

				version = response.toVersion;
				truncated = response.truncated;
			} while (truncated);

			if (!restart) {
				break;
			}
		}

		if (!version) {
			throw new Error("Google Keep sync did not return a version cursor");
		}

		const rootIds = full
			? Object.values(cache)
					.filter((node) => node.parentId === "root")
					.map((node) => node.id)
			: [...affectedRoots];

		let completed = 0;
		const total = rootIds.length;
		const publishProgress = () => {
			request.setProgress({
				mode: "determinate",
				phase: "Syncing Keep notes",
				detail: `processed ${completed} of ${total}`,
				completed,
				total,
				unit: "items",
			});
		};
		publishProgress();

		const liveRoots = new Set<string>();
		for (const rootId of rootIds) {
			request.throwIfCancelled();
			const note = cache[rootId];
			if (
				!note ||
				note.parentId !== "root" ||
				note.trashed ||
				(note.type !== "NOTE" && note.type !== "LIST")
			) {
				await request.deleteSource(rootId);
			} else {
				liveRoots.add(rootId);
				await request.persistSource(
					buildSnapshot(request.integration.id, note, cache, labels),
				);
			}
			completed += 1;
			publishProgress();
		}

		if (full) {
			const records = await request.state.listSourceRecords(
				request.integration.id,
			);
			for (const record of records) {
				if (!liveRoots.has(record.sourceId)) {
					await request.deleteSource(record.sourceId);
				}
			}
		}

		request.setProgress(null);
		return {
			nextCursor: encodeGoogleKeepCursor({
				version: CURSOR_VERSION,
				keepVersion: version,
				nodes: cache,
				labels,
			}),
		};
	}
}

function normalizeGoogleKeepConnection(
	entry: Partial<{
		id: string;
		kind: string;
		label: string;
		accountEmail?: string;
	}>,
) {
	if (
		entry.kind !== "google-keep-token" ||
		typeof entry.id !== "string" ||
		typeof entry.label !== "string"
	) {
		return [];
	}
	return [
		{
			id: entry.id,
			kind: "google-keep-token" as const,
			label: entry.label,
			accountEmail:
				typeof entry.accountEmail === "string" ? entry.accountEmail : undefined,
		} satisfies GoogleKeepTokenConnectionConfig,
	];
}

function normalizeGoogleKeepIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "google-keep" ||
		typeof entry.id !== "string" ||
		typeof entry.connectionId !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.enabled !== "boolean" ||
		(entry.interval !== "5m" &&
			entry.interval !== "15m" &&
			entry.interval !== "1h" &&
			entry.interval !== "6h" &&
			entry.interval !== "24h")
	) {
		return [];
	}

	return [
		{
			id: entry.id,
			connectorId: "google-keep" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: {},
		},
	];
}

export function createGoogleKeepConnectorPlugin(
	options: CreateGoogleKeepConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new GoogleKeepConnector(
		options.adapter ?? createGoogleKeepAdapter(),
	);
	const setupMethods = [
		{
			kind: "token" as const,
			connectionId: DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
			connectionKind: "google-keep-token",
			label: "Master Token",
			secretName: (connectionId: string) => connectionId,
		},
	];

	return defineConnectorPlugin({
		id: runtime.id,
		label: runtime.label,
		setupMethods,
		validate: runtime.validate.bind(runtime),
		sync: runtime.sync.bind(runtime),
		manifest: {
			id: runtime.id,
			label: runtime.label,
			setupMethods,
			cliAliases: [
				{
					key: "google-keep.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error("google-keep.enabled must be `true` or `false`.");
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-keep",
						);
						if (!integration) {
							throw new Error("Missing default Google Keep integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set google-keep.enabled=${integration.enabled}`;
					},
				},
				{
					key: "google-keep.token",
					secret: true,
					async setValue(context, rawValue) {
						const connection = context.config.connections.find(
							(candidate) => candidate.kind === "google-keep-token",
						);
						if (!connection) {
							throw new Error("Missing default Google Keep connection.");
						}
						await context.secrets.setSecret(
							connection.id,
							rawValue,
							context.paths,
						);
						return "Set google-keep.token";
					},
					async unsetValue(context) {
						const connection = context.config.connections.find(
							(candidate) => candidate.kind === "google-keep-token",
						);
						if (!connection) {
							throw new Error("Missing default Google Keep connection.");
						}
						await context.secrets.deleteSecret(connection.id, context.paths);
						return "Unset google-keep.token";
					},
				},
				{
					key: "google-keep.email",
					async setValue(context, rawValue) {
						const email = rawValue.trim();
						if (!email) {
							throw new Error("google-keep.email cannot be empty.");
						}
						const connection = context.config.connections.find(
							(candidate) => candidate.kind === "google-keep-token",
						);
						if (!connection || connection.kind !== "google-keep-token") {
							throw new Error("Missing default Google Keep connection.");
						}
						connection.accountEmail = email;
						return `Set google-keep.email=${email}`;
					},
				},
			],
		},
		render: {
			version: "1",
		},
		seedConnections() {
			return [
				{
					id: DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
					kind: "google-keep-token",
					label: "Default Google Keep Connection",
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "google-keep",
					connectionId: DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
					label: "Google Keep",
					enabled: false,
					interval: "1h",
					config: {},
				},
			];
		},
		normalizeConnection: normalizeGoogleKeepConnection,
		normalizeIntegration: normalizeGoogleKeepIntegration,
	});
}

export function createGoogleKeepConnector(
	options: CreateGoogleKeepConnectorOptions = {},
): Connector {
	return createGoogleKeepConnectorPlugin(options);
}

export {
	createGpsOAuthClient,
	GpsOAuthClient,
	GpsOAuthError,
} from "./gpsoauth.js";
export type {
	GoogleKeepAdapter,
	GoogleKeepCredentials,
	KeepChangesResponse,
	KeepNode,
} from "./keep-api.js";
export { createGoogleKeepAdapter, GoogleKeepApiError } from "./keep-api.js";
