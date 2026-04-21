import { randomUUID } from "node:crypto";

import type {
	Connector,
	ConnectorPlugin,
	ConnectorSyncRequest,
	ConnectorSyncResult,
	GoogleAccessTokenProvider,
	GoogleOAuthCredentials,
	HealthCheck,
	IntegrationConfig,
	SourceSnapshot,
} from "@syncdown/core";
import {
	assertGoogleGrantedScopes,
	createGoogleAccessTokenProvider,
	DEFAULT_GOOGLE_CONNECTION_ID,
	DEFAULT_GOOGLE_OAUTH_APP_ID,
	defineConnectorPlugin,
} from "@syncdown/core";

const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3/";
export const GOOGLE_CALENDAR_REQUIRED_SCOPES = [
	"https://www.googleapis.com/auth/calendar.readonly",
	"https://www.googleapis.com/auth/calendar.events",
] as const;

const CURSOR_VERSION = 1;

type CalendarCredentials = GoogleOAuthCredentials;

export interface GoogleCalendarSummary {
	id: string;
	summary: string;
	description?: string;
	primary?: boolean;
}

export interface GoogleCalendarEventDateTime {
	date?: string | null;
	dateTime?: string | null;
	timeZone?: string | null;
}

export interface GoogleCalendarEventAttendee {
	email?: string | null;
	displayName?: string | null;
}

export interface GoogleCalendarEvent {
	id?: string | null;
	status?: string | null;
	summary?: string | null;
	description?: string | null;
	updated?: string | null;
	created?: string | null;
	htmlLink?: string | null;
	location?: string | null;
	recurrence?: string[] | null;
	recurringEventId?: string | null;
	organizer?: {
		email?: string | null;
		displayName?: string | null;
	} | null;
	attendees?: GoogleCalendarEventAttendee[] | null;
	start?: GoogleCalendarEventDateTime | null;
	end?: GoogleCalendarEventDateTime | null;
}

export interface GoogleCalendarEventsPage {
	events: GoogleCalendarEvent[];
	nextPageToken?: string | null;
	nextSyncToken?: string | null;
	invalidSyncToken?: boolean;
}

export interface GoogleCalendarAdapter {
	listCalendars(
		credentials: CalendarCredentials,
	): Promise<GoogleCalendarSummary[]>;
	listEvents(
		credentials: CalendarCredentials,
		calendarId: string,
		options: {
			pageToken?: string;
			syncToken?: string;
		},
	): Promise<GoogleCalendarEventsPage>;
	getEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
	): Promise<GoogleCalendarEvent>;
	createEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventData: GoogleCalendarEvent,
	): Promise<GoogleCalendarEvent>;
	updateEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
		eventData: GoogleCalendarEvent,
	): Promise<GoogleCalendarEvent>;
	deleteEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
	): Promise<void>;
}

interface GoogleCalendarListResponse {
	items?: Array<{
		id?: string | null;
		summary?: string | null;
		description?: string | null;
		primary?: boolean | null;
	}> | null;
	nextPageToken?: string | null;
}

interface GoogleCalendarEventsResponse {
	items?: GoogleCalendarEvent[] | null;
	nextPageToken?: string | null;
	nextSyncToken?: string | null;
	error?: {
		code?: number;
		message?: string;
		errors?: Array<{ reason?: string; message?: string }>;
	};
}

class GoogleCalendarApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly reasons: string[] = [],
	) {
		super(message);
		this.name = "GoogleCalendarApiError";
	}
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
	const text = await response.text();
	if (!text) {
		return null;
	}

	return JSON.parse(text) as T;
}

class OfficialGoogleCalendarAdapter implements GoogleCalendarAdapter {
	constructor(
		private readonly accessTokenProvider: GoogleAccessTokenProvider = createGoogleAccessTokenProvider(),
	) {}

	private async getAccessToken(
		credentials: CalendarCredentials,
	): Promise<string> {
		return this.accessTokenProvider.getAccessToken(credentials);
	}

