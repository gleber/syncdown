import { createBuiltinConnectorPlugins } from "@syncdown/connectors";
import type {
	AppIo,
	NotionOAuthConnectionConfig,
	SecretsStore,
	SyncdownConfig,
} from "@syncdown/core";
import {
	collectGoogleProviderScopes,
	DEFAULT_NOTION_OAUTH_APP_ID,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	GOOGLE_SECRET_NAMES,
	getDefaultIntegration,
	getGoogleAuthConnectors,
	getNotionOAuthAppSecretNames,
	getNotionOAuthConnectionSecretNames,
	readGoogleCredentials,
	writeConfig,
} from "@syncdown/core";
import { createTuiAuthService, type TuiAuthService } from "@syncdown/tui";

import { loadConfig, readValueFromStdin } from "./config-commands.js";

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const NOTION_TOKEN_SECRET_NAME = `connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`;
const NOTION_OAUTH_APP_SECRET_NAMES = getNotionOAuthAppSecretNames(
	DEFAULT_NOTION_OAUTH_APP_ID,
);
const NOTION_OAUTH_CONNECTION_SECRET_NAMES =
	getNotionOAuthConnectionSecretNames(DEFAULT_NOTION_OAUTH_CONNECTION_ID);

export interface ConnectDependencies {
	authService?: TuiAuthService;
}

function getAuthService(
	dependencies: ConnectDependencies,
	options: { openBrowser?: boolean } = {},
): TuiAuthService {
	if (dependencies.authService) {
		return dependencies.authService;
	}
	if (options.openBrowser === false) {
		return createTuiAuthService({
			browserOpener: {
				async open() {
					throw new Error("Browser launch disabled by --no-browser.");
				},
			},
		});
	}
	return createTuiAuthService();
}

function toErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function parseCommaList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

interface ParsedFlags {
	flags: Map<string, string | true>;
	error?: string;
}

function parseFlags(
	args: string[],
	valueFlags: readonly string[],
	booleanFlags: readonly string[],
): ParsedFlags {
	const flags = new Map<string, string | true>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (booleanFlags.includes(arg)) {
			flags.set(arg, true);
			continue;
		}
		if (valueFlags.includes(arg)) {
			const value = args[index + 1];
			if (value === undefined) {
				return { flags, error: `${arg} requires a value.` };
			}
			flags.set(arg, value);
			index += 1;
			continue;
		}
		return { flags, error: `Unknown argument: ${arg}` };
	}
	return { flags };
}

function printConnectUsage(io: AppIo): void {
	for (const line of [
		"Usage:",
		"  syncdown connect google [--connector <gmail,google-calendar,google-contacts>] [--enable <ids>] [--client-id <id>] [--client-secret <secret>] [--no-browser]",
		"  syncdown connect notion --token <value|--stdin>",
		"  syncdown connect notion --oauth [--client-id <id>] [--client-secret <secret>] [--no-browser]",
		"  syncdown connect todoist --token <value|--stdin>",
	]) {
		io.error(line);
	}
}

function printDisconnectUsage(io: AppIo): void {
	io.error("Usage: syncdown disconnect <google|notion|todoist>");
}

async function resolveTokenValue(rawValue: string): Promise<string> {
	return rawValue === "--stdin" ? await readValueFromStdin() : rawValue;
}

function announceAuthSession(
	io: AppIo,
	session: {
		authorizationUrl: string;
		browserOpened: boolean;
		browserError?: string;
	},
): void {
	io.write("Open this URL to authorize:");
	io.write(session.authorizationUrl);
	if (session.browserOpened) {
		io.write("Opened your browser. Complete the login there.");
	} else if (session.browserError) {
		io.write(`Could not open a browser automatically: ${session.browserError}`);
	}
	io.write("Waiting for the login to complete (5 minute timeout)...");
}

