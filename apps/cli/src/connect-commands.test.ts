import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createBuiltinConnectorPlugins } from "@syncdown/connectors";
import {
	type AppIo,
	type AppPaths,
	DEFAULT_NOTION_OAUTH_CONNECTION_ID,
	DEFAULT_NOTION_TOKEN_CONNECTION_ID,
	EXIT_CODES,
	ensureConfig as ensureConfigBase,
	GOOGLE_SECRET_NAMES,
	getDefaultIntegration,
	resolveAppPaths,
	type SecretsStore,
	writeConfig,
} from "@syncdown/core";
import type { TuiAuthService } from "@syncdown/tui";

function ensureConfig(paths: AppPaths) {
	return ensureConfigBase(paths, createBuiltinConnectorPlugins());
}

import {
	handleCalendarsCommand,
	handleConnectCommand,
	handleDisconnectCommand,
} from "./connect-commands.js";

function createIoCapture(): { io: AppIo; writes: string[]; errors: string[] } {
	const writes: string[] = [];
	const errors: string[] = [];

	return {
		io: {
			write(line) {
				writes.push(line);
			},
			error(line) {
				errors.push(line);
			},
		},
		writes,
		errors,
	};
}

function createMemorySecrets(initial: Record<string, string> = {}): {
	secrets: SecretsStore;
	values: Map<string, string>;
} {
	const values = new Map(Object.entries(initial));
	return {
		secrets: {
			async hasSecret(name) {
				return values.has(name);
			},
			async getSecret(name) {
				return values.get(name) ?? null;
			},
			async setSecret(name, value) {
				values.set(name, value);
			},
			async deleteSecret(name) {
				values.delete(name);
			},
			describe() {
				return "memory";
			},
		},
		values,
	};
}

function createAuthServiceStub(
	overrides: Partial<TuiAuthService> = {},
): TuiAuthService {
	return {
		async openUrl() {
			return { opened: false };
		},
		async startGoogleSession() {
			throw new Error("startGoogleSession should not be called");
		},
		async startNotionOAuthSession() {
			throw new Error("startNotionOAuthSession should not be called");
		},
		async openNotionSetup() {
			return { opened: false };
		},
		async openNotionOAuthSetup() {
			return { opened: false };
		},
		async openGoogleOAuthSetup() {
			return { opened: false };
		},
		async validateNotionToken() {},
		async validateNotionOAuthAccessToken() {},
		async validateGoogleCredentials() {},
		...overrides,
	};
}

async function withTempCliPaths<T>(
	callback: (paths: AppPaths) => Promise<T>,
): Promise<T> {
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	const previousDataHome = process.env.XDG_DATA_HOME;
	const root = mkdtempSync(path.join("/tmp", "syncdown-connect-test-"));
	process.env.XDG_CONFIG_HOME = path.join(root, "config");
	process.env.XDG_DATA_HOME = path.join(root, "data");

	try {
		return await callback(resolveAppPaths());
	} finally {
		if (previousConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = previousConfigHome;
		}
		if (previousDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = previousDataHome;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

function connectArgv(...args: string[]): string[] {
	return ["syncdown", "syncdown", ...args];
}

test("connect notion --token validates, stores the secret, and enables notion", async () => {
	const { io, writes, errors } = createIoCapture();
	const { secrets, values } = createMemorySecrets();
	const validatedTokens: string[] = [];
	const authService = createAuthServiceStub({
		async validateNotionToken(_paths, token) {
			validatedTokens.push(token);
		},
	});

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "notion", "--token", "secret-token"),
			secrets,
			{ authService },
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(validatedTokens).toEqual(["secret-token"]);
		expect(
			values.get(`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`),
		).toBe("secret-token");
		const config = await ensureConfig(paths);
		const notion = getDefaultIntegration(config, "notion");
		expect(notion.enabled).toBe(true);
		expect(notion.connectionId).toBe(DEFAULT_NOTION_TOKEN_CONNECTION_ID);
		expect(writes).toContain("Notion connected via token. notion.enabled=true");
	});
});

test("connect notion --token surfaces validation failures without saving", async () => {
	const { io, errors } = createIoCapture();
	const { secrets, values } = createMemorySecrets();
	const authService = createAuthServiceStub({
		async validateNotionToken() {
			throw new Error("Notion rejected the token.");
		},
	});

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "notion", "--token", "bad-token"),
			secrets,
			{ authService },
		);

		expect(exitCode).toBe(EXIT_CODES.VALIDATION_ERROR);
		expect(errors).toContain("Notion rejected the token.");
		expect(values.size).toBe(0);
		const config = await ensureConfig(paths);
		expect(getDefaultIntegration(config, "notion").enabled).toBe(false);
	});
});

