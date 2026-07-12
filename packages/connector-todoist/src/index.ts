import { randomUUID } from "node:crypto";
import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	HealthCheck,
	IntegrationConfig,
} from "@syncdown/core";
import {
	DEFAULT_TODOIST_CONNECTION_ID,
	defineConnectorPlugin,
} from "@syncdown/core";
import { setRequest } from "./config.js";
import { tick } from "./sync.js";
import { setupWatcher } from "./watcher.js";

export type CreateTodoistConnectorOptions = Record<string, never>;

class TodoistConnector implements Connector {
	readonly id = "todoist";
	readonly label = "Todoist";
	readonly setupMethods = [
		{
			kind: "token" as const,
			connectionId: DEFAULT_TODOIST_CONNECTION_ID,
			connectionKind: "todoist-token",
			label: "API Token",
		},
	];

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return { status: "warn", message: "integration disabled" };
		}
		if (
			!request.resolvedAuth ||
			request.resolvedAuth.kind !== "token" ||
			request.resolvedAuth.connectionKind !== "todoist-token"
		) {
			return { status: "error", message: "missing or invalid Todoist token" };
		}
		return { status: "ok", message: "Todoist token available" };
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		setRequest(request);

		await tick(request);

		setupWatcher(request);

		return { nextCursor: null };
	}
}

function normalizeTodoistConnection(
	entry: Partial<{ id: string; kind: string; label: string }>,
) {
	if (
		entry.kind !== "todoist-token" ||
		typeof entry.id !== "string" ||
		typeof entry.label !== "string"
	) {
		return [];
	}
	return [
		{
			id: entry.id,
			kind: "todoist-token" as const,
			label: entry.label,
		},
	];
}

function normalizeTodoistIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "todoist" ||
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
			connectorId: "todoist" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: entry.config || {},
		},
	];
}

export function createTodoistConnectorPlugin(
	_options: CreateTodoistConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new TodoistConnector();

	const setupMethods = [
		{
			kind: "token" as const,
			connectionId: DEFAULT_TODOIST_CONNECTION_ID,
			connectionKind: "todoist-token",
			label: "API Token",
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
					key: "todoist.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error("todoist.enabled must be `true` or `false`.");
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "todoist",
						);
						if (!integration) {
							throw new Error("Missing default Todoist integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set todoist.enabled=${integration.enabled}`;
					},
				},
				{
					key: "todoist.token",
					secret: true,
					async setValue(context, rawValue) {
						const connection = context.config.connections.find(
							(candidate) => candidate.kind === "todoist-token",
						);
						if (!connection) {
							throw new Error("Missing default Todoist connection.");
						}
						await context.secrets.setSecret(
							connection.id,
							rawValue,
							context.paths,
						);
						return `Set todoist.token`;
					},
					async unsetValue(context) {
						const connection = context.config.connections.find(
							(candidate) => candidate.kind === "todoist-token",
						);
						if (!connection) {
							throw new Error("Missing default Todoist connection.");
						}
						await context.secrets.deleteSecret(connection.id, context.paths);
						return `Unset todoist.token`;
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
					id: DEFAULT_TODOIST_CONNECTION_ID,
					kind: "todoist-token",
					label: "Default Todoist Connection",
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "todoist",
					connectionId: DEFAULT_TODOIST_CONNECTION_ID,
					label: "Todoist",
					enabled: false,
					interval: "1h",
					config: {},
				},
			];
		},
		normalizeConnection: normalizeTodoistConnection,
		normalizeIntegration: normalizeTodoistIntegration,
	});
}

export function createTodoistConnector(
	options: CreateTodoistConnectorOptions = {},
): Connector {
	return createTodoistConnectorPlugin(options);
}