function getGoogleConnectorIds(): string[] {
	return getGoogleAuthConnectors(createBuiltinConnectorPlugins()).map(
		(connector) => connector.id,
	);
}

async function connectGoogle(
	io: AppIo,
	args: string[],
	secrets: SecretsStore,
	dependencies: ConnectDependencies,
): Promise<number> {
	const { flags, error } = parseFlags(
		args,
		["--connector", "--enable", "--client-id", "--client-secret"],
		["--no-browser"],
	);
	if (error) {
		io.error(error);
		printConnectUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const googleConnectors = getGoogleAuthConnectors(
		createBuiltinConnectorPlugins(),
	);
	const googleConnectorIds = googleConnectors.map((connector) => connector.id);
	const connectorFlag = flags.get("--connector");
	const requestedIds =
		typeof connectorFlag === "string"
			? parseCommaList(connectorFlag)
			: googleConnectorIds;
	const enableFlag = flags.get("--enable");
	const enableIds =
		typeof enableFlag === "string" ? parseCommaList(enableFlag) : [];
	for (const id of [...requestedIds, ...enableIds]) {
		if (!googleConnectorIds.includes(id)) {
			io.error(
				`Unknown Google connector: ${id}. Expected one of: ${googleConnectorIds.join(", ")}.`,
			);
			return EXIT_CODES.CONFIG_ERROR;
		}
	}

	const { config, paths } = await loadConfig();
	const clientIdFlag = flags.get("--client-id");
	const clientSecretFlag = flags.get("--client-secret");
	const clientId =
		typeof clientIdFlag === "string"
			? clientIdFlag
			: await secrets.getSecret(GOOGLE_SECRET_NAMES.clientId, paths);
	const clientSecret =
		typeof clientSecretFlag === "string"
			? clientSecretFlag
			: await secrets.getSecret(GOOGLE_SECRET_NAMES.clientSecret, paths);
	if (!clientId || !clientSecret) {
		io.error("Google OAuth client credentials are missing.");
		io.error(
			`Store them first: printf '%s' "$GOOGLE_CLIENT_ID" | syncdown config set ${GOOGLE_SECRET_NAMES.clientId} --stdin`,
		);
		io.error(
			`And: printf '%s' "$GOOGLE_CLIENT_SECRET" | syncdown config set ${GOOGLE_SECRET_NAMES.clientSecret} --stdin`,
		);
		io.error("Or pass --client-id/--client-secret.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const scopes = collectGoogleProviderScopes(
		googleConnectors.map((connector) => ({ ...connector, enabled: false })),
		{ includeIds: requestedIds },
	);

	const authService = getAuthService(dependencies, {
		openBrowser: flags.get("--no-browser") !== true,
	});
	try {
		const session = await authService.startGoogleSession(
			clientId,
			clientSecret,
			scopes,
		);
		announceAuthSession(io, session);
		const { refreshToken } = await session.complete(AUTH_TIMEOUT_MS);
		await authService.validateGoogleCredentials(
			paths,
			{ clientId, clientSecret, refreshToken },
			scopes,
		);
		if (typeof clientIdFlag === "string") {
			await secrets.setSecret(GOOGLE_SECRET_NAMES.clientId, clientId, paths);
		}
		if (typeof clientSecretFlag === "string") {
			await secrets.setSecret(
				GOOGLE_SECRET_NAMES.clientSecret,
				clientSecret,
				paths,
			);
		}
		await secrets.setSecret(
			GOOGLE_SECRET_NAMES.refreshToken,
			refreshToken,
			paths,
		);
	} catch (error) {
		io.error(toErrorMessage(error, "Google login failed."));
		return EXIT_CODES.GENERAL_ERROR;
	}

	for (const id of enableIds) {
		getDefaultIntegration(config, id).enabled = true;
	}
	if (enableIds.length > 0) {
		await writeConfig(paths, config);
	}

	io.write("Google account connected.");
	if (enableIds.length > 0) {
		io.write(`Enabled: ${enableIds.join(", ")}`);
	} else {
		io.write(
			"Enable connectors with e.g. `syncdown config set gmail.enabled true`.",
		);
	}
	return EXIT_CODES.OK;
}

function getNotionOAuthConnection(
	config: SyncdownConfig,
): NotionOAuthConnectionConfig | null {
	const connection = config.connections.find(
		(candidate) => candidate.id === DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	);
	return connection && connection.kind === "notion-oauth-account"
		? connection
		: null;
}

async function connectNotionToken(
	io: AppIo,
	rawValue: string | undefined,
	secrets: SecretsStore,
	dependencies: ConnectDependencies,
): Promise<number> {
	if (!rawValue) {
		printConnectUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const token = await resolveTokenValue(rawValue);
	if (!token) {
		io.error("notion token cannot be empty.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const { config, paths } = await loadConfig();
	const authService = getAuthService(dependencies);
	try {
		await authService.validateNotionToken(paths, token);
	} catch (error) {
		io.error(toErrorMessage(error, "Notion token validation failed."));
		return EXIT_CODES.VALIDATION_ERROR;
	}

	await secrets.setSecret(NOTION_TOKEN_SECRET_NAME, token, paths);
	const integration = getDefaultIntegration(config, "notion");
	integration.connectionId = DEFAULT_NOTION_TOKEN_CONNECTION_ID;
	integration.enabled = true;
	await writeConfig(paths, config);
	io.write("Notion connected via token. notion.enabled=true");
	return EXIT_CODES.OK;
}

async function connectNotionOAuth(
	io: AppIo,
	flags: Map<string, string | true>,
	secrets: SecretsStore,
	dependencies: ConnectDependencies,
): Promise<number> {
	const { config, paths } = await loadConfig();
	const clientIdFlag = flags.get("--client-id");
	const clientSecretFlag = flags.get("--client-secret");
	const clientId =
		typeof clientIdFlag === "string"
			? clientIdFlag
			: await secrets.getSecret(NOTION_OAUTH_APP_SECRET_NAMES.clientId, paths);
	const clientSecret =
		typeof clientSecretFlag === "string"
			? clientSecretFlag
			: await secrets.getSecret(
					NOTION_OAUTH_APP_SECRET_NAMES.clientSecret,
					paths,
				);
	if (!clientId || !clientSecret) {
		io.error("Notion OAuth client credentials are missing.");
		io.error(
			"Store them first: printf '%s' \"$NOTION_CLIENT_ID\" | syncdown config set notion.oauth.clientId --stdin",
		);
		io.error(
			"And: printf '%s' \"$NOTION_CLIENT_SECRET\" | syncdown config set notion.oauth.clientSecret --stdin",
		);
		io.error("Or pass --client-id/--client-secret.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const authService = getAuthService(dependencies, {
		openBrowser: flags.get("--no-browser") !== true,
	});
	let result: Awaited<
		ReturnType<
			Awaited<ReturnType<TuiAuthService["startNotionOAuthSession"]>>["complete"]
		>
	>;
	try {
		const session = await authService.startNotionOAuthSession(
			clientId,
			clientSecret,
		);
		announceAuthSession(io, session);
		result = await session.complete(AUTH_TIMEOUT_MS);
		await authService.validateNotionOAuthAccessToken(paths, result.accessToken);
	} catch (error) {
		io.error(toErrorMessage(error, "Notion login failed."));
		return EXIT_CODES.GENERAL_ERROR;
	}

	await secrets.setSecret(
		NOTION_OAUTH_APP_SECRET_NAMES.clientId,
		clientId,
		paths,
	);
	await secrets.setSecret(
		NOTION_OAUTH_APP_SECRET_NAMES.clientSecret,
		clientSecret,
		paths,
	);
	await secrets.setSecret(
		NOTION_OAUTH_CONNECTION_SECRET_NAMES.refreshToken,
		result.refreshToken,
		paths,
	);

	const connection = getNotionOAuthConnection(config);
	if (connection) {
		connection.workspaceId = result.workspaceId;
		connection.workspaceName = result.workspaceName;
		connection.botId = result.botId;
		connection.ownerUserId = result.ownerUserId;
		connection.ownerUserName = result.ownerUserName;
	}
	const integration = getDefaultIntegration(config, "notion");
	integration.connectionId = DEFAULT_NOTION_OAUTH_CONNECTION_ID;
	integration.enabled = true;
	await writeConfig(paths, config);
	io.write(
		`Notion connected via OAuth${result.workspaceName ? ` (workspace: ${result.workspaceName})` : ""}. notion.enabled=true`,
	);
	return EXIT_CODES.OK;
}

async function connectNotion(
	io: AppIo,
	args: string[],
	secrets: SecretsStore,
	dependencies: ConnectDependencies,
): Promise<number> {
	if (args[0] === "--token") {
		return connectNotionToken(io, args[1], secrets, dependencies);
	}
	if (args[0] === "--oauth") {
		const { flags, error } = parseFlags(
			args.slice(1),
			["--client-id", "--client-secret"],
			["--no-browser"],
		);
		if (error) {
			io.error(error);
			printConnectUsage(io);
			return EXIT_CODES.CONFIG_ERROR;
		}
		return connectNotionOAuth(io, flags, secrets, dependencies);
	}

	printConnectUsage(io);
	return EXIT_CODES.CONFIG_ERROR;
}

function getTodoistTokenSecretName(config: SyncdownConfig): string | null {
	const connection = config.connections.find(
		(candidate) => candidate.kind === "todoist-token",
	);
	return connection ? connection.id : null;
}

async function connectTodoist(
	io: AppIo,
	args: string[],
	secrets: SecretsStore,
): Promise<number> {
	if (args[0] !== "--token" || !args[1]) {
		printConnectUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}

	const token = await resolveTokenValue(args[1]);
	if (!token) {
		io.error("todoist token cannot be empty.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const { config, paths } = await loadConfig();
	const secretName = getTodoistTokenSecretName(config);
	if (!secretName) {
		io.error("Missing default Todoist connection.");
		return EXIT_CODES.CONFIG_ERROR;
	}

	await secrets.setSecret(secretName, token, paths);
	getDefaultIntegration(config, "todoist").enabled = true;
	await writeConfig(paths, config);
	io.write("Todoist connected via token. todoist.enabled=true");
	return EXIT_CODES.OK;
}

export async function handleConnectCommand(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore,
	dependencies: ConnectDependencies = {},
): Promise<number> {
	const provider = argv[3];
	const args = argv.slice(4);
	if (provider === "google") {
		return connectGoogle(io, args, secrets, dependencies);
	}
	if (provider === "notion") {
		return connectNotion(io, args, secrets, dependencies);
	}
	if (provider === "todoist") {
		return connectTodoist(io, args, secrets);
	}

	printConnectUsage(io);
	return EXIT_CODES.CONFIG_ERROR;
}

async function disconnectGoogle(
	io: AppIo,
	secrets: SecretsStore,
): Promise<number> {
	const { config, paths } = await loadConfig();
	await secrets.deleteSecret(GOOGLE_SECRET_NAMES.clientId, paths);
	await secrets.deleteSecret(GOOGLE_SECRET_NAMES.clientSecret, paths);
	await secrets.deleteSecret(GOOGLE_SECRET_NAMES.refreshToken, paths);
	for (const id of getGoogleConnectorIds()) {
		getDefaultIntegration(config, id).enabled = false;
	}
	await writeConfig(paths, config);
	io.write("Disconnected Google. Deleted stored Google credentials.");
	io.write(`Disabled: ${getGoogleConnectorIds().join(", ")}`);
	return EXIT_CODES.OK;
}

async function disconnectNotion(
	io: AppIo,
	secrets: SecretsStore,
): Promise<number> {
	const { config, paths } = await loadConfig();
	await secrets.deleteSecret(NOTION_TOKEN_SECRET_NAME, paths);
	await secrets.deleteSecret(NOTION_OAUTH_APP_SECRET_NAMES.clientId, paths);
	await secrets.deleteSecret(NOTION_OAUTH_APP_SECRET_NAMES.clientSecret, paths);
	await secrets.deleteSecret(
		NOTION_OAUTH_CONNECTION_SECRET_NAMES.refreshToken,
		paths,
	);
	getDefaultIntegration(config, "notion").enabled = false;
	await writeConfig(paths, config);
	io.write("Disconnected Notion. Deleted stored Notion credentials.");
	io.write("Disabled: notion");
	return EXIT_CODES.OK;
}

async function disconnectTodoist(
	io: AppIo,
	secrets: SecretsStore,
): Promise<number> {
	const { config, paths } = await loadConfig();
	const secretName = getTodoistTokenSecretName(config);
	if (secretName) {
		await secrets.deleteSecret(secretName, paths);
	}
	getDefaultIntegration(config, "todoist").enabled = false;
	await writeConfig(paths, config);
	io.write("Disconnected Todoist. Deleted stored Todoist credentials.");
	io.write("Disabled: todoist");
	return EXIT_CODES.OK;
}

export async function handleDisconnectCommand(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore,
): Promise<number> {
	const provider = argv[3];
	if (argv.length > 4) {
		printDisconnectUsage(io);
		return EXIT_CODES.CONFIG_ERROR;
	}
	if (provider === "google") {
		return disconnectGoogle(io, secrets);
	}
	if (provider === "notion") {
		return disconnectNotion(io, secrets);
	}
	if (provider === "todoist") {
		return disconnectTodoist(io, secrets);
	}

	printDisconnectUsage(io);
	return EXIT_CODES.CONFIG_ERROR;
}

export async function handleCalendarsCommand(
	io: AppIo,
	argv: string[],
	secrets: SecretsStore,
	dependencies: ConnectDependencies = {},
): Promise<number> {
	const subcommand = argv[3] ?? "list";
	if (subcommand !== "list") {
		io.error("Usage: syncdown calendars [list]");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const { config, paths } = await loadConfig();
	let credentials: Awaited<ReturnType<typeof readGoogleCredentials>>;
	try {
		credentials = await readGoogleCredentials(secrets, paths);
	} catch (error) {
		io.error(toErrorMessage(error, "Google credentials are missing."));
		io.error("Connect Google first: syncdown connect google");
		return EXIT_CODES.CONFIG_ERROR;
	}

	const authService = getAuthService(dependencies);
	if (!authService.listGoogleCalendars) {
		io.error("Calendar listing is unavailable.");
		return EXIT_CODES.GENERAL_ERROR;
	}

	let calendars: Awaited<
		ReturnType<NonNullable<TuiAuthService["listGoogleCalendars"]>>
	>;
	try {
		calendars = await authService.listGoogleCalendars(credentials);
	} catch (error) {
		io.error(toErrorMessage(error, "Failed to list Google calendars."));
		return EXIT_CODES.GENERAL_ERROR;
	}

	const integration = getDefaultIntegration(config, "google-calendar");
	const selected = new Set(
		integration.connectorId === "google-calendar"
			? integration.config.selectedCalendarIds
			: [],
	);
	for (const calendar of calendars) {
		const marker = selected.has(calendar.id) ? "[x]" : "[ ]";
		const primary = calendar.primary ? " (primary)" : "";
		io.write(`${marker} ${calendar.id}  ${calendar.summary}${primary}`);
	}
	io.write("");
	io.write(
		"Select calendars with: syncdown config set googleCalendar.selectedCalendarIds <id1,id2>",
	);
	return EXIT_CODES.OK;
}
