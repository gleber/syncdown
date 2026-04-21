import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
	DocumentSink,
	SinkWriteRequest,
	SinkWriteResult,
} from "@syncdown/core";

import { compareLocalFsState } from "./parse.js";
import type { SourceRecord, StoredSourceSnapshot, LocalStateModifications } from "@syncdown/core";

class FileSystemSink implements DocumentSink {
	async write(request: SinkWriteRequest): Promise<SinkWriteResult> {
		const absolutePath = path.join(
			request.outputDir,
			request.document.relativePath,
		);
		await mkdir(path.dirname(absolutePath), { recursive: true });

		let action: SinkWriteResult["action"] = "created";
		try {
			const current = await Bun.file(absolutePath).text();
			if (current === request.document.contents) {
				action = "unchanged";
			} else {
				action = "updated";
			}
		} catch {
			action = "created";
		}

		if (action !== "unchanged") {
			await Bun.write(absolutePath, request.document.contents);
		}

		return { absolutePath, action };
	}

	async delete(outputDir: string, relativePath: string): Promise<void> {
		const absolutePath = path.join(outputDir, relativePath);
		await rm(absolutePath, { force: true });
	}

	async analyzeLocalModifications(
		outputDir: string,
		integrationId: string,
		stateRecords: SourceRecord[],
		stateSnapshots: Map<string, StoredSourceSnapshot>
	): Promise<LocalStateModifications> {
		return compareLocalFsState(outputDir, integrationId, stateRecords, stateSnapshots);
	}
}

export function createFileSystemSink(): DocumentSink {
	return new FileSystemSink();
}

export * from "./parse.js";
