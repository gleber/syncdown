import { createBuiltinConnectorPlugins } from "@syncdown/connectors";
import type {
	AppIo,
	AppPaths,
	SecretsStore,
	SyncdownConfig,
} from "@syncdown/core";
import {
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	GOOGLE_SECRET_NAMES,
	getDefaultIntegration,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	isCalendarIntegration,
	isGmailIntegration,
} from "@syncdown/core";

const NOTION_TOKEN_SECRET_NAME = `connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`;
const NOTION_OAUTH_APP_SECRET_NAMES = getNotionOAuthAppSecretNames(
	DEFAULT_NOTION_OAUTH_APP_ID,
);
const NOTION_OAUTH_CONNECTION_SECRET_NAMES =
	getNotionOAuthConnectionSecretNames(DEFAULT_NOTION_OAUTH_CONNECTION_ID);

function getNotionAuthMethod(config: SyncdownConfig): "token" | "oauth" {
	return getDefaultIntegration(config, "notion").connectionId ===
		DEFAULT_NOTION_OAUTH_CONNECTION_ID
		? "oauth"
		: "token";
}

function getGmailSettings(config: SyncdownConfig): {
	syncFilter: string;
	fetchConcurrency: number;
} {
	const integration = getDefaultIntegration(config, "gmail");
	if (!isGmailIntegration(integration)) {
		throw new Error("Expected default Gmail integration");
	}
	return {
		syncFilter: integration.config.syncFilter ?? "primary",
		fetchConcurrency: integration.config.fetchConcurrency ?? 10,
	};
}

function getSelectedCalendarIds(config: SyncdownConfig): string[] {
	const integration = getDefaultIntegration(config, "google-calendar");
	if (!isCalendarIntegration(integration)) {
		throw new Error("Expected default Google Calendar integration");
	}
	return integration.config.selectedCalendarIds;
}

function getTodoistTokenSecretName(config: SyncdownConfig): string | null {
	const connection = config.connections.find(
		(candidate) => candidate.kind === "todoist-token",
	);
	return connection ? connection.id : null;
}

function hasConnector(connectorId: string, platform: NodeJS.Platform): boolean {
	return createBuiltinConnectorPlugins(platform).some(
		(plugin) => plugin.id === connectorId,
	);
}

async function formatSecretPresence(
	secrets: SecretsStore,
	paths: AppPaths,
	name: string,
): Promise<string> {
	return (await secrets.hasSecret(name, paths)) ? "<set>" : "<unset>";
}

type ConfigValueReader = (context: {
	config: SyncdownConfig;
	paths: AppPaths;
	secrets: SecretsStore;
}) => Promise<string> | string;

function getIntegrationReaders(
	connectorId:
		| "notion"
		| "gmail"
		| "google-calendar"
		| "google-contacts"
		| "apple-notes"
		| "todoist"
		| "google-keep",
	prefix: string,
): Array<[string, ConfigValueReader]> {
	return [
		[
			`${prefix}.enabled`,
			({ config }) =>
				String(getDefaultIntegration(config, connectorId).enabled),
		],
		[
			`${prefix}.interval`,
			({ config }) => getDefaultIntegration(config, connectorId).interval,
		],
	];
}

