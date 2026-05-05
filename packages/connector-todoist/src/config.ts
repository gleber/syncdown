import { join } from "node:path";
import type { ConnectorSyncRequest } from "@syncdown/core";

let currentRequest: ConnectorSyncRequest | null = null;

export function setRequest(request: ConnectorSyncRequest) {
	currentRequest = request;
}

export function getRequest(): ConnectorSyncRequest {
	if (!currentRequest) {
		throw new Error("ConnectorSyncRequest not initialized");
	}
	return currentRequest;
}

export function getOutDir(): string {
	const req = getRequest();
	return join(req.config.outputDir || process.cwd(), "todoist");
}

export function getSyncMode(): string {
	const req = getRequest();
	// @ts-expect-error
	return req.integration.config.syncMode || "two-way";
}

export function getDryRun(): boolean {
	return getSyncMode() === "dry";
}

export function getTasksFile(): string {
	return join(getOutDir(), "TASKS.md");
}

export function getTasksFileTmp(): string {
	return join(getOutDir(), "TASKS.md.tmp");
}

export function getSyncCompletedMonths(): number {
	const req = getRequest();
	// @ts-expect-error
	return req.integration.config.syncCompletedMonths ?? 3;
}

export function getToken(): string {
	const req = getRequest();
	if (!req.resolvedAuth || req.resolvedAuth.kind !== "token") {
		throw new Error("Missing Todoist token");
	}
	return req.resolvedAuth.token;
}
