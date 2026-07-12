import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SourceSnapshot } from "@syncdown/core";
import { getRequest, getTasksFile, getTasksFileTmp } from "./config.js";
import type { LoadedState } from "./types.js";

export async function loadState(): Promise<LoadedState> {
	const req = getRequest();
	const snapshot = await req.state.getSourceSnapshot(
		req.integration.id,
		"todoist-state",
	);
	if (snapshot) {
		try {
			return JSON.parse(snapshot.payload.bodyMd) as LoadedState;
		} catch (e) {
			console.error("Error parsing state from store, resetting state:", e);
		}
	}
	return {
		sync_token: "*",
		localState: {},
	};
}

export async function saveState(newState: LoadedState): Promise<void> {
	const req = getRequest();
	const bodyMd = JSON.stringify(newState, null, 2);
	const snapshot: SourceSnapshot = {
		integrationId: req.integration.id,
		connectorId: req.integration.connectorId,
		sourceId: "todoist-state",
		entityType: "state",
		title: "Todoist State",
		slug: "todoist-state",
		pathHint: { kind: "todoist-tasks" },
		metadata: {},
		bodyMd,
		sourceHash: "none",
		snapshotSchemaVersion: "1",
	};
	await req.persistSource(snapshot);
}

export function saveTasksFile(markdown: string): void {
	writeFileSync(getTasksFileTmp(), markdown);
	renameSync(getTasksFileTmp(), getTasksFile());
}

export function readTasksFile(): string {
	if (existsSync(getTasksFile())) {
		return readFileSync(getTasksFile(), "utf-8");
	}
	return "";
}