export function getConfigReaders(
	platform: NodeJS.Platform = process.platform,
): Map<string, ConfigValueReader> {
	const readers = new Map<string, ConfigValueReader>([
		["outputDir", ({ config }) => config.outputDir ?? "<unset>"],
		...getIntegrationReaders("notion", "notion"),
		["notion.authMethod", ({ config }) => getNotionAuthMethod(config)],
		[
			"notion.token",
			({ secrets, paths }) =>
				formatSecretPresence(secrets, paths, NOTION_TOKEN_SECRET_NAME),
		],
		[
			"notion.oauth.clientId",
			({ secrets, paths }) =>
				formatSecretPresence(
					secrets,
					paths,
					NOTION_OAUTH_APP_SECRET_NAMES.clientId,
				),
		],
		[
			"notion.oauth.clientSecret",
			({ secrets, paths }) =>
				formatSecretPresence(
					secrets,
					paths,
					NOTION_OAUTH_APP_SECRET_NAMES.clientSecret,
				),
		],
		[
			"notion.oauth.refreshToken",
			({ secrets, paths }) =>
				formatSecretPresence(
					secrets,
					paths,
					NOTION_OAUTH_CONNECTION_SECRET_NAMES.refreshToken,
				),
		],
		...getIntegrationReaders("gmail", "gmail"),
		["gmail.syncFilter", ({ config }) => getGmailSettings(config).syncFilter],
		[
			"gmail.fetchConcurrency",
			({ config }) => String(getGmailSettings(config).fetchConcurrency),
		],
		[
			GOOGLE_SECRET_NAMES.clientId,
			({ secrets, paths }) =>
				formatSecretPresence(secrets, paths, GOOGLE_SECRET_NAMES.clientId),
		],
		[
			GOOGLE_SECRET_NAMES.clientSecret,
			({ secrets, paths }) =>
				formatSecretPresence(secrets, paths, GOOGLE_SECRET_NAMES.clientSecret),
		],
		[
			GOOGLE_SECRET_NAMES.refreshToken,
			({ secrets, paths }) =>
				formatSecretPresence(secrets, paths, GOOGLE_SECRET_NAMES.refreshToken),
		],
		...getIntegrationReaders("google-calendar", "googleCalendar"),
		[
			"googleCalendar.selectedCalendarIds",
			({ config }) => getSelectedCalendarIds(config).join(","),
		],
		...getIntegrationReaders("google-contacts", "googleContacts"),
	]);

	if (hasConnector("apple-notes", platform)) {
		for (const [key, reader] of getIntegrationReaders(
			"apple-notes",
			"appleNotes",
		)) {
			readers.set(key, reader);
		}
	}

	if (hasConnector("todoist", platform)) {
		for (const [key, reader] of getIntegrationReaders("todoist", "todoist")) {
			readers.set(key, reader);
		}
		readers.set("todoist.token", async ({ config, secrets, paths }) => {
			const secretName = getTodoistTokenSecretName(config);
			if (!secretName) {
				return "<unset>";
			}
			return formatSecretPresence(secrets, paths, secretName);
		});
	}

	if (hasConnector("google-keep", platform)) {
		for (const [key, reader] of getIntegrationReaders(
			"google-keep",
			"googleKeep",
		)) {
			readers.set(key, reader);
		}
		readers.set("googleKeep.token", async ({ config, secrets, paths }) => {
			const connection = config.connections.find(
				(candidate) => candidate.kind === "google-keep-token",
			);
			if (!connection) {
				return "<unset>";
			}
			return formatSecretPresence(secrets, paths, connection.id);
		});
		readers.set("googleKeep.email", ({ config }) => {
			const connection = config.connections.find(
				(candidate) => candidate.kind === "google-keep-token",
			);
			if (!connection || connection.kind !== "google-keep-token") {
				return "<unset>";
			}
			return connection.accountEmail?.trim() || "<unset>";
		});
	}

	return readers;
}

export async function handleConfigGet(
	io: AppIo,
	key: string | undefined,
	context: {
		config: SyncdownConfig;
		paths: AppPaths;
		secrets: SecretsStore;
	},
): Promise<number> {
	const readers = getConfigReaders();
	if (!key || !readers.has(key)) {
		if (key) {
			io.error(`Unknown config key: ${key}`);
		}
		io.error(`Usage: syncdown config get <${[...readers.keys()].join("|")}>`);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const reader = readers.get(key);
	if (!reader) {
		return EXIT_CODES.CONFIG_ERROR;
	}
	io.write(await reader(context));
	return EXIT_CODES.OK;
}

export async function handleConfigShow(
	io: AppIo,
	context: {
		config: SyncdownConfig;
		paths: AppPaths;
		secrets: SecretsStore;
	},
): Promise<number> {
	io.write(`config: ${context.paths.configPath}`);
	for (const [key, reader] of getConfigReaders()) {
		io.write(`${key}=${await reader(context)}`);
	}
	return EXIT_CODES.OK;
}
