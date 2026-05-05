import { existsSync, writeFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import type { ConnectorSyncRequest } from "@syncdown/core";
import chokidar from "chokidar";
import { getTasksFile, setRequest } from "./config.js";
import { lastWriteTime, tick } from "./sync.js";
import { getTimestamp } from "./utils.js";

let watcher: import("chokidar").FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout>;

export function setupWatcher(request: ConnectorSyncRequest) {
	if (watcher) return;

	const tasksFile = getTasksFile();
	if (!existsSync(tasksFile)) {
		writeFileSync(tasksFile, "");
	}

	watcher = chokidar.watch(tasksFile, { persistent: true });

	watcher.on("change", () => {
		if (Temporal.Now.instant().epochMilliseconds - lastWriteTime < 1000) {
			// Ignore changes triggered by our own writes
			return;
		}
		console.log(`[${getTimestamp()}] TASKS_FILE changed, debouncing...`);
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			setRequest(request);
			void tick(request).catch((e) =>
				console.error("Out-of-band tick failed", e),
			);
		}, 2000);
	});
}