	private async request<T>(
		credentials: CalendarCredentials,
		path: string,
		params: Record<string, string | number | boolean | undefined> = {},
		method: string = "GET",
		body?: any,
	): Promise<T> {
		const url = new URL(path, GOOGLE_CALENDAR_API_BASE_URL);
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) {
				continue;
			}
			url.searchParams.set(key, String(value));
		}

		const headers: Record<string, string> = {
			authorization: `Bearer ${await this.getAccessToken(credentials)}`,
			accept: "application/json",
		};

		if (body) {
			headers["content-type"] = "application/json";
		}

		const response = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (response.status === 204) {
			return {} as T;
		}

		const payload = await parseJsonResponse<T & GoogleCalendarEventsResponse>(
			response,
		);
		if (!response.ok) {
			const errorPayload = payload as GoogleCalendarEventsResponse | null;
			const reasons =
				errorPayload?.error?.errors
					?.map((entry) => entry.reason)
					.filter((value): value is string => Boolean(value)) ?? [];
			throw new GoogleCalendarApiError(
				response.status,
				errorPayload?.error?.message ??
					`Google Calendar API request failed: HTTP ${response.status}`,
				reasons,
			);
		}

		return (payload ?? {}) as T;
	}

	async listCalendars(
		credentials: CalendarCredentials,
	): Promise<GoogleCalendarSummary[]> {
		const calendars: GoogleCalendarSummary[] = [];
		let pageToken: string | undefined;

		do {
			const response = await this.request<GoogleCalendarListResponse>(
				credentials,
				"users/me/calendarList",
				{
					pageToken,
					maxResults: 250,
				},
			);

			for (const item of response.items ?? []) {
				if (!item.id) {
					continue;
				}
				calendars.push({
					id: item.id,
					summary: item.summary?.trim() || item.id,
					description: item.description ?? undefined,
					primary: item.primary ?? undefined,
				});
			}

			pageToken = response.nextPageToken ?? undefined;
		} while (pageToken);

		return calendars;
	}

	async listEvents(
		credentials: CalendarCredentials,
		calendarId: string,
		options: {
			pageToken?: string;
			syncToken?: string;
		},
	): Promise<GoogleCalendarEventsPage> {
		try {
			const response = await this.request<GoogleCalendarEventsResponse>(
				credentials,
				`calendars/${encodeURIComponent(calendarId)}/events`,
				{
					pageToken: options.pageToken,
					syncToken: options.syncToken,
					showDeleted: options.syncToken ? true : undefined,
					singleEvents: false,
					maxResults: 2500,
				},
			);

			return {
				events: response.items ?? [],
				nextPageToken: response.nextPageToken ?? undefined,
				nextSyncToken: response.nextSyncToken ?? undefined,
			};
		} catch (error) {
			if (error instanceof GoogleCalendarApiError && error.status === 410) {
				return {
					events: [],
					invalidSyncToken: true,
				};
			}

			throw error;
		}
	}

	async createEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventData: GoogleCalendarEvent,
	): Promise<GoogleCalendarEvent> {
		return this.request<GoogleCalendarEvent>(
			credentials,
			`calendars/${encodeURIComponent(calendarId)}/events`,
			{},
			"POST",
			eventData,
		);
	}

	async getEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
	): Promise<GoogleCalendarEvent> {
		return this.request<GoogleCalendarEvent>(
			credentials,
			`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{},
			"GET",
		);
	}

	async updateEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
		eventData: GoogleCalendarEvent,
	): Promise<GoogleCalendarEvent> {
		return this.request<GoogleCalendarEvent>(
			credentials,
			`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{},
			"PATCH",
			eventData,
		);
	}

	async deleteEvent(
		credentials: CalendarCredentials,
		calendarId: string,
		eventId: string,
	): Promise<void> {
		return this.request<void>(
			credentials,
			`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{},
			"DELETE",
		);
	}
}

export function createGoogleCalendarAdapter(): GoogleCalendarAdapter {
	return new OfficialGoogleCalendarAdapter();
}

export async function listGoogleCalendars(
	credentials: CalendarCredentials,
	adapter: GoogleCalendarAdapter = createGoogleCalendarAdapter(),
): Promise<GoogleCalendarSummary[]> {
	return adapter.listCalendars(credentials);
}

function isSeriesLevelEvent(event: GoogleCalendarEvent): boolean {
	return !event.recurringEventId;
}

function normalizeAttendee(
	attendee: GoogleCalendarEventAttendee,
): string | null {
	const displayName = attendee.displayName?.trim();
	const email = attendee.email?.trim();
	if (displayName && email) {
		return `${displayName} <${email}>`;
	}
	return displayName ?? email ?? null;
}

function toTimestampParts(
	value: GoogleCalendarEventDateTime | null | undefined,
): {
	value?: string;
	allDay?: boolean;
} {
	if (value?.dateTime) {
		return { value: value.dateTime };
	}

	if (value?.date) {
		return { value: value.date, allDay: true };
	}

	return {};
}

function slugifySegment(input: string): string {
	return (
		input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "untitled"
	);
}

function computeSourceHash(
	snapshot: Omit<SourceSnapshot, "sourceHash">,
): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				connectorId: snapshot.connectorId,
				sourceId: snapshot.sourceId,
				title: snapshot.title,
				entityType: snapshot.entityType,
				pathHint: snapshot.pathHint,
				metadata: snapshot.metadata,
				bodyMd: snapshot.bodyMd,
			}),
		)
		.digest("hex");
}

function toSourceId(calendarId: string, eventId: string): string {
	return `${calendarId}:${eventId}`;
}

function toSourceSnapshot(
	integrationId: string,
	calendar: GoogleCalendarSummary,
	event: GoogleCalendarEvent,
): SourceSnapshot {
	const eventId = event.id;
	if (!eventId) {
		throw new Error("Google Calendar event did not include an id");
	}

	const start = toTimestampParts(event.start);
	const end = toTimestampParts(event.end);
	const title = event.summary?.trim() || "(untitled event)";
	const organizerName =
		event.organizer?.displayName?.trim() || event.organizer?.email?.trim();
	const attendees =
		event.attendees
			?.map((attendee) => normalizeAttendee(attendee))
			.filter((value): value is string => Boolean(value)) ?? [];

	const snapshotBase: Omit<SourceSnapshot, "sourceHash"> = {
		integrationId,
		connectorId: "google-calendar",
		sourceId: toSourceId(calendar.id, eventId),
		entityType: "event",
		title,
		slug: slugifySegment(title),
		pathHint: {
			kind: "calendar-event",
			calendarName: calendar.summary,
		},
		metadata: {
			sourceUrl: event.htmlLink ?? undefined,
			createdAt: event.created ?? undefined,
			updatedAt: event.updated ?? undefined,
			calendarId: calendar.id,
			calendarName: calendar.summary,
			calendarEventId: eventId,
			calendarEventStatus: event.status ?? undefined,
			calendarStartAt: start.value,
			calendarEndAt: end.value,
			calendarAllDay: start.allDay ?? end.allDay ?? undefined,
			calendarLocation: event.location?.trim() || undefined,
			calendarOrganizer: organizerName,
			calendarAttendees: attendees.length > 0 ? attendees : undefined,
			calendarRecurrence: event.recurrence ?? undefined,
		},
		bodyMd: event.description?.trim() ?? "",
		snapshotSchemaVersion: "1",
	};

	return {
		...snapshotBase,
		sourceHash: computeSourceHash(snapshotBase),
	};
}

interface StoredGoogleCalendarCursor {
	version: 1;
	selectedCalendarIds: string[];
	syncTokens: Record<string, string>;
}

function decodeCursor(value: string | null): StoredGoogleCalendarCursor {
	if (!value) {
		return {
			version: CURSOR_VERSION,
			selectedCalendarIds: [],
			syncTokens: {},
		};
	}

	try {
		const parsed = JSON.parse(value) as Partial<StoredGoogleCalendarCursor>;
		if (
			parsed.version !== CURSOR_VERSION ||
			!Array.isArray(parsed.selectedCalendarIds) ||
			typeof parsed.syncTokens !== "object" ||
			parsed.syncTokens === null
		) {
			throw new Error("legacy");
		}

		return {
			version: CURSOR_VERSION,
			selectedCalendarIds: [
				...new Set(
					parsed.selectedCalendarIds.filter(
						(entry): entry is string =>
							typeof entry === "string" && entry.trim().length > 0,
					),
				),
			],
			syncTokens: Object.fromEntries(
				Object.entries(parsed.syncTokens).filter(
					(entry): entry is [string, string] =>
						typeof entry[0] === "string" &&
						entry[0].trim().length > 0 &&
						typeof entry[1] === "string" &&
						entry[1].trim().length > 0,
				),
			),
		};
	} catch {
		return {
			version: CURSOR_VERSION,
			selectedCalendarIds: [],
			syncTokens: {},
		};
	}
}

function encodeCursor(cursor: StoredGoogleCalendarCursor): string {
	return JSON.stringify({
		version: CURSOR_VERSION,
		selectedCalendarIds: [...new Set(cursor.selectedCalendarIds)].sort(),
		syncTokens: cursor.syncTokens,
	} satisfies StoredGoogleCalendarCursor);
}

function getSelectedCalendarIds(request: ConnectorSyncRequest): string[] {
	if (request.integration.connectorId !== "google-calendar") {
		throw new Error(
			`Invalid integration for Google Calendar connector: ${request.integration.connectorId}`,
		);
	}

	return [
		...new Set(
			request.integration.config.selectedCalendarIds.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			),
		),
	];
}

async function getCredentials(
	request: ConnectorSyncRequest,
): Promise<CalendarCredentials> {
	if (request.resolvedAuth?.kind !== "google-oauth") {
		throw new Error("Missing Google credentials in encrypted store");
	}

	return {
		clientId: request.resolvedAuth.clientId,
		clientSecret: request.resolvedAuth.clientSecret,
		refreshToken: request.resolvedAuth.refreshToken,
	};
}

async function purgeCalendarSources(
	request: ConnectorSyncRequest,
	calendarIds: readonly string[],
): Promise<void> {
	if (calendarIds.length === 0) {
		return;
	}

	const prefixes = calendarIds.map((calendarId) => `${calendarId}:`);
	const records = await request.state.listSourceRecords(request.integration.id);
	for (const record of records) {
		if (prefixes.some((prefix) => record.sourceId.startsWith(prefix))) {
			await request.deleteSource(record.sourceId);
		}
	}
}

async function fullSyncCalendar(
	request: ConnectorSyncRequest,
	adapter: GoogleCalendarAdapter,
	credentials: CalendarCredentials,
	calendar: GoogleCalendarSummary,
): Promise<string | null> {
	let pageToken: string | undefined;
	const seenSourceIds = new Set<string>();
	let nextSyncToken: string | null = null;

	do {
		request.throwIfCancelled();
		const page = await adapter.listEvents(credentials, calendar.id, {
			pageToken,
		});

		for (const event of page.events) {
			request.throwIfCancelled();
			if (!event.id || !isSeriesLevelEvent(event)) {
				continue;
			}

			const sourceId = toSourceId(calendar.id, event.id);
			seenSourceIds.add(sourceId);

			if (event.status === "cancelled") {
				await request.deleteSource(sourceId);
				continue;
			}

			await request.persistSource(
				toSourceSnapshot(request.integration.id, calendar, event),
			);
		}

		pageToken = page.nextPageToken ?? undefined;
		nextSyncToken = page.nextSyncToken ?? null;
	} while (pageToken);

	const existingRecords = await request.state.listSourceRecords(
		request.integration.id,
	);
	for (const record of existingRecords) {
		if (
			record.sourceId.startsWith(`${calendar.id}:`) &&
			!seenSourceIds.has(record.sourceId)
		) {
			await request.deleteSource(record.sourceId);
		}
	}

	return nextSyncToken;
}

async function incrementalSyncCalendar(
	request: ConnectorSyncRequest,
	adapter: GoogleCalendarAdapter,
	credentials: CalendarCredentials,
	calendar: GoogleCalendarSummary,
	syncToken: string,
): Promise<{ nextSyncToken: string | null; invalidSyncToken: boolean }> {
	let pageToken: string | undefined;
	let nextSyncToken: string | null = null;

	do {
		request.throwIfCancelled();
		const page = await adapter.listEvents(credentials, calendar.id, {
			pageToken,
			syncToken,
		});

		if (page.invalidSyncToken) {
			return { nextSyncToken: null, invalidSyncToken: true };
		}

		for (const event of page.events) {
			request.throwIfCancelled();
			if (!event.id || !isSeriesLevelEvent(event)) {
				continue;
			}

			const sourceId = toSourceId(calendar.id, event.id);
			if (event.status === "cancelled") {
				await request.deleteSource(sourceId);
				continue;
			}

			await request.persistSource(
				toSourceSnapshot(request.integration.id, calendar, event),
			);
		}

		pageToken = page.nextPageToken ?? undefined;
		nextSyncToken = page.nextSyncToken ?? null;
	} while (pageToken);

	return { nextSyncToken, invalidSyncToken: false };
}

export interface CreateGoogleCalendarConnectorOptions {
	adapter?: GoogleCalendarAdapter;
}

class GoogleCalendarConnector implements Connector {
	readonly id = "google-calendar";
	readonly label = "Google Calendar";
	readonly setupMethods = [
		{
			kind: "provider-oauth",
			providerId: "google",
			requiredScopes: GOOGLE_CALENDAR_REQUIRED_SCOPES,
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			connectionKind: "google-account",
			label: "Google OAuth",
		},
	] as const;

	constructor(private readonly adapter: GoogleCalendarAdapter) {}

	async validate(request: ConnectorSyncRequest): Promise<HealthCheck> {
		if (!request.integration.enabled) {
			return {
				status: "warn",
				message: "integration disabled",
			};
		}

		if (request.resolvedAuth?.kind !== "google-oauth") {
			return {
				status: "error",
				message: "credentials missing in encrypted store",
			};
		}

		const selectedCalendarIds = getSelectedCalendarIds(request);
		if (selectedCalendarIds.length === 0) {
			return {
				status: "error",
				message: "no calendars selected",
			};
		}

		try {
			const credentials = await getCredentials(request);
			await assertGoogleGrantedScopes(
				fetch,
				credentials,
				GOOGLE_CALENDAR_REQUIRED_SCOPES,
			);
			const calendars = await this.adapter.listCalendars(credentials);
			const availableIds = new Set(calendars.map((calendar) => calendar.id));
			const missingIds = selectedCalendarIds.filter(
				(calendarId) => !availableIds.has(calendarId),
			);
			if (missingIds.length > 0) {
				return {
					status: "error",
					message: `selected calendars are not accessible: ${missingIds.join(", ")}`,
				};
			}
			return {
				status: "ok",
				message: "credentials valid",
			};
		} catch (error) {
			return {
				status: "error",
				message:
					error instanceof Error ? error.message : "unknown validation error",
			};
		}
	}

	async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncResult> {
		if (request.integration.connectorId !== "google-calendar") {
			throw new Error(
				`Invalid integration for Google Calendar connector: ${request.integration.connectorId}`,
			);
		}

		const credentials = await getCredentials(request);
		const selectedCalendarIds = getSelectedCalendarIds(request);
		if (selectedCalendarIds.length === 0) {
			request.io.write(
				"Google Calendar has no selected calendars. Nothing to sync.",
			);
			return {
				nextCursor: encodeCursor({
					version: CURSOR_VERSION,
					selectedCalendarIds: [],
					syncTokens: {},
				}),
			};
		}

		const calendars = await this.adapter.listCalendars(credentials);
		const calendarMap = new Map(
			calendars.map((calendar) => [calendar.id, calendar]),
		);
		const unavailableIds = selectedCalendarIds.filter(
			(calendarId) => !calendarMap.has(calendarId),
		);
		if (unavailableIds.length > 0) {
			throw new Error(
				`Selected calendars are not accessible: ${unavailableIds.join(", ")}`,
			);
		}

		const previousCursor = decodeCursor(request.since);
		const deselectedCalendarIds = previousCursor.selectedCalendarIds.filter(
			(calendarId) => !selectedCalendarIds.includes(calendarId),
		);
		if (deselectedCalendarIds.length > 0) {
			request.io.write(
				`Google Calendar selection changed. Purging ${deselectedCalendarIds.length} deselected calendar(s).`,
			);
			await purgeCalendarSources(request, deselectedCalendarIds);
		}

		let completedCalendars = 0;
		const publishProgress = () => {
			request.setProgress({
				mode: "determinate",
				phase: "Syncing calendars",
				detail: `processed ${completedCalendars} of ${selectedCalendarIds.length}`,
				completed: completedCalendars,
				total: selectedCalendarIds.length,
				unit: "events",
			});
		};
		publishProgress();

		const syncTokens: Record<string, string> = {};
		for (const calendarId of selectedCalendarIds) {
			request.throwIfCancelled();
			const calendar = calendarMap.get(calendarId);
			if (!calendar) {
				continue;
			}

			const priorToken = previousCursor.syncTokens[calendarId] ?? null;
			request.io.write(`Google Calendar sync: ${calendar.summary}`);

			let nextSyncToken: string | null = null;
			if (priorToken) {
				const delta = await incrementalSyncCalendar(
					request,
					this.adapter,
					credentials,
					calendar,
					priorToken,
				);
				if (delta.invalidSyncToken) {
					request.io.write(
						`Google Calendar sync token expired for ${calendar.summary}. Rebuilding from scratch.`,
					);
					nextSyncToken = await fullSyncCalendar(
						request,
						this.adapter,
						credentials,
						calendar,
					);
				} else {
					nextSyncToken = delta.nextSyncToken;
				}
			} else {
				nextSyncToken = await fullSyncCalendar(
					request,
					this.adapter,
					credentials,
					calendar,
				);
			}

			if (nextSyncToken) {
				syncTokens[calendarId] = nextSyncToken;
			}

			completedCalendars += 1;
			publishProgress();
		}

		request.setProgress(null);
		return {
			nextCursor: encodeCursor({
				version: CURSOR_VERSION,
				selectedCalendarIds,
				syncTokens,
			}),
		};
	}

	async push(
		request: import("@syncdown/core").ConnectorPushRequest,
	): Promise<import("@syncdown/core").ConnectorPushResult> {
		if (request.integration.connectorId !== "google-calendar") {
			throw new Error("Invalid integration for Google Calendar connector");
		}

		const credentials = await getCredentials(request);
		const pushedIds: string[] = [];
		const failedIds: string[] = [];

		// Try to verify events scope. If missing, we can't push.
		try {
			await assertGoogleGrantedScopes(
				fetch,
				credentials,
				["https://www.googleapis.com/auth/calendar.events"],
			);
		} catch (error) {
			request.io.error(
				"Google Calendar push failed: Missing 'calendar.events' scope. You may need to re-authenticate or update the connection.",
			);
			return { success: false, pushedIds, failedIds: [...request.createdSources.map(s => s.sourceId), ...request.updatedSources.map(s => s.sourceId), ...request.deletedSourceIds] };
		}

		const calendars = await this.adapter.listCalendars(credentials);
		const calendarMap = new Map(calendars.map((c) => [c.id, c]));
		const calendarSummaryMap = new Map(calendars.map((c) => [c.summary, c.id]));

		// Helper to find calendar id
		const getCalendarId = (snapshot: import("@syncdown/core").SourceSnapshot) => {
			const explicitlySet = snapshot.metadata.calendarId as string | undefined;
			if (explicitlySet && calendarMap.has(explicitlySet)) {
				return explicitlySet;
			}
			const byName = snapshot.metadata.calendarName as string | undefined;
			if (byName && calendarSummaryMap.has(byName)) {
				return calendarSummaryMap.get(byName);
			}
			return getSelectedCalendarIds(request)[0]; // fallback to first selected
		};

		const toEventDateTime = (val: unknown, allDay?: unknown): GoogleCalendarEventDateTime | null => {
			if (typeof val !== "string") return null;
			if (allDay === true || allDay === "true") return { date: val.split("T")[0] };
			return { dateTime: val };
		};

		const createdSourceMappings: Record<string, import("@syncdown/core").SourceSnapshot> = {};

		// 1. Handle creations
		for (const source of request.createdSources) {
			try {
				const calendarId = getCalendarId(source.snapshot);
				if (!calendarId) throw new Error("No calendar selected");

				const eventData: GoogleCalendarEvent = {
					summary: source.snapshot.title,
					description: source.snapshot.bodyMd,
					location: (source.snapshot.metadata.calendarLocation as string) || null,
					start: toEventDateTime(source.snapshot.metadata.calendarStartAt, source.snapshot.metadata.calendarAllDay),
					end: toEventDateTime(source.snapshot.metadata.calendarEndAt, source.snapshot.metadata.calendarAllDay),
				};

				const createdEvent = await this.adapter.createEvent(credentials, calendarId, eventData);
				if (!createdEvent.id) throw new Error("API did not return an event ID");

				const calendarSummary = calendarMap.get(calendarId)!;
				const mappedSnapshot = toSourceSnapshot(request.integration.id, calendarSummary, createdEvent);

				createdSourceMappings[source.sourceId] = mappedSnapshot;
				pushedIds.push(source.sourceId);
			} catch (err) {
				request.io.error(`Failed to create event ${source.snapshot.title}: ${err instanceof Error ? err.message : String(err)}`);
				failedIds.push(source.sourceId);
			}
		}

		// 2. Handle updates
		for (const source of request.updatedSources) {
			try {
				const calendarId = getCalendarId(source.snapshot);
				if (!calendarId) throw new Error("No calendar selected");
				const eventIdParts = source.sourceId.split(":");
				const eventId = eventIdParts.length > 1 ? eventIdParts[1] : source.snapshot.metadata.calendarEventId as string;
				if (!eventId) throw new Error("No event ID found");

				// Conflict Resolution check
				const priorRecord = await request.state.getSourceRecord(request.integration.id, source.sourceId);
				let bodyMd = source.snapshot.bodyMd;

				if (priorRecord && priorRecord.sourceUpdatedAt) {
					// We need to fetch the remote event to see if it was modified since we last pulled it
					try {
						const remoteEvent = await this.adapter.getEvent(credentials, calendarId, eventId);
						if (remoteEvent && remoteEvent.updated && new Date(remoteEvent.updated) > new Date(priorRecord.sourceUpdatedAt)) {
							// Remote was updated more recently than the version we based our local edits on.
							// Last local write wins, but we append the remote changes.
							bodyMd += `\n\n---\n**Conflict Note (${new Date().toISOString()})**\nOverwritten remote description:\n${remoteEvent.description ?? "(no description)"}`;
						}
					} catch (e) {
						// Skip conflict check if we fail to fetch the event (e.g. it was deleted)
					}
				}

				const eventData: GoogleCalendarEvent = {
					summary: source.snapshot.title,
					description: bodyMd,
					location: (source.snapshot.metadata.calendarLocation as string) || null,
					start: toEventDateTime(source.snapshot.metadata.calendarStartAt, source.snapshot.metadata.calendarAllDay),
					end: toEventDateTime(source.snapshot.metadata.calendarEndAt, source.snapshot.metadata.calendarAllDay),
				};

				await this.adapter.updateEvent(credentials, calendarId, eventId, eventData);
				pushedIds.push(source.sourceId);
			} catch (err) {
				request.io.error(`Failed to update event ${source.sourceId}: ${err instanceof Error ? err.message : String(err)}`);
				failedIds.push(source.sourceId);
			}
		}

		// 3. Handle deletions
		for (const sourceId of request.deletedSourceIds) {
			try {
				const eventIdParts = sourceId.split(":");
				if (eventIdParts.length !== 2) throw new Error("Invalid sourceId format");
				const calendarId = eventIdParts[0];
				const eventId = eventIdParts[1];

				await this.adapter.deleteEvent(credentials, calendarId, eventId);
				pushedIds.push(sourceId);
			} catch (err) {
				request.io.error(`Failed to delete event ${sourceId}: ${err instanceof Error ? err.message : String(err)}`);
				failedIds.push(sourceId);
			}
		}

		return {
			success: failedIds.length === 0,
			pushedIds,
			failedIds,
			createdSourceMappings,
		};
	}
}

function normalizeGoogleCalendarConnection(
	entry: Partial<{
		id: string;
		kind: string;
		label: string;
		oauthAppId?: string;
		accountEmail?: string;
	}>,
) {
	if (
		entry.kind !== "google-account" ||
		typeof entry.id !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.oauthAppId !== "string"
	) {
		return [];
	}

	return [
		{
			id: entry.id,
			kind: "google-account" as const,
			label: entry.label,
			oauthAppId: entry.oauthAppId,
			accountEmail:
				typeof entry.accountEmail === "string" ? entry.accountEmail : undefined,
		},
	];
}

function normalizeGoogleCalendarIntegration(entry: Partial<IntegrationConfig>) {
	if (
		entry.connectorId !== "google-calendar" ||
		typeof entry.id !== "string" ||
		typeof entry.connectionId !== "string" ||
		typeof entry.label !== "string" ||
		typeof entry.enabled !== "boolean" ||
		(entry.interval !== "5m" &&
			entry.interval !== "15m" &&
			entry.interval !== "1h" &&
			entry.interval !== "6h" &&
			entry.interval !== "24h")
	) {
		return [];
	}

	const config = entry.config as { selectedCalendarIds?: unknown } | undefined;
	return [
		{
			id: entry.id,
			connectorId: "google-calendar" as const,
			connectionId: entry.connectionId,
			label: entry.label,
			enabled: entry.enabled,
			interval: entry.interval,
			config: {
				selectedCalendarIds: Array.isArray(config?.selectedCalendarIds)
					? [
							...new Set(
								config.selectedCalendarIds.filter(
									(value): value is string =>
										typeof value === "string" && value.trim().length > 0,
								),
							),
						]
					: [],
			},
		},
	];
}

export function createGoogleCalendarConnectorPlugin(
	options: CreateGoogleCalendarConnectorOptions = {},
): ConnectorPlugin {
	const runtime = new GoogleCalendarConnector(
		options.adapter ?? createGoogleCalendarAdapter(),
	);
	const setupMethods = [
		{
			kind: "provider-oauth" as const,
			providerId: "google" as const,
			requiredScopes: [...GOOGLE_CALENDAR_REQUIRED_SCOPES],
			connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
			connectionKind: "google-account",
			label: "Google OAuth",
		},
	];

	return defineConnectorPlugin({
		id: runtime.id,
		label: runtime.label,
		setupMethods,
		validate: runtime.validate.bind(runtime),
		sync: runtime.sync.bind(runtime),
		manifest: {
			id: runtime.id,
			label: runtime.label,
			setupMethods,
			cliAliases: [
				{
					key: "googleCalendar.enabled",
					async setValue(context, rawValue) {
						if (rawValue !== "true" && rawValue !== "false") {
							throw new Error(
								"googleCalendar.enabled must be `true` or `false`.",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-calendar",
						);
						if (!integration) {
							throw new Error("Missing default Google Calendar integration.");
						}
						integration.enabled = rawValue === "true";
						return `Set googleCalendar.enabled=${integration.enabled}`;
					},
				},
				{
					key: "googleCalendar.interval",
					async setValue(context, rawValue) {
						if (
							rawValue !== "5m" &&
							rawValue !== "15m" &&
							rawValue !== "1h" &&
							rawValue !== "6h" &&
							rawValue !== "24h"
						) {
							throw new Error(
								"googleCalendar.interval must be one of: 5m, 15m, 1h, 6h, 24h",
							);
						}
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-calendar",
						);
						if (!integration) {
							throw new Error("Missing default Google Calendar integration.");
						}
						integration.interval = rawValue;
						return `Set googleCalendar.interval=${integration.interval}`;
					},
				},
				{
					key: "googleCalendar.selectedCalendarIds",
					async setValue(context, rawValue) {
						const integration = context.config.integrations.find(
							(candidate) => candidate.connectorId === "google-calendar",
						);
						if (!integration || integration.connectorId !== "google-calendar") {
							throw new Error("Missing default Google Calendar integration.");
						}
						integration.config.selectedCalendarIds = [
							...new Set(
								rawValue
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
							),
						];
						return `Set googleCalendar.selectedCalendarIds=${integration.config.selectedCalendarIds.join(",")}`;
					},
				},
			],
		},
		render: {
			version: "1",
		},
		seedOAuthApps() {
			return [
				{
					id: DEFAULT_GOOGLE_OAUTH_APP_ID,
					providerId: "google",
					label: "Default Google OAuth App",
				},
			];
		},
		seedConnections() {
			return [
				{
					id: DEFAULT_GOOGLE_CONNECTION_ID,
					kind: "google-account",
					label: "Default Google Account",
					oauthAppId: DEFAULT_GOOGLE_OAUTH_APP_ID,
				},
			];
		},
		seedIntegrations() {
			return [
				{
					id: randomUUID(),
					connectorId: "google-calendar",
					connectionId: DEFAULT_GOOGLE_CONNECTION_ID,
					label: "Google Calendar",
					enabled: false,
					interval: "1h",
					config: {
						selectedCalendarIds: [],
					},
				},
			];
		},
		normalizeConnection: normalizeGoogleCalendarConnection,
		normalizeIntegration: normalizeGoogleCalendarIntegration,
	});
}

export function createGoogleCalendarConnector(
	options: CreateGoogleCalendarConnectorOptions = {},
): Connector {
	return createGoogleCalendarConnectorPlugin(options);
}
