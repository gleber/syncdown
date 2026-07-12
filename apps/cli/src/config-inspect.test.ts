import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import {
	type AppIo,
	type AppPaths,
	EXIT_CODES,
	resolveAppPaths,
	type SecretsStore,
} from "@syncdown/core";

import { handleConfigCommand } from "./config-commands.js";

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

function createMemorySecrets(
	initial: Record<string, string> = {},
): SecretsStore {
	const values = new Map(Object.entries(initial));
	return {
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
	};
}

async function withTempCliPaths<T>(
	callback: (paths: AppPaths) => Promise<T>,
): Promise<T> {
	const previousConfigHome = process.env.XDG_CONFIG_HOME;
	const previousDataHome = process.env.XDG_DATA_HOME;
	const root = mkdtempSync(path.join("/tmp", "syncdown-inspect-test-"));
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

test("config show prints all config keys with secret presence", async () => {
	const { io, writes, errors } = createIoCapture();
	const secrets = createMemorySecrets({
		"oauthApps.google-default.clientId": "google-client",
	});

	await withTempCliPaths(async () => {
		const exitCode = await handleConfigCommand(
			io,
			["syncdown", "syncdown", "config", "show"],
			secrets,
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(writes).toContain("outputDir=<unset>");
		expect(writes).toContain("notion.enabled=false");
		expect(writes).toContain("notion.authMethod=token");
		expect(writes).toContain("gmail.syncFilter=primary");
		expect(writes).toContain("gmail.fetchConcurrency=10");
		expect(writes).toContain("oauthApps.google-default.clientId=<set>");
		expect(writes).toContain("oauthApps.google-default.clientSecret=<unset>");
		expect(writes).toContain("googleCalendar.selectedCalendarIds=");
		expect(writes).toContain("todoist.enabled=false");
		expect(writes).toContain("todoist.token=<unset>");
	});
});

test("config get reads a single value", async () => {
	const { io, writes, errors } = createIoCapture();

	await withTempCliPaths(async () => {
		const exitCode = await handleConfigCommand(
			io,
			["syncdown", "syncdown", "config", "get", "gmail.syncFilter"],
			createMemorySecrets(),
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(errors).toEqual([]);
		expect(writes).toEqual(["primary"]);
	});
});

test("config get reports secret presence without printing the value", async () => {
	const { io, writes } = createIoCapture();
	const secrets = createMemorySecrets({
		"connections.notion-token-default.token": "super-secret",
	});

	await withTempCliPaths(async () => {
		const exitCode = await handleConfigCommand(
			io,
			["syncdown", "syncdown", "config", "get", "notion.token"],
			secrets,
		);

		expect(exitCode).toBe(EXIT_CODES.OK);
		expect(writes).toEqual(["<set>"]);
	});
});

test("config get rejects unknown keys", async () => {
	const { io, errors } = createIoCapture();

	await withTempCliPaths(async () => {
		const exitCode = await handleConfigCommand(
			io,
			["syncdown", "syncdown", "config", "get", "bogus.key"],
			createMemorySecrets(),
		);

		expect(exitCode).toBe(EXIT_CODES.CONFIG_ERROR);
		expect(errors).toContain("Unknown config key: bogus.key");
	});
});
