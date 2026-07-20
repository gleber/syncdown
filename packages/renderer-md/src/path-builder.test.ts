import { expect, test } from "bun:test";

import type { SourceSnapshot } from "@syncdown/core";

import { buildRelativePath } from "./path-builder.js";

function createSnapshot(overrides: Partial<SourceSnapshot>): SourceSnapshot {
	return {
		integrationId: "integration-1",
		connectorId: "gmail",
		sourceId: "source-1",
		entityType: "message",
		title: "Launch Status Update",
		slug: "",
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
		metadata: {},
		bodyMd: "Hello world",
		sourceHash: "hash-source-1",
		snapshotSchemaVersion: "1",
		...overrides,
	};
}

test("buildRelativePath uses unknown buckets for gmail documents without createdAt", () => {
	const document = createSnapshot({
		connectorId: "gmail",
		sourceId: "msg-123",
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
	});

	expect(buildRelativePath(document)).toBe(
		"gmail/owner-example-com/unknown/unknown/unknown/launch-status-update-msg-123.md",
	);
});

test("buildRelativePath buckets gmail documents per day and prefixes the received hour", () => {
	const document = createSnapshot({
		connectorId: "gmail",
		sourceId: "thread-123",
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
		metadata: { createdAt: "2026-03-16T09:34:56.000Z" },
	});

	expect(buildRelativePath(document)).toBe(
		"gmail/owner-example-com/2026/03/16/09-launch-status-update-thread-123.md",
	);
});

test("buildRelativePath keeps prefixed gmail filenames within 255 bytes", () => {
	const longTitle = "a".repeat(400);
	const document = createSnapshot({
		connectorId: "gmail",
		sourceId: "thread-456",
		title: longTitle,
		pathHint: { kind: "message", gmailAccountEmail: "Owner@Example.com" },
		metadata: { createdAt: "2026-03-16T23:59:59.000Z" },
	});

	const fileName = buildRelativePath(document).split("/").at(-1)!;
	expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
	expect(fileName.startsWith("23-")).toBe(true);
	expect(fileName.endsWith("-thread-456.md")).toBe(true);
});

test("buildRelativePath uses calendarEventId for filenames and createdAt for calendar buckets", () => {
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: "primary:event-123",
		entityType: "event",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
			calendarEventId: "event-123",
		},
	});

	expect(buildRelativePath(document)).toBe(
		"google-calendar/primary-calendar/2026/03/launch-status-update-event-123.md",
	);
});

test("buildRelativePath falls back to sourceId when calendarEventId is missing", () => {
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: "primary:event-123",
		entityType: "event",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
		},
	});

	expect(buildRelativePath(document)).toBe(
		"google-calendar/primary-calendar/2026/03/launch-status-update-primary:event-123.md",
	);
});

test("buildRelativePath routes notion database items under databases folders", () => {
	const document = createSnapshot({
		connectorId: "notion",
		sourceId: "page-123",
		entityType: "page",
		title: "Roadmap",
		pathHint: { kind: "database", databaseName: "Projects" },
	});

	expect(buildRelativePath(document)).toBe(
		"notion/databases/projects/roadmap-page-123.md",
	);
});

test("buildRelativePath truncates long titles to keep filename within 255 chars", () => {
	const longTitle =
		"icfp research papers prototyping a functional language using higher order logic programming a functional pearl on learning the ways of prolog makam antonis stampoulis adam chlipala";
	const longEventId =
		"_60o66p1o6spjebb375hj6b9k6or38bb1c8q32b9kckqj0opmcgsj4opj6t066rrecon74pbjclgn4or8e8n6usj7";
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: `primary:${longEventId}`,
		entityType: "event",
		title: longTitle,
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2018-09-01T00:00:00.000Z",
			calendarEventId: longEventId,
		},
	});

	const result = buildRelativePath(document);
	const fileName = result.split("/").at(-1)!;
	expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
	expect(fileName.endsWith(`-${longEventId}.md`)).toBe(true);
});

test("buildRelativePath truncates long emoji/CJK titles to keep filename within 255 bytes", () => {
	// Each emoji is 4 bytes in UTF-8; a long title of them can exceed 255 bytes
	// even when the character count is under 255.
	const longTitle = "🗓️".repeat(60);
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: "primary:abc123",
		entityType: "event",
		title: longTitle,
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2024-01-01T00:00:00.000Z",
			calendarEventId: "abc123",
		},
	});

	const result = buildRelativePath(document);
	const fileName = result.split("/").at(-1)!;
	expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
	expect(fileName.endsWith("-abc123.md")).toBe(true);
});

test("buildRelativePath truncates multi-byte slugs to keep filename within 255 UTF-8 bytes", () => {
	// 100 emoji code points = 400 UTF-8 bytes — naive char-count truncation would leave it oversized.
	const emojiSlug = "🎉".repeat(100);
	const longEventId =
		"_60o66p1o6spjebb375hj6b9k6or38bb1c8q32b9kckqj0opmcgsj4opj6t066rrecon74pbjclgn4or8e8n6usj7";
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: `primary:${longEventId}`,
		entityType: "event",
		slug: emojiSlug,
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
			calendarEventId: longEventId,
		},
	});

	const fileName = buildRelativePath(document).split("/").at(-1)!;
	expect(Buffer.byteLength(fileName, "utf8")).toBeLessThanOrEqual(255);
	expect(fileName.endsWith(`-${longEventId}.md`)).toBe(true);
});

test("buildRelativePath handles identifier suffix exceeding 255 bytes without throwing", () => {
	const oversizedId = "x".repeat(300);
	const document = createSnapshot({
		connectorId: "google-calendar",
		sourceId: `primary:${oversizedId}`,
		entityType: "event",
		title: "Event",
		pathHint: { kind: "calendar-event", calendarName: "Primary Calendar" },
		metadata: {
			createdAt: "2026-03-17T07:00:00.000Z",
			calendarEventId: oversizedId,
		},
	});

	const fileName = buildRelativePath(document).split("/").at(-1)!;
	expect(fileName).toBe(`-${oversizedId}.md`);
});

test("buildRelativePath routes non-database notion pages under pages folders", () => {
	const document = createSnapshot({
		connectorId: "notion",
		sourceId: "page-999",
		entityType: "page",
		title: "Overview",
		pathHint: { kind: "page" },
	});

	expect(buildRelativePath(document)).toBe("notion/pages/overview-page-999.md");
});

test("buildRelativePath keeps active notes at the connector root and archives under archive", () => {
	const active = createSnapshot({
		connectorId: "google-keep",
		sourceId: "note-123",
		entityType: "keep-note",
		title: "Shopping List",
		slug: "shopping-list",
		pathHint: { kind: "keep-note" },
		metadata: { keepNoteId: "note-123" },
	});
	expect(buildRelativePath(active)).toBe(
		"google-keep/shopping-list-note-123.md",
	);

	const archived = createSnapshot({
		connectorId: "google-keep",
		sourceId: "note-456",
		entityType: "keep-note",
		title: "Old Note",
		slug: "old-note",
		pathHint: { kind: "keep-note" },
		metadata: { keepNoteId: "note-456", archived: true },
	});
	expect(buildRelativePath(archived)).toBe(
		"google-keep/archive/old-note-note-456.md",
	);
});
