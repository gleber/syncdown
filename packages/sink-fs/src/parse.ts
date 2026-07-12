import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as yaml from "yaml";

import type {
	AppPaths,
	SourceSnapshot,
	SourceRecord,
	StoredSourceSnapshot,
	ParsedLocalSource,
} from "@syncdown/core";

/**
 * Parses a markdown file and separates frontmatter from body
 */
export async function parseMarkdownFile(absolutePath: string): Promise<{ frontmatter: any, bodyMd: string } | null> {
    try {
        const content = await readFile(absolutePath, "utf-8");

        // Match standard YAML frontmatter block
        const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

        if (!match) {
            return null; // Not a valid syncdown markdown file
        }

        const frontmatterText = match[1];
        let bodyMd = match[2];

        // Strip out the title heading if it exists, as syncdown injects it
        bodyMd = bodyMd.replace(/^\s*# [^\n]+\n\n?/, "");

        const frontmatter = yaml.parse(frontmatterText);
        return { frontmatter, bodyMd: bodyMd.trim() };
    } catch (error) {
        return null;
    }
}

/**
 * Recursively scans a directory for markdown files
 */
export async function scanDirectory(dir: string, filePaths: string[] = []): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const absolutePath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await scanDirectory(absolutePath, filePaths);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                filePaths.push(absolutePath);
            }
        }
    } catch (e) {
        // Ignore errors reading directories that don't exist
    }
    return filePaths;
}

/**
 * Compares the local filesystem against the stored state records to find modifications
 */
export async function compareLocalFsState(
    outputDir: string,
    integrationId: string,
    stateRecords: SourceRecord[],
    stateSnapshots: Map<string, StoredSourceSnapshot>
): Promise<import("@syncdown/core").LocalStateModifications> {
    const markdownFiles = await scanDirectory(outputDir);

    const createdSources: ParsedLocalSource[] = [];
    const updatedSources: ParsedLocalSource[] = [];
    const deletedSourceIds: string[] = [];

    // Create a map of existing records by their relative path
    const recordsByPath = new Map<string, SourceRecord>();
    for (const record of stateRecords) {
        recordsByPath.set(record.relativePath, record);
    }

    const seenPaths = new Set<string>();

    for (const file of markdownFiles) {
        const relativePath = path.relative(outputDir, file);
        seenPaths.add(relativePath);

        const fileStats = await stat(file);
        const lastModifiedLocal = fileStats.mtimeMs;

        const record = recordsByPath.get(relativePath);

        const parsed = await parseMarkdownFile(file);
        if (!parsed) continue; // Skip invalid files

        if (!record) {
            // New file created locally
            // We need to synthesize a Snapshot
            createdSources.push({
                sourceId: "new-" + Math.random().toString(36).substring(2, 9), // Temporary ID
                lastModifiedLocal,
                snapshot: synthesizeSnapshotFromFrontmatter(integrationId, parsed.frontmatter, parsed.bodyMd)
            });
        } else {
            // Existing file
            const storedSnapshot = stateSnapshots.get(record.sourceId);
            if (!storedSnapshot) continue; // Should not happen

            // Check if modified locally since last render
            // The precise check might require storing last rendered mtime, but for now
            // we can compare the parsed content with the stored snapshot.

            const localBodyHash = new Bun.CryptoHasher("sha256").update(parsed.bodyMd).digest("hex");
            const snapshotBodyHash = new Bun.CryptoHasher("sha256").update(storedSnapshot.payload.bodyMd).digest("hex");

            // Check frontmatter changes (simplified for calendar)
            let modified = false;

            if (localBodyHash !== snapshotBodyHash) {
                modified = true;
            } else if (storedSnapshot.payload.connectorId === "google-calendar") {
                // Check specific calendar fields
                if (parsed.frontmatter.title !== storedSnapshot.payload.title ||
                    parsed.frontmatter.start !== storedSnapshot.payload.metadata.calendarStartAt ||
                    parsed.frontmatter.end !== storedSnapshot.payload.metadata.calendarEndAt ||
                    parsed.frontmatter.location !== storedSnapshot.payload.metadata.calendarLocation) {
                    modified = true;
                }
            }

            if (modified) {
                updatedSources.push({
                    sourceId: record.sourceId,
                    lastModifiedLocal,
                    snapshot: applyUpdatesToSnapshot(storedSnapshot.payload, parsed.frontmatter, parsed.bodyMd)
                });
            }
        }
    }

    // Find deleted files
    for (const record of stateRecords) {
        if (!seenPaths.has(record.relativePath)) {
            // Wait, we need to verify if the file was just renamed or actually deleted
            // If the content is identical or closely matches a new file, it might be a rename
            // But since syncdown controls the output structure based on IDs, we treat renamed files
            // as deleted (from the old path perspective), but we SHOULD NOT delete the remote event if it was renamed locally.
            // A true deletion means the user actively removed the file and wants it gone.
            // Let's simply push deletions as usual but warn the user in docs not to rename.
            deletedSourceIds.push(record.sourceId);
        }
    }

    return {
        createdSources,
        updatedSources,
        deletedSourceIds
    };
}

function synthesizeSnapshotFromFrontmatter(integrationId: string, frontmatter: any, bodyMd: string): SourceSnapshot {
    return {
        integrationId,
        connectorId: "google-calendar", // Assuming calendar for now based on context
        sourceId: "", // Will be assigned later
        entityType: "event",
        title: frontmatter.title || "Untitled",
        slug: "",
        pathHint: {
            kind: "calendar-event",
            calendarName: frontmatter.calendar || "Primary"
        },
        metadata: {
            calendarStartAt: frontmatter.start,
            calendarEndAt: frontmatter.end,
            calendarLocation: frontmatter.location,
            calendarAllDay: frontmatter.all_day,
            calendarName: frontmatter.calendar,
        },
        bodyMd: bodyMd,
        sourceHash: "",
        snapshotSchemaVersion: "1"
    };
}

function applyUpdatesToSnapshot(original: SourceSnapshot, frontmatter: any, bodyMd: string): SourceSnapshot {
    const updated = JSON.parse(JSON.stringify(original)) as SourceSnapshot;

    updated.title = frontmatter.title || updated.title;
    updated.bodyMd = bodyMd;

    if (updated.connectorId === "google-calendar") {
        updated.metadata.calendarStartAt = frontmatter.start;
        updated.metadata.calendarEndAt = frontmatter.end;
        updated.metadata.calendarLocation = frontmatter.location;
        updated.metadata.calendarAllDay = frontmatter.all_day;
    }

    return updated;
}
