import path from "node:path";

import type { SourceSnapshot } from "@syncdown/core";

import { slugifySegment } from "./strings.js";

function getAppleNotesFileIdentifier(noteId: string): string {
	const withoutScheme = noteId.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	return slugifySegment(withoutScheme);
}

function getCalendarBucketDate(document: SourceSnapshot): Date | null {
	const value =
		document.metadata.calendarStartAt ?? document.metadata.createdAt;
	if (!value) {
		return null;
	}

	const date = new Date(value);
	return Number.isFinite(date.valueOf()) ? date : null;
}

function getGmailAccountSegment(document: SourceSnapshot): string {
	return slugifySegment(
		document.pathHint.gmailAccountEmail ??
			document.metadata.gmailAccountEmail ??
			"unknown-account",
	);
}

function getAppleNotesFolderSegments(document: SourceSnapshot): string[] {
	const rawPath =
		document.pathHint.appleNotesFolderPath ??
		document.metadata.appleNotesFolderPath;
	if (Array.isArray(rawPath) && rawPath.length > 0) {
		return rawPath.map((segment) => slugifySegment(String(segment)));
	}

	return [
		slugifySegment(
			document.pathHint.appleNotesFolder ??
				document.metadata.appleNotesFolder ??
				"root",
		),
	];
}

function getContactFileIdentifier(resourceName: string): string {
	return slugifySegment(resourceName.replace(/^people\//, ""));
}

function getFileIdentifier(document: SourceSnapshot): string {
	if (document.pathHint.kind === "calendar-event") {
		const eventId = document.metadata.calendarEventId;
		if (typeof eventId === "string" && eventId.trim().length > 0) {
			return eventId;
		}
	}

	if (document.pathHint.kind === "note") {
		const noteId = document.metadata.appleNotesNoteId;
		if (typeof noteId === "string" && noteId.trim().length > 0) {
			return getAppleNotesFileIdentifier(noteId);
		}
	}

	if (document.pathHint.kind === "contact") {
		const resourceName = document.metadata.contactResourceName;
		if (typeof resourceName === "string" && resourceName.trim().length > 0) {
			return getContactFileIdentifier(resourceName);
		}
	}

	return document.sourceId;
}

const MAX_FILENAME_LENGTH = 255;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function truncateUtf8(input: string, maxBytes: number): string {
	if (maxBytes <= 0) {
		return "";
	}
	const bytes = utf8Encoder.encode(input);
	if (bytes.length <= maxBytes) {
		return input;
	}
	// Walk back past UTF-8 continuation bytes (10xxxxxx) so we never split a code point.
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
		end--;
	}
	return utf8Decoder.decode(bytes.subarray(0, end));
}

function buildFileName(document: SourceSnapshot, prefix = ""): string {
	const identifier = getFileIdentifier(document);
	const suffix = `-${identifier}.md`;
	const rawSlug = document.slug || slugifySegment(document.title);
	const reservedBytes =
		utf8Encoder.encode(suffix).length + utf8Encoder.encode(prefix).length;
	const maxSlugBytes = Math.max(0, MAX_FILENAME_LENGTH - reservedBytes);
	const truncated = truncateUtf8(rawSlug, maxSlugBytes);
	const slug = truncated === rawSlug ? rawSlug : truncated.replace(/-+$/, "");
	return `${prefix}${slug}${suffix}`;
}

export function buildRelativePath(document: SourceSnapshot): string {
	if (document.pathHint.kind === "message") {
		const parsed = document.metadata.createdAt
			? new Date(document.metadata.createdAt)
			: null;
		const createdAt =
			parsed && Number.isFinite(parsed.valueOf()) ? parsed : null;
		const year = createdAt ? String(createdAt.getUTCFullYear()) : "unknown";
		const month = createdAt
			? String(createdAt.getUTCMonth() + 1).padStart(2, "0")
			: "unknown";
		const day = createdAt
			? String(createdAt.getUTCDate()).padStart(2, "0")
			: "unknown";
		const hourPrefix = createdAt
			? `${String(createdAt.getUTCHours()).padStart(2, "0")}-`
			: "";

		return path.join(
			document.connectorId,
			getGmailAccountSegment(document),
			year,
			month,
			day,
			buildFileName(document, hourPrefix),
		);
	}

	const fileName = buildFileName(document);

	if (document.pathHint.kind === "calendar-event") {
		const bucketDate = getCalendarBucketDate(document);
		const year = bucketDate ? String(bucketDate.getUTCFullYear()) : "undated";
		const month = bucketDate
			? String(bucketDate.getUTCMonth() + 1).padStart(2, "0")
			: "undated";
		const calendarName = slugifySegment(
			document.pathHint.calendarName ??
				document.metadata.calendarName ??
				"default",
		);

		return path.join(document.connectorId, calendarName, year, month, fileName);
	}

	if (document.pathHint.kind === "note") {
		const accountName = slugifySegment(
			document.pathHint.appleNotesAccount ?? "unknown-account",
		);
		return path.join(
			document.connectorId,
			accountName,
			...getAppleNotesFolderSegments(document),
			fileName,
		);
	}

	if (document.pathHint.kind === "database" && document.pathHint.databaseName) {
		return path.join(
			document.connectorId,
			"databases",
			slugifySegment(document.pathHint.databaseName),
			fileName,
		);
	}

	if (document.pathHint.kind === "contact") {
		const accountSegment = slugifySegment(
			document.pathHint.contactAccountEmail ??
				document.metadata.contactAccountEmail ??
				"default",
		);
		return path.join(document.connectorId, accountSegment, fileName);
	}

	return path.join(document.connectorId, "pages", fileName);
}