test("connect notion --oauth stores secrets, metadata, and switches to oauth", async () => {
	const { io, writes } = createIoCapture();
	const { secrets, values } = createMemorySecrets({
		"oauthApps.notion-oauth-app-default.clientId": "notion-client",
		"oauthApps.notion-oauth-app-default.clientSecret": "notion-secret",
	});
	const authService = createAuthServiceStub({
		async startNotionOAuthSession() {
			return {
				authorizationUrl: "https://notion.example/auth",
				browserOpened: false,
				complete: async () => ({
					accessToken: "access-token",
					refreshToken: "refresh-token",
					workspaceId: "ws-1",
					workspaceName: "Acme Workspace",
					botId: "bot-1",
					ownerUserId: "user-1",
					ownerUserName: "Ada",
				}),
				cancel: async () => {},
			};
		},
	});

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "notion", "--oauth"),
			secrets,
			{ authService },
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(
			values.get(
				`connections.${DEFAULT_NOTION_OAUTH_CONNECTION_ID}.refreshToken`,
			),
		).toBe("refresh-token");
		const config = await ensureConfig(paths);
		const notion = getDefaultIntegration(config, "notion");
		expect(notion.enabled).toBe(true);
		expect(notion.connectionId).toBe(DEFAULT_NOTION_OAUTH_CONNECTION_ID);
		const connection = config.connections.find(
			(candidate) => candidate.id === DEFAULT_NOTION_OAUTH_CONNECTION_ID,
		);
		if (!connection || connection.kind !== "notion-oauth-account") {
			throw new Error("expected notion oauth connection");
		}
		expect(connection.workspaceName).toBe("Acme Workspace");
		expect(writes.some((line) => line.includes("Acme Workspace"))).toBe(true);
	});
});

test("connect notion --oauth requires stored client credentials", async () => {
	const { io, errors } = createIoCapture();
	const { secrets } = createMemorySecrets();

	await withTempCliPaths(async () => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "notion", "--oauth"),
			secrets,
			{ authService: createAuthServiceStub() },
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain("Notion OAuth client credentials are missing.");
	});
});

test("connect google runs the loopback flow and stores the refresh token", async () => {
	const { io, writes, errors } = createIoCapture();
	const { secrets, values } = createMemorySecrets({
		[GOOGLE_SECRET_NAMES.clientId]: "google-client",
		[GOOGLE_SECRET_NAMES.clientSecret]: "google-secret",
	});
	const requestedScopes: string[][] = [];
	const authService = createAuthServiceStub({
		async startGoogleSession(_clientId, _clientSecret, scopes) {
			requestedScopes.push(scopes);
			return {
				authorizationUrl: "https://accounts.google.example/auth",
				browserOpened: false,
				complete: async () => ({ refreshToken: "google-refresh" }),
				cancel: async () => {},
			};
		},
	});

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "google", "--enable", "gmail,google-calendar"),
			secrets,
			{ authService },
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(values.get(GOOGLE_SECRET_NAMES.refreshToken)).toBe("google-refresh");
		expect(requestedScopes[0]?.length).toBeGreaterThan(0);
		const config = await ensureConfig(paths);
		expect(getDefaultIntegration(config, "gmail").enabled).toBe(true);
		expect(getDefaultIntegration(config, "google-calendar").enabled).toBe(true);
		expect(getDefaultIntegration(config, "google-contacts").enabled).toBe(
			false,
		);
		expect(writes).toContain("Google account connected.");
		expect(writes).toContain("https://accounts.google.example/auth");
	});
});

test("connect google requires stored client credentials", async () => {
	const { io, errors } = createIoCapture();
	const { secrets } = createMemorySecrets();

	await withTempCliPaths(async () => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "google"),
			secrets,
			{ authService: createAuthServiceStub() },
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain("Google OAuth client credentials are missing.");
	});
});

test("connect google rejects unknown connector ids", async () => {
	const { io, errors } = createIoCapture();
	const { secrets } = createMemorySecrets();

	await withTempCliPaths(async () => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "google", "--connector", "dropbox"),
			secrets,
			{ authService: createAuthServiceStub() },
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(
			errors.some((line) => line.includes("Unknown Google connector")),
		).toBe(true);
	});
});

