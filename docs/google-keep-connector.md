# Google Keep Connector — Design & Implementation Plan

- Status: implemented
- Owners: @gleber
- Scope: one-way incremental pull (Keep → Markdown). Two-way push is out of
  scope for v1; see [two-way-sync.md](./two-way-sync.md) for the eventual
  push framework.

## 1. Background and the API problem

Google Keep has **no official API for consumer `@gmail.com` accounts**. The
official REST API (`keep.googleapis.com`) is restricted to Google Workspace
Business/Enterprise/Education editions and requires a service account with
domain-wide delegation enabled by a Workspace admin — an individual user
cannot self-enable it ([overview](https://developers.google.com/workspace/keep/api/guides),
[tracking issue 263769283](https://issuetracker.google.com/issues/263769283)).

### Decision

Implement a **TypeScript port of the reverse-engineered internal Keep API**
(the same one the Android app and the Python
[`gkeepapi`](https://github.com/kiwiz/gkeepapi) library use). Rationale:

- Works with personal accounts (the target user base).
- Natively supports **true incremental sync** via version tokens — better than
  the official API, which has no delta mechanism at all.
- Self-contained in the Bun/TS monorepo; no Python sidecar dependency.

Alternatives considered and rejected:

| Option | Why rejected |
| --- | --- |
| Official `keep.googleapis.com` | Enterprise-only; unusable for personal accounts; no incremental sync. |
| Python `gkeepapi` subprocess | Mature, but drags a Python runtime into a Bun project; process-management and packaging pain. |
| Google Takeout import | Not incremental, not automatable. |

Known risks of the chosen approach are collected in §9.

## 2. Auth: the gpsoauth flow

The internal Keep API authenticates as the Android Keep app. The chain has
three tokens:

```
browser oauth_token  ──exchange──▶  master token (aas_et/…)  ──perform_oauth──▶  access token (~1 h)
     (one-time, manual)                (long-lived, stored)           (per-sync, cached in memory)
```

1. **One-time user step**: log in at `https://accounts.google.com/EmbeddedSetup`
   in a browser and copy the `oauth_token` cookie (value starts with
   `oauth2_4/`). This is the only manual step.
2. **Token exchange** (`oauth_token` → master token): form-POST to
   `https://android.clients.google.com/auth` with
   `Token=<oauth_token>`, `ACCESS_TOKEN=1`, `add_account=1`, `service=ac2dm`,
   `accountType=HOSTED_OR_GOOGLE`, `has_permission=1`, `Email`, `androidId`,
   `source=android`, `device_country=us`, `operatorCountry=us`, `lang=en`,
   `sdk_version=17`.
   Response is `key=value` lines; `Token=aas_et/…` is the master token.
   On failure the response contains an `Error=` line (e.g. `BadAuthentication`).

   > **`has_permission=1` is required.** Without it, Google now rejects the
   > consumer-account exchange with `Error=MissingDroidguard` (HTTP 400),
   > demanding a DroidGuard device-attestation blob that a pure-TS client cannot
   > produce. Because the `oauth_token` from EmbeddedSetup already encodes the
   > user's grant, `has_permission=1` lets the endpoint skip attestation.
   > Verified end-to-end 2026-07-20 against a real `@gmail.com` account.
3. **OAuth for Keep** (master token → access token): form-POST to the same URL
   with `EncryptedPasswd=<master_token>`,
   `service=oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders`,
   `app=com.google.android.keep`,
   `client_sig=38918a453d07199354f8b19af05ec6562ced5788`,
   plus the same base params. Response line `Auth=<access token>` (+ `Expiry=`).

Notes:

- `androidId` is an arbitrary but stable device id; derive it
  deterministically, e.g. first 16 hex chars of `sha256(accountEmail)`.
- The connector should accept **either** token form as the stored secret: if
  the secret starts with `oauth2_4/` it exchanges it once and overwrites the
  secret with the master token (via `request.secrets.setSecret`); if it starts
  with `aas_et/` it uses it directly.
- Access tokens are cached in memory per master token until expiry.
- This deliberately does **not** touch the shared Google OAuth plumbing in
  `packages/core/src/google-auth.ts` — the consumer OAuth client cannot obtain
  the `memento` scope, so Keep gets its own token-kind connection instead
  (mirroring the Todoist pattern).

## 3. Sync protocol: `notes/v1/changes`

Single endpoint: `POST https://www.googleapis.com/notes/v1/changes` with
header `Authorization: OAuth <access_token>`.

Request body (down-sync only — we push no nodes):

```jsonc
{
  "nodes": [],
  "clientTimestamp": "<ISO-8601 now>",
  "requestHeader": {
    "clientSessionId": "s--<epoch-ms>--<random>",
    "clientPlatform": "ANDROID",
    "clientVersion": { "major": "9", "minor": "9", "build": "9", "revision": "9" },
    "capabilities": [
      { "type": "NC" }, { "type": "PI" }, { "type": "LB" }, { "type": "AN" },
      { "type": "SH" }, { "type": "DR" }, { "type": "TR" }, { "type": "IN" },
      { "type": "SNB" }, { "type": "MI" }, { "type": "CO" }
    ]
  },
  "targetVersion": "<last toVersion>"   // omit for a full sync
}
```

Response:

```jsonc
{
  "kind": "notes#downSync",
  "toVersion": "…",          // next cursor value
  "truncated": true,          // more pages: repeat with targetVersion = toVersion
  "forceFullResync": false,   // server demands a full resync
  "nodes": [ … ],             // changed nodes only (when targetVersion given)
  "userInfo": { "labels": [ { "mainId": "…", "name": "…" } ] }
}
```

Protocol rules:

- **Full sync**: omit `targetVersion`; server returns every live node (paged
  via `truncated`).
- **Incremental**: pass the stored `targetVersion`; server returns only nodes
  changed since. Loop while `truncated`, feeding back `toVersion`.
- **Stale version**: an HTTP 400 when `targetVersion` was sent (or
  `forceFullResync: true`) means the token expired server-side → wipe local
  cache and re-run as a full sync.

### Node model

Nodes form a two-level tree:

- Top-level nodes (`parentId: "root"`): `type: "NOTE"` or `"LIST"`. Carry
  `title`, `color`, `isArchived`, `isPinned`, `timestamps {created, updated,
  trashed, deleted}`, `labelIds: [{labelId}]`, `serverId`.
- Child nodes (`parentId: <note id>`): `type: "LIST_ITEM"` (carries `text`,
  `checked`, `sortValue`, `superListItemId` for one level of indenting) and
  `type: "BLOB"` (image/audio attachments — v1 records their existence in
  metadata but does not download media).
- A `NOTE`'s body is the `text` of its (normally single) child `LIST_ITEM`.
- **Deletion semantics**: a node arriving with `timestamps.deleted` set (a
  non-epoch value) or **without a `parentId`** is a permanent deletion.
  `timestamps.trashed` set to a non-epoch value means the note is in the
  trash. Unset timestamps are serialized as the epoch
  (`1970-01-01T00:00:00…Z`), so "set" means "present and not epoch".
- **Label names** arrive in `userInfo.labels` (id → name); nodes reference
  labels by id only, so the id→name map must be cached.

## 4. Incremental state: cursor design

The changes stream returns *changed nodes only*. A single edited `LIST_ITEM`
arrives alone — rebuilding its note's Markdown requires the sibling items.
Therefore the connector must persist a **node cache** between runs, stored in
the integration cursor (an opaque string via `StateStore.get/setCursor`,
`packages/core/src/types.ts:493-495`), exactly like other connectors persist
their sync tokens:

```ts
interface StoredGoogleKeepCursor {
  version: 1;
  keepVersion: string;                      // last toVersion from the server
  nodes: Record<string, CachedKeepNode>;    // minimal projection, all live nodes
  labels: Record<string, string>;           // labelId -> label name
}

interface CachedKeepNode {
  id: string;
  parentId: string;                         // "root" for top-level nodes
  type: "NOTE" | "LIST" | "LIST_ITEM" | "BLOB";
  title?: string;
  text?: string;
  checked?: boolean;
  sortValue?: string;
  superListItemId?: string;
  color?: string;
  archived?: boolean;
  pinned?: boolean;
  trashed?: boolean;
  created?: string;
  updated?: string;
  labelIds?: string[];
  serverId?: string;
}
```

Decode/encode mirrors `StoredGoogleCalendarCursor`
(`packages/connector-google-calendar/src/index.ts:487-560`): JSON parse,
validate `version`, and on any mismatch return `null` to force a clean full
resync. Size estimate: ~200 bytes/node; even thousands of notes stay in the
low MBs, acceptable for a JSON cursor. If it ever becomes a problem the cache
can move to its own secret-free state table, but not in v1.

## 5. Sync algorithm

```
sync(request):
  creds  = resolve auth (secret + connection.accountEmail); upgrade oauth2_4/ → aas_et/ if needed
  cursor = decodeCursor(request.since)
  full   = cursor == null
  cache, labels, version = full ? ({}, {}, null) : cursor fields
  affectedRoots = {}

  attempt (at most twice — second attempt is the forced-full-resync retry):
    do:
      resp = adapter.fetchChanges(creds, version)
      if resp.forceFullResync or (HTTP 400 with version set):
          full = true; cache = {}; labels = {}; version = null; restart attempt
      merge resp.userInfo.labels into labels
      for node in resp.nodes:
          root = (node.parentId is "root" or missing) ? node.id : node.parentId
          affectedRoots.add(root)
          if isPermanentlyDeleted(node): delete cache[node.id]
          else: cache[node.id] = project(node)
      version = resp.toVersion
    while resp.truncated

  roots = full ? all cache entries with parentId == "root" : affectedRoots
  for rootId in roots:
      note = cache[rootId]
      if note missing, trashed, or deleted:  request.deleteSource(rootId)
      else:                                   request.persistSource(buildSnapshot(note, cache, labels))
      setProgress({unit: "items", completed, total})

  if full:
      // purge sources deleted while we had no valid cursor
      for record in request.state.listSourceRecords(integrationId):
          if record.sourceId not in live roots: request.deleteSource(record.sourceId)

  return { nextCursor: encodeCursor({version: 1, keepVersion: version, nodes: cache, labels}) }
```

`request.throwIfCancelled()` is called per page and per rendered note.

### Markdown rendering

- `NOTE` → body is the child item's `text`, verbatim.
- `LIST` → GFM task list. Items sorted by numeric `sortValue` descending
  (Keep's ordering), unchecked items before checked ones (matches Keep UI);
  items with `superListItemId` render indented two spaces under their parent
  item. `- [ ] text` / `- [x] text`.
- Snapshot fields (conventions per
  `packages/connector-google-calendar/src/index.ts:430-485`):
  - `sourceId`: node id; `entityType`: `"keep-note"`; `slug`: slugified title
    (fallback `"untitled"`); `snapshotSchemaVersion`: `"1"`.
  - `pathHint`: `{ kind: "keep-note" }`.
  - `metadata`: `sourceUrl` (`https://keep.google.com/#NOTE/<id>`),
    `createdAt`, `updatedAt`, `archived`, `keepNoteId`, `keepColor`,
    `keepPinned`, `keepLabels` (names resolved through the label map).
  - `sourceHash`: `sha256(stableStringify(...))` over the snapshot base, using
    `stableStringify` from `@syncdown/core`.
- Output paths (new branch in `packages/renderer-md/src/path-builder.ts`):
  `google-keep/notes/<slug>-<id>.md`, archived notes under
  `google-keep/archive/`. Trashed notes are never rendered (treated as
  deletes).

## 6. Package layout

New workspace package `packages/connector-google-keep/` (template:
`templates/connector-package/`, live example: `packages/connector-todoist/`):

```
packages/connector-google-keep/
├── package.json          # @syncdown/connector-google-keep, dep: @syncdown/core workspace:*
├── tsconfig.json         # extends ../../tsconfig.base.json, noEmit
└── src/
    ├── gpsoauth.ts       # GpsOAuthClient: exchangeAuthToken(), performOAuth(); injectable fetch
    ├── keep-api.ts       # HttpGoogleKeepAdapter: fetchChanges(); access-token cache; injectable fetch
    ├── index.ts          # cursor codec, node cache, markdown rendering, Connector + plugin factory
    └── index.test.ts     # bun:test, fake adapter (no network)
```

The connector consumes an injectable adapter interface so tests never hit the
network (pattern: `GoogleCalendarAdapter`,
`packages/connector-google-calendar/src/index.ts:78-111`):

```ts
interface GoogleKeepAdapter {
  fetchChanges(
    credentials: { email: string; masterToken: string },
    targetVersion: string | null,
  ): Promise<KeepChangesResponse>;
  exchangeAuthToken?(email: string, oauthToken: string): Promise<string>;
}
```

## 7. Wiring checklist (file-by-file)

Follows the **Todoist minimal-touch pattern** (token connection normalized by
the plugin itself; no legacy fallbacks in core; no TUI changes — Todoist
shipped without any `packages/tui` edits).

**`packages/core/src/types.ts`**
- `GoogleKeepTokenConnectionConfig { kind: "google-keep-token"; accountEmail?: string }`;
  add to the `ConnectionConfig` union (types.ts:127-132).
- `GoogleKeepIntegrationSettings = Record<string, never>`;
  `GoogleKeepIntegrationConfig = BaseIntegrationConfig<"google-keep", …>`;
  add to the `IntegrationConfig` union (types.ts:193-199).
- `DocumentPathHint.kind` union += `"keep-note"` (types.ts:228-236).
- `SourceMetadata` += `keepNoteId?`, `keepColor?`, `keepPinned?`,
  `keepLabels?: string[]` (types.ts:246-288).

**`packages/core/src/config-model.ts`**
- `export const DEFAULT_GOOGLE_KEEP_CONNECTION_ID = "google-keep-token-default"`
  (alongside config-model.ts:28). No fallback connection/integration entries —
  the plugin's `seedConnections`/`seedIntegrations` provide them, as Todoist's do.

**`packages/core/src/index.ts`**
- Re-export `DEFAULT_GOOGLE_KEEP_CONNECTION_ID` and the two new config types.

**`packages/connector-google-keep/src/index.ts`** (the new package)
- Setup method: `{ kind: "token", connectionId: DEFAULT_GOOGLE_KEEP_CONNECTION_ID,
  connectionKind: "google-keep-token", label: "Master Token",
  secretName: (connectionId) => connectionId }`.
  The explicit `secretName` matters: `resolveConnectionAuth`
  (`packages/core/src/execution.ts:170-193`) otherwise falls back to the
  Notion secret-name scheme, while the CLI stores the secret under the bare
  connection id.
- `validate()`: integration enabled; `resolvedAuth.kind === "token"` with
  `connectionKind === "google-keep-token"`; `connection.accountEmail` present.
- `seedConnections` / `seedIntegrations` / `normalizeConnection` /
  `normalizeIntegration`: mirror `packages/connector-todoist/src/index.ts:57-203`,
  preserving `accountEmail` on the connection.
- `manifest.cliAliases`: `google-keep.enabled`, `google-keep.token` (secret),
  `google-keep.email`.
- `render`: `{ version: "1" }` (paths handled centrally in path-builder).

**`packages/connectors`**
- `package.json`: add `"@syncdown/connector-google-keep": "workspace:*"`.
- `src/index.ts`: import and append `createGoogleKeepConnectorPlugin()` to
  `createBuiltinConnectorPlugins()` (index.ts:12-19). Platform-independent (no
  darwin gate).

**`packages/renderer-md/src/path-builder.ts`**
- `getFileIdentifier`: `kind === "keep-note"` → use `metadata.keepNoteId`.
- `buildRelativePath`: `kind === "keep-note"` →
  `join(connectorId, metadata.archived ? "archive" : "notes", fileName)`.

**`apps/cli/src/config-inspect.ts`**
- Add `"google-keep"` to the `getIntegrationReaders` connector-id union
  (config-inspect.ts:84-92).
- Register readers under the `googleKeep` prefix + `googleKeep.token`
  secret-presence reader + `googleKeep.email` reader (pattern:
  config-inspect.ts:184-195).

**`apps/cli/src/connect-commands.ts`**
- `connectGoogleKeep(io, args, secrets)`: flags `--email <addr>` and
  `--token <value|--stdin>`. Accepts `oauth2_4/…` or `aas_et/…`; stores the
  secret under the connection id, sets `connection.accountEmail`, enables the
  integration (pattern: `connectTodoist`, connect-commands.ts:430-458).
  Optionally exchange `oauth2_4/…` → master token eagerly at connect time for
  fail-fast UX; the connector still handles lazy upgrade.
- `disconnectGoogleKeep`: delete secret, disable integration
  (pattern: connect-commands.ts:518-532).
- Register provider `"google-keep"` in `handleConnectCommand` /
  `handleDisconnectCommand` (connect-commands.ts:460-480, 534-556).

**`apps/cli/src/program.ts`**
- Usage lines: `syncdown connect google-keep --email <addr> --token <value|--stdin>`;
  add `google-keep` to the disconnect provider list (program.ts:56-57).

**Docs**
- `apps/docs/content/docs/connectors/google-keep.mdx` (+ locale variants),
  including the EmbeddedSetup cookie walk-through and the unofficial-API
  caveat.

## 8. Testing plan

`packages/connector-google-keep/src/index.test.ts` (bun:test, fake adapter,
fake `ConnectorSyncRequest` with stub `StateStore`/`SecretsStore` — pattern:
calendar connector tests):

1. **Full sync**: NOTE + LIST (checked/unchecked/indented items) + labels →
   correct snapshots (`bodyMd`, metadata, path hints), `nextCursor` carries
   `toVersion` + node cache.
2. **Truncated paging**: two-page full sync merges into one cache.
3. **Incremental list-item edit**: run sync, feed `nextCursor` back, adapter
   returns only the changed `LIST_ITEM` → the note re-renders with *all*
   items (cache reconstruction).
4. **Trash / permanent delete** (incl. parentId-less deletion nodes) →
   `deleteSource` called; cache entry dropped.
5. **Stale version**: adapter throws 400 / returns `forceFullResync` on the
   first call → full resync path, stale state-store records purged.
6. **Cursor codec**: round-trip; invalid/legacy JSON → `null` (full resync).
7. **Token upgrade**: secret `oauth2_4/…` → `exchangeAuthToken` invoked once,
   `setSecret` stores the `aas_et/…` master token.
8. **gpsoauth response parsing**: `key=value` bodies, `Error=BadAuthentication`
   surfaces a useful message (unit tests on `gpsoauth.ts` with stub fetch).
9. **CLI**: extend `apps/cli/src/connect-commands.test.ts` and
   `config-inspect.test.ts` for the new provider/keys.

Manual verification: `syncdown connect google-keep …`, `syncdown run
--connector google-keep` twice against a real account; confirm the second run
is a no-op and an edit in the Keep UI produces exactly one file change.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Unofficial API changes/breaks without notice | Adapter isolated in `keep-api.ts`; version-gated cursor lets us force clean resyncs; failures surface as normal integration errors, other connectors unaffected. |
| ToS gray area / account flagging (Google sees an "Android device" login) | Document clearly in the connector docs; read-only usage with modest polling intervals (default `1h`) keeps the footprint minimal. |
| Master token is a powerful credential | Stored via the existing encrypted `SecretsStore`, never logged; docs recommend revoking the "device" from Google account settings on disconnect. |
| Cursor growth (node cache) | Minimal field projection (~200 B/node); revisit only if real-world sizes demand a separate store. |
| `BadAuthentication` after password change / token revocation | `validate()` reports actionable error: re-run `syncdown connect google-keep`. |

## 10. Out of scope / future work

- **Two-way push** (edit Markdown → update Keep): the `changes` endpoint
  accepts node mutations in `nodes: []`, so push fits the
  [two-way-sync.md](./two-way-sync.md) framework later (Keep even provides
  `baseVersion` for conflict detection).
- **Media blobs** (images, drawings, audio): downloadable via the notes
  media endpoint; v1 only records their existence in metadata.
- **Reminders** (separate reminders API, already covered by the requested
  OAuth scope).
- **Label-folder layout** (one folder per label) — conflicts with
  multi-label notes; revisit with user feedback.