test("connect todoist --token stores the secret and enables todoist", async () => {
	const { io, writes } = createIoCapture();
	const { secrets, values } = createMemorySecrets();

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleConnectCommand(
			io,
			connectArgv("connect", "todoist", "--token", "todoist-token"),
			secrets,
			{ authService: createAuthServiceStub() },
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(values.get("todoist-token-default")).toBe("todoist-token");
		const config = await ensureConfig(paths);
		expect(getDefaultIntegration(config, "todoist").enabled).toBe(true);
		expect(writes).toContain(
			"Todoist connected via token. todoist.enabled=true",
		);
	});
});

test("disconnect google deletes credentials and disables google connectors", async () => {
	const { io, writes } = createIoCapture();
	const { secrets, values } = createMemorySecrets({
		[GOOGLE_SECRET_NAMES.clientId]: "google-client",
		[GOOGLE_SECRET_NAMES.clientSecret]: "google-secret",
		[GOOGLE_SECRET_NAMES.refreshToken]: "google-refresh",
	});

	await withTempCliPaths(async (paths) => {
		const config = await ensureConfig(paths);
		getDefaultIntegration(config, "gmail").enabled = true;
		getDefaultIntegration(config, "google-calendar").enabled = true;
		await writeConfig(paths, config);

		const exitCode = await handleDisconnectCommand(
			io,
			connectArgv("disconnect", "google"),
			secrets,
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(values.size).toBe(0);
		const updated = await ensureConfig(paths);
		expect(getDefaultIntegration(updated, "gmail").enabled).toBe(false);
		expect(getDefaultIntegration(updated, "google-calendar").enabled).toBe(
			false,
		);
		expect(getDefaultIntegration(updated, "google-contacts").enabled).toBe(
			false,
		);
		expect(writes.some((line) => line.includes("Disconnected Google"))).toBe(
			true,
		);
	});
});

test("disconnect notion deletes token and oauth credentials", async () => {
	const { io } = createIoCapture();
	const { secrets, values } = createMemorySecrets({
		[`connections.${DEFAULT_NOTION_TOKEN_CONNECTION_ID}.token`]: "tok",
		"oauthApps.notion-oauth-app-default.clientId": "cid",
		"oauthApps.notion-oauth-app-default.clientSecret": "cs",
		[`connections.${DEFAULT_NOTION_OAUTH_CONNECTION_ID}.refreshToken`]: "rt",
	});

	await withTempCliPaths(async (paths) => {
		const exitCode = await handleDisconnectCommand(
			io,
			connectArgv("disconnect", "notion"),
			secrets,
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(values.size).toBe(0);
		const config = await ensureConfig(paths);
		expect(getDefaultIntegration(config, "notion").enabled).toBe(false);
	});
});

test("disconnect rejects unknown providers", async () => {
	const { io, errors } = createIoCapture();
	const { secrets } = createMemorySecrets();

	await withTempCliPaths(async () => {
		const exitCode = await handleDisconnectCommand(
			io,
			connectArgv("disconnect", "dropbox"),
			secrets,
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain(
			"Usage: syncdown disconnect <google|notion|todoist>",
		);
	});
});

test("calendars lists calendars with selection markers", async () => {
	const { io, writes } = createIoCapture();
	const { secrets } = createMemorySecrets({
		[GOOGLE_SECRET_NAMES.clientId]: "google-client",
		[GOOGLE_SECRET_NAMES.clientSecret]: "google-secret",
		[GOOGLE_SECRET_NAMES.refreshToken]: "google-refresh",
	});
	const authService = createAuthServiceStub({
		async listGoogleCalendars() {
			return [
				{ id: "primary", summary: "Personal", primary: true },
				{ id: "work@example.com", summary: "Work" },
			];
		},
	});

	await withTempCliPaths(async (paths) => {
		const config = await ensureConfig(paths);
		const calendar = getDefaultIntegration(config, "google-calendar");
		if (calendar.connectorId !== "google-calendar") {
			throw new Error("expected calendar integration");
		}
		calendar.config.selectedCalendarIds = ["work@example.com"];
		await writeConfig(paths, config);

		const exitCode = await handleCalendarsCommand(
			io,
			connectArgv("calendars"),
			secrets,
			{ authService },
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(writes).toContain("[ ] primary  Personal (primary)");
		expect(writes).toContain("[x] work@example.com  Work");
	});
});

test("calendars requires google credentials", async () => {
	const { io, errors } = createIoCapture();
	const { secrets } = createMemorySecrets();

	await withTempCliPaths(async () => {
		const exitCode = await handleCalendarsCommand(
			io,
			connectArgv("calendars"),
			secrets,
			{ authService: createAuthServiceStub() },
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(
			errors.some((line) =>
				line.includes("Connect Google first: syncdown connect google"),
			),
		).toBe(true);
	});
});
