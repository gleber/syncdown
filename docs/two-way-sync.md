# Two-Way Sync — Design Proposal

- Status: draft
- Owners: @gleber
- Related work:
  [PR #1 — Google Calendar push](https://github.com/gleber/syncdown/pull/1),
  [PR #2 — Todoist connector](https://github.com/gleber/syncdown/pull/2)

## 1. Background

Today `syncdown` is a one-way pipeline:

```
remote ──pull──▶ SourceSnapshot ──render──▶ Markdown file ──write──▶ disk
```

Users edit the resulting `.md` files, but those edits never flow back. Two open
PRs add push for two very different shapes:

- **PR #1 (Calendar)** — one event per file. Frontmatter + body parsed, diffed
  against the stored snapshot, pushed event-by-event over Calendar v3. Conflict
  = remote `updated > snapshot.sourceUpdatedAt`; resolution = last-local-wins,
  remote description appended as a note.
- **PR #2 (Todoist)** — one `TASKS.md` aggregating _all_ tasks across all
  projects. Markdown AST is parsed, individual list items are matched to remote
  tasks by `[id: "…"]`, the diff is replayed against the Todoist Sync API in a
  single batch (with `temp_id` for new items). Conflict = local-and-remote both
  diverged from last snapshot; resolution = duplicate the local item with
  `(Conflict)` suffix, drop the id.

Both work, but they collide on type signatures, state model, and where conflict
policy lives. Notion (the third target) is closer to Calendar in granularity but
closer to Todoist in update semantics (block-level patches, not whole-document
replace).

This doc proposes a **single push pipeline** that subsumes all three, drawing
concepts from both PRs without forcing one shape onto the other.

## 2. Goals

1. One `ConnectorPlugin` API that supports two-way sync for connectors of any
   granularity (per-source files vs. aggregate files vs. block trees).
2. Local-change detection lives in the **sink layer**, not in connectors — the
   FS sink knows about files; connectors know about remote semantics.
3. A unified **conflict model** with pluggable resolution policy (`local-wins`,
   `remote-wins`, `duplicate`, `merge`), choosable per integration and
   overridable per source.
4. Push is **idempotent and resumable**: a crashed push can be re-run without
   duplicating remote rows or losing local edits.
5. Direction modes (`down` / `up` / `two-way` / `dry-run`) are first-class, not
   connector-specific.
6. Existing one-way connectors keep working with no code changes — `push` is
   opt-in.

## 3. Non-goals

- Real-time CRDT-style merging of concurrent edits inside a single field.
  Field-level last-write-wins is enough.
- Reconciling renames/moves of local files. We treat a deleted-and-recreated
  file as `delete + create`, and document that the user should not rename files.
  (Future work: detect rename via stable id in frontmatter.)
- Pushing structural metadata that has no markdown representation (e.g. Notion
  block-level comments, Calendar attendee responses). These remain read-only.

## 4. Glossary

| Term                  | Meaning                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**            | Atomic unit of two-way sync. Calendar event, Todoist task, Notion page (or, if we go fine-grained, a single Notion block). Has a stable `sourceId` from the remote system. |
| **Document**          | A single markdown file on disk. May contain one source (Calendar), one source containing many sub-elements (Notion page), or many sources (Todoist `TASKS.md`).            |
| **Sub-element**       | An identifiable unit _inside_ a document that is not itself a `Source` but has its own remote id (Notion block, Todoist task line). Tracked via identity markers (§9).     |
| **Snapshot**          | `SourceSnapshot` — canonical normalized form of a source as syncdown last saw it. The diff base for both push and pull.                                                    |
| **Record**            | `SourceRecord` — bookkeeping (file path, hashes, `sourceUpdatedAt`). The "what was on disk last" pointer.                                                                  |
| **Local mutation**    | A change present in the local filesystem that is not in `state` yet. Created / updated / deleted.                                                                          |
| **Remote mutation**   | A change present in the remote system after the snapshot's `sourceUpdatedAt`.                                                                                              |
| **Conflict**          | Both a local and a remote mutation exist for the same source since the last snapshot.                                                                                      |
| **Identity marker**   | An inline token in the markdown that ties a sub-element to its remote id. `[id: "..."]` for Todoist tasks, `<!-- nb:abc123 -->` for Notion blocks. See §9.                 |
| **Typed frontmatter** | Frontmatter that records the _type_ of each property alongside its value, so push knows which API shape to use. See §10.                                                   |

## 5. Sync model

Each integration runs a **tick**. A tick is a three-phase cycle:

```
┌──────────────┐    ┌─────────────────┐    ┌─────────────┐
│ 1. detect    │───▶│ 2. push         │───▶│ 3. pull     │
│    local     │    │    local→remote │    │    remote→  │
│    changes   │    │                 │    │    local    │
└──────────────┘    └─────────────────┘    └─────────────┘
```

The pull phase already exists. We add phase 1 (detection, in the sink) and phase
2 (push, in the connector). Push runs **before** pull so the next pull observes
the canonical remote form and overwrites any half-rendered intermediate state.

This ordering matters: it means we never have to render-then-unrender a local
edit. After push, the remote is ground truth, and pull re-renders it the same
way it would for any other run.

### 5.1 Source-level vs. document-level

Connectors fall into three categories along two axes (file granularity ×
sub-element granularity):

- **Source-per-file, atomic body** (Calendar). Each `.md` file maps 1:1 to a
  `sourceId`. The body is opaque to the framework — diff = "did the bytes
  change". Detection compares per-file frontmatter + body to the stored
  snapshot.
- **Source-per-file, structured body** (Notion). Each `.md` file maps 1:1 to a
  `sourceId` (a page), but the body contains sub-elements (blocks) with their
  own remote ids. The framework still emits one `ParsedLocalSource` per file,
  but the connector's `push` does block-level diff/patch using identity markers
  (§9).
- **Many-sources-per-file** (Todoist). One `.md` file aggregates a list of
  sources. Detection requires a _connector-supplied parser_ that walks the file
  and emits `(sourceId, snapshot-fragment)` pairs.

The framework supports all three via a small detection-strategy interface (§7).

## 6. Data model changes

```ts
// New
export interface ParsedLocalSource {
  sourceId: string; // empty/temporary for newly-created sources
  snapshot: SourceSnapshot; // synthesized from the local file
  baseSnapshotHash?: string; // hash of the snapshot this edit was based on; null if new
  lastModifiedLocal: number;
}

export interface LocalStateModifications {
  created: ParsedLocalSource[];
  updated: ParsedLocalSource[];
  deleted: { sourceId: string; lastSnapshot: SourceSnapshot }[];
}

export type ConflictResolution =
  | "local-wins"
  | "remote-wins"
  | "duplicate" // keep both; one gets a "(Conflict)" suffix
  | "abort"; // skip this source, surface error

export interface ConnectorPushRequest extends ConnectorSyncRequest {
  changes: LocalStateModifications;
  conflictPolicy: ConflictResolution;
  direction: "two-way" | "up" | "down" | "dry-run";
}

export interface PushOutcome {
  sourceId: string; // may differ from request when newly created
  status:
    | "pushed"
    | "skipped"
    | "conflict-local-wins"
    | "conflict-remote-wins"
    | "conflict-duplicated"
    | "failed";
  finalSnapshot?: SourceSnapshot; // canonical form to persist; absent if push failed
  remoteUpdatedAt?: string;
  error?: string;
}

export interface ConnectorPushResult {
  outcomes: PushOutcome[];
  // Optional: connector may attach a freshly fetched snapshot for any source touched
  // during push so the framework can short-circuit the immediate-next pull.
  freshSnapshots?: SourceSnapshot[];
}

// Connector
export interface ConnectorPlugin extends Connector {
  push?(request: ConnectorPushRequest): Promise<ConnectorPushResult>;
  // Optional: connector can override default file-based detection. Required for
  // many-sources-per-file connectors (Todoist).
  detectLocalChanges?(ctx: DetectContext): Promise<LocalStateModifications>;
}
```

`DetectContext` carries the output dir, integration id, the list of
`SourceRecord`s, and the `Map<sourceId, StoredSourceSnapshot>` for the
integration. The default implementation lives in `sink-fs` (§7.1).

`StateStore` gains nothing new; we keep using `SourceRecord.sourceHash` and
`snapshotHash` as the diff base. The Todoist-style "blob of internal state"
pattern continues to work by stashing it in a synthetic `sourceId`
(`todoist-state`) — that's already how PR #2 does it and we shouldn't fight it.

## 7. Local-change detection

### 7.1 Default: per-file detection (Calendar, Notion)

`FileSystemSink.detectLocalChanges` (the function that PR #1 calls
`analyzeLocalModifications`):

1. List all `.md` files under `outputDir/<integration>`.
2. For each file: parse frontmatter + body, look up by `relativePath` in
   `SourceRecord`s.
   - **Not in records** → `created` (synthesize snapshot from frontmatter + body
     via the connector's `synthesizeFromMarkdown` hook, see §7.3).
   - **In records, content+frontmatter unchanged** → no-op. Use a content hash,
     not mtime, because syncdown writes its own files.
   - **In records, modified** → `updated`. The synthesized snapshot becomes the
     new desired state; the stored snapshot is the diff base.
3. For each record without a corresponding file → `deleted`.

### 7.2 Connector-supplied detection (Todoist)

The Todoist connector overrides `detectLocalChanges`. It parses `TASKS.md` into
an mdast, walks list items, and emits one `ParsedLocalSource` per task. The
connector also holds onto the AST so the push step can splice real ids back in
(§8.2). Implementation detail: the AST and any temp-id mapping live in
connector-private state passed via a closure or a `WeakMap` keyed by request —
they do **not** leak into core types.

### 7.3 Synthesis hook

Connectors that round-trip frontmatter need to tell the sink how to reconstruct
a `SourceSnapshot` from a parsed `.md` file. We add to `ConnectorRenderHooks`:

```ts
synthesizeFromMarkdown?(input: {
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  relativePath: string;
  baseSnapshot: SourceSnapshot | null;  // present for updates
}): SourceSnapshot;
```

This is the inverse of `extendFrontmatter` and `buildRelativePath`. It is
**required** for connectors that use the default detection. PR #1 inlines this
logic in `parse.ts`; we move it onto the connector where it belongs.

The implementation should:

- Strip read-only metadata that the framework injected for display (`syncdown_*`
  keys, computed fields like Notion `formula`/`rollup`/`last_edited_*`).
- Use `baseSnapshot` to fill in fields that the user can't edit through the
  markdown (block ids without identity markers, internal Notion property type
  info, etc.). Without `baseSnapshot` (i.e. for `created` sources), the
  connector either invents safe defaults or refuses to synthesize and the
  framework treats the file as un-pushable until next pull.

## 8. Push pipeline

### 8.1 Source-per-file, atomic body (Calendar)

Connector `push` walks `request.changes` and maps each to a remote API call:

```
created  → POST /events
updated  → PATCH /events/{id}
deleted  → DELETE /events/{id}
```

For each `updated`, the connector first fetches the current remote object and
compares `remote.updated` against `request.changes.updated[i]` base
`sourceUpdatedAt`. If newer → conflict; apply `request.conflictPolicy`.

After the API call succeeds, the connector returns a `PushOutcome` whose
`finalSnapshot` is the canonicalized post-push form (constructed from the API
response, not the local edit — this catches server-side normalization like
"Asia/Tokyo → +09:00"). The framework persists that snapshot, and the next pull
re-renders the file. If the file content changes as a result, the user sees
their edit "settle" into the canonical form.

### 8.2 Source-per-file, structured body (Notion)

Notion looks like Calendar at the file level (one page per file) but the body
has sub-element identity. Two distinct push paths:

**Property-only push** — frontmatter changed, body unchanged:

```
updated → pages.update { properties: {...}, archived?: bool }
```

Read-only properties (`formula`, `rollup`, `created_time`, `last_edited_time`,
`created_by`, `last_edited_by`, `unique_id`) are stripped before the call.
Property type info (typed frontmatter, §10) tells the connector whether
`"In Progress"` is a `select` or a `rich_text`.

**Body push** — block tree changed:

1. Parse local markdown into a block tree using a markdown→Notion-blocks
   converter (`@tryfabric/martian` for v1).
2. Walk both trees in parallel. For each block, look for an identity marker
   (`<!-- nb:<block-id> -->`) on the local side:
   - **Marker present, content unchanged** → no-op.
   - **Marker present, content changed** → `blocks.update <block-id>`.
   - **Marker absent** → new block. `blocks.children.append` after the previous
     matched block. Capture the returned id; the next pull will write the marker
     into the file.
   - **Remote block has no local counterpart** → `blocks.delete`.

Without identity markers (a fresh file the user wrote from scratch, or a file
from before block markers landed) the connector falls back to whole-tree
replace: delete all existing children, append the new tree. Destructive but
safe-ish for new pages.

**Create**:

```
created → pages.create (parent from pathHint) + blocks.children.append for the body
```

Idempotency via the external-id pattern (§11).

**Delete**:

```
deleted → pages.update { archived: true }
```

Notion has no hard-delete via API.

### 8.3 Many-sources-per-file (Todoist)

The connector receives `request.changes` from its own `detectLocalChanges`. It:

1. Translates each created/updated/deleted into Todoist sync commands
   (`item_add` with a `temp_id`, `item_update`, `item_delete`,
   `item_complete`/`uncomplete`).
2. Sends one batched `sync` call.
3. For each `temp_id` returned in `tempIdMapping`, builds a `PushOutcome` whose
   `sourceId` is the real id and whose `finalSnapshot` is the round-tripped
   task.
4. Returns. The framework then triggers a pull which re-fetches all tasks and
   rewrites `TASKS.md` from scratch — this is what makes the temp-id → real-id
   substitution land in the file without the connector having to re-stringify
   the AST itself.

This means **for aggregate-file connectors, the post-push pull is mandatory**,
not an optimization. The framework enforces it: if `direction === "up"` only, an
aggregate-file connector logs a warning that local ids may not be canonicalized
until the next two-way tick.

## 9. Identity markers

Whenever a connector wants surgical updates instead of whole-document
replacement, it needs a way to tie pieces of the local markdown to remote ids.
The framework doesn't define the marker format — that's connector-specific — but
it standardizes the **lifecycle**:

1. **Pull writes markers.** The renderer emits a marker for every sub-element
   with a stable id.
2. **Push reads markers.** The connector parses the local file, extracts
   markers, matches them to known ids.
3. **Push backfills markers.** When push creates new sub-elements, it returns a
   `PushOutcome.finalSnapshot` containing the new ids; the post-push pull
   re-renders the file with markers attached.
4. **Markers must round-trip pull → no-edit → pull byte-identically.** This is
   the invariant that makes detection sound. We test it per connector with a
   property-test.

Connector-specific marker formats:

| Connector           | Marker                        | Where                                                                          |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Todoist             | `[id: "TASK_ID"]`             | inline at end of task line (already exists)                                    |
| Notion blocks       | `<!-- nb:BLOCK_ID -->`        | end of the line that closes the block, or on its own line for container blocks |
| Notion (page-level) | frontmatter `notion_page_id:` | top of file                                                                    |

Markers should be **opaque to the user**. HTML comments are invisible in most
markdown previewers; the Todoist `[id: "..."]` is visible but stable enough that
users learn to ignore it. We accept that minor visual cost as the price of
two-way sync.

**Edit invariants users must know about:**

- Don't manually edit a marker.
- Don't duplicate a marker (copy-pasting a block within a Notion file). The
  connector treats the second occurrence as the "real" one and deletes the first
  remote block, then creates a new block from the second.
- Removing a marker but keeping the content = "I want to fork this into a new
  sub-element". Connector creates a new remote item; the original remote item is
  left dangling unless the file no longer references it (then it's deleted by
  the same diff that creates the new one).

These are documented per connector. They are not enforced by the framework.

## 10. Typed frontmatter

Pull writes property values into frontmatter. Push needs to know what type each
property is to call the right API shape. For Calendar this is implicit (every
property has a fixed shape — `start`, `end`, `summary` are well-known). For
Notion, properties are user-defined: a key called `Status` could be `select`,
`rich_text`, `multi_select`, or `status`.

We solve this by writing a small sidecar block of property type info into
frontmatter on pull:

```yaml
title: "Project kickoff"
Status: "In Progress"
Tags: ["urgent", "Q2"]
Due: "2026-05-12"
syncdown:
  property_types:
    Status: select
    Tags: multi_select
    Due: date
  read_only: [Created, Last edited]
  page_id: "abc123-..."
```

A few principles:

- All sync-internal frontmatter lives under a single `syncdown:` key. Easier for
  users to spot, easier to strip.
- `read_only` lists fields the user can edit visually but that we will not push
  back. The connector silently discards changes to those fields with a warning
  in the log.
- `synthesizeFromMarkdown` consumes `syncdown:` before reconstructing the
  snapshot and never copies it into `metadata` — it's pull-side bookkeeping.

This pattern is also useful outside Notion: Calendar can move `calendarAllDay`
and `calendarRecurrence` under `syncdown.read_only` to discourage users from
hand-editing them. Worth doing as part of phase 2.

## 11. Conflict resolution

The framework decides _whether_ a conflict exists; the connector decides _how to
apply_ the chosen policy, because only the connector knows what "merge" means
for its data shape.

### 11.1 Conflict detection

For an `updated` source, conflict iff:

```
storedSnapshot.sourceUpdatedAt is non-null  AND
remoteSnapshot.sourceUpdatedAt > storedSnapshot.sourceUpdatedAt
```

(Pull this check up out of the connector. PR #1 currently does it inline per
event; that's fine for Calendar but we want it consistent.)

For aggregate connectors, "remote updated" is per-source, not per-file. Todoist
already does this by comparing each task against `state.localState[id]`.

### 11.2 Policies

| Policy                                  | Effect                                                                                                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-wins` (default for events/pages) | Push local. If the connector supports preserving the discarded remote value as a markdown note (Calendar's "Conflict Note" block), do so. Otherwise just overwrite.                                        |
| `remote-wins`                           | Skip push. The next pull will overwrite the local file with the remote state. User's edit is lost — log loudly.                                                                                            |
| `duplicate` (default for tasks)         | Strip the id from the local copy and push it as a new source. Add `(Conflict)` to the title. The original remote source is left alone; the next pull brings it back into the file alongside the duplicate. |
| `abort`                                 | Skip the source, count it in `failedIds`, surface to user. Useful in CI/dry-run contexts.                                                                                                                  |

Policy is configured at integration level in
`IntegrationConfig.config.conflictPolicy`, with a sensible per-connector
default.

### 11.3 Why "duplicate" is the right Todoist default

In a single TASKS.md, "local-wins" silently destroys remote edits the user never
saw. "Remote-wins" silently destroys local edits. Duplicate keeps both visible
and lets the human reconcile. PR #2 already does this; we just promote it to a
named policy.

## 12. Direction modes

```ts
type SyncDirection = "two-way" | "up" | "down" | "dry-run";
```

| Mode      | Phase 1 (detect) | Phase 2 (push)         | Phase 3 (pull) |
| --------- | ---------------- | ---------------------- | -------------- |
| `two-way` | yes              | yes                    | yes            |
| `up`      | yes              | yes                    | no             |
| `down`    | no               | no                     | yes            |
| `dry-run` | yes              | log only, no API calls | no             |

Today's behavior (one-way) maps to `down`. We default new integrations to `down`
and require an explicit opt-in to `two-way`, because two-way sync of a connector
that hasn't been hardened can corrupt remote data.

## 13. Idempotency and crash recovery

The push must be safe to re-run after a crash mid-tick.

- **Created sources**: the framework persists the `PushOutcome.finalSnapshot`
  immediately on success of each individual create. If we crash before
  persisting, the next tick will see the same local file again and try to create
  it again, producing a duplicate on the remote. Mitigation depends on the
  connector:
  - **Todoist** — `temp_id` plus the local `id`-marker scheme. After crash, the
    local file may have already been re-rendered with the real id (rare race) or
    may still have a temp id (common). The next detection step treats a missing
    id as "create"; the connector dedupes by querying the Sync API for any task
    with matching content created within the last few minutes by the same user.
    Imperfect, but Todoist offers no idempotency key.
  - **Notion** — the **external-id pattern**. For pages destined for a database
    whose schema we control: ensure the schema has a `syncdown_external_id`
    rich-text property; before each `pages.create`, generate a UUID and
    `databases.query` for an existing page with that id. If found, reuse it
    instead of creating. The id is also written into the page so subsequent
    pulls expose it as part of the typed frontmatter (under
    `syncdown.external_id`, never editable). For pages outside a database
    (top-level workspace pages), no schema = no marker; we accept duplicate risk
    and warn in docs.
  - **Calendar** — Calendar v3 has neither idempotency keys nor a queryable
    client-id property. Accept duplicate risk; document it. Future option: use
    `extendedProperties.private.syncdown_external_id` plus a `events.list` call
    with a privateExtendedProperty filter, at the cost of one extra API call per
    create.
- **Updates**: idempotent by construction (same PATCH twice = same result), as
  long as we re-check the conflict precondition each attempt. For Notion
  block-level updates: the same applies per block.
- **Deletes**: idempotent; 404 on second attempt is treated as success.

Push outcomes are written to state one at a time, not in a single transaction. A
partial push leaves the integration in a consistent state where un-pushed
sources remain pending.

## 14. CLI surface

PR #1 adds `syncdown push` as an alias for `run` that hits the push path. We
keep that, plus:

```
syncdown run            → two-way (or whatever the integration is configured for)
syncdown run --pull-only → force direction=down for this run
syncdown run --push-only → force direction=up
syncdown run --dry-run   → direction=dry-run
syncdown push            → alias for run --push-only
```

`--pull-only` is the safety hatch when the user has uncommitted local edits they
aren't ready to push.

## 15. Per-connector responsibilities

| Concern                  | Calendar                                     | Todoist                                  | Notion                                                        |
| ------------------------ | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| File granularity         | source-per-file                              | many-per-file                            | source-per-file                                               |
| Sub-element granularity  | none (atomic body)                           | per-task                                 | per-block                                                     |
| Detection                | default (sink)                               | connector (`detectLocalChanges`)         | default (sink)                                                |
| `synthesizeFromMarkdown` | required                                     | n/a (connector parses AST)               | required                                                      |
| Identity markers         | n/a                                          | `[id: "..."]` inline                     | `<!-- nb:... -->` per block + `notion_page_id` in frontmatter |
| Typed frontmatter        | minor (mostly fixed schema)                  | n/a                                      | required (user-defined property types)                        |
| Create idempotency       | best-effort (privateExtendedProperty + list) | best-effort (content+window dedupe)      | `syncdown_external_id` property + database query              |
| Default conflict policy  | `local-wins`                                 | `duplicate`                              | `local-wins`                                                  |
| Conflict-as-note         | description block                            | n/a (duplicate task)                     | callout block at end                                          |
| Post-push pull required  | no                                           | yes                                      | yes (to backfill block-id markers for newly created blocks)   |
| Markdown↔native body    | identity (description is plain text)         | mdast (already supports both directions) | needs markdown→blocks library (martian for v1)                |

Two Notion-specific implementation risks worth calling out separately:

1. **Round-trip fidelity.** Notion pull goes blocks → markdown via
   `pages.retrieveMarkdown`. Push goes markdown → blocks via martian (or
   equivalent). The round-trip is lossy: callouts, columns, toggles, synced
   blocks, embeds have no canonical markdown form. Without identity markers, a
   user who pulls and immediately pushes (with no edit) would see those blocks
   rewritten or dropped. Identity markers let us keep "owned by syncdown" blocks
   in their original form by skipping them entirely during push when they
   haven't changed. We must property-test `pull → no-op → pull` for
   byte-identical output before two-way ships.
2. **Property type drift.** Typed frontmatter records the type at pull time. If
   the user changes a Notion property's type in the Notion UI (e.g. `select` →
   `multi_select`), the stored type is stale and push fails. Mitigation: re-read
   property types as part of every push (one extra `databases.retrieve` per
   integration per tick) and write a clear error if a stale type is detected.

## 16. Implementation plan

The plan below is written as a sequence of small, individually shippable PRs.
Each one is reviewable on its own, leaves `main` in a working state, and adds at
most one new user-visible capability. The hard ones are split into a
"behavior-flagged" PR followed by a "promote the flag" PR, so each merge is
reversible without painful rollback.

Throughout: **direction defaults to `down`**. New `up` / `two-way` capability is
opt-in per integration until phase E lands.

### 16.1 PR #1 — Read-only Todoist (no two-way yet)

**Why first:** PR #2 currently mixes pull, push, and the watcher. Land the pull
side alone so we can review and merge Todoist without committing to any of the
two-way design choices. The push code stays on a branch until phase D.

**Scope:**

- New package `@syncdown/connector-todoist`.
- Pull-only `sync` implementation: hits the Todoist Sync API once per tick with
  `sync_token`, fetches active + completed items + projects, renders to
  `TASKS.md` via the existing renderer.
- The `[id: "..."]` inline marker is rendered (so phase D doesn't have to
  migrate file format).
- The internal sync state (`sync_token`, last `localState`) is persisted as a
  synthetic `SourceSnapshot` with `sourceId === "todoist-state"` — same trick PR
  #2 uses; it works fine and changing it later is cheap.
- Connector-level config: `syncCompletedMonths`, `outputDir` subdir.
- **Cut from PR #2:** the file watcher (`chokidar`), `pushLocalCommands`, the
  up/two-way modes, the `applyRemoteChanges` mutation path. All of those move to
  phase D.
- The mdast parser stays — it's used to render `TASKS.md` even in read-only
  mode. But it never mutates remote state.

**Success criteria:** user can `syncdown run --connector todoist`, get a
`TASKS.md`, and re-running produces a byte-identical file.

### 16.2 PR #2 — Foundations: core types

**Scope:** purely additive type changes in `@syncdown/core`. No runtime behavior
changes anywhere.

- Add `ParsedLocalSource`, `LocalStateModifications`, `ConnectorPushRequest`,
  `ConnectorPushResult`, `PushOutcome`, `ConflictResolution`, `SyncDirection`
  (`"two-way" | "up" | "down" | "dry-run"`).
- Add optional `push?` and `detectLocalChanges?` to `ConnectorPlugin`.
- Add optional `synthesizeFromMarkdown?` to `ConnectorRenderHooks`.
- Add `direction?: SyncDirection` to `RunOptions`, default `"down"`. Plumb
  through `ConnectorSyncRequest` so connectors can read it.

Existing connectors keep working. Tests stay green. CI green = merge.

### 16.3 PR #3 — Foundations: default sink detection + frontmatter namespace

**Scope:**

- Implement `FileSystemSink.detectLocalChanges` (default file-based: walk dir,
  parse frontmatter+body, diff against `SourceRecord`+`StoredSourceSnapshot`).
- Move sync-internal frontmatter keys (e.g. `calendarEventId`,
  `notionProperties`) into a `syncdown:` namespace (§10). Pull renders them
  there; pull → re-render is byte-identical.
- Add identity-marker helpers (`parseMarker`, `injectMarker`, `stripMarkers`) in
  a new `@syncdown/core/markers` module. Connectors can pick a format; the
  helpers handle the lookup.
- Add a `--direction` CLI flag and the `--push-only` / `--pull-only` aliases
  (§14). For now `up` and `two-way` are still no-ops at the connector level —
  the flag just plumbs through.

**Risk:** the frontmatter namespace move is breaking for downstream tooling that
parses the existing keys directly. Document the migration in the PR description;
ship a one-shot migrator that rewrites existing `.md` files in place.

### 16.4 PR #4 — Foundations: push orchestration

**Scope:**

- `runIntegrationSync` gains the three-phase tick (§5): when
  `direction !== "down"` and `plugin.push` exists and
  `services.sink.detectLocalChanges` exists, call detect → push → pull.
  Otherwise fall through to today's pull-only path.
- Framework-level conflict detection: compare `remote.updated` against stored
  `sourceUpdatedAt` for each `updated` source, populate `conflictPolicy` from
  integration config.
- Per-source `PushOutcome` is persisted incrementally (one source at a time, not
  in a batch transaction), so a crashed push leaves state consistent.
- No connector implements `push` yet. So with all existing integrations on
  `direction: "down"` (the default), behavior is unchanged.

**Success criteria:** all existing tests pass. A skeleton "noop push" connector
test exercises the orchestration end-to-end.

### 16.5 PR #5 — Calendar two-way

**Why this is the easiest connector to do first:** atomic body, no sub-elements,
no markdown↔native conversion, well-defined REST CRUD.

**Scope:**

- Calendar implements `synthesizeFromMarkdown` (inverse of `extendFrontmatter` /
  `buildRelativePath`).
- Calendar implements `push`: create/update/delete events. Conflict policy =
  `local-wins` with the discarded remote description appended as a callout block
  (matches PR #1's behavior).
- Default integration config sets `direction: "two-way"` once the test plan
  covers create/update/delete + conflict.
- `extendedProperties.private.syncdown_external_id` for create-side idempotency.
  Adds one `events.list` filter call per `created` source. Acceptable.

**Effectively a rebase of PR #1** onto the new contract. Conflict-detection code
that PR #1 inlines moves to the framework; the connector only implements policy
application.

### 16.6 PR #6 — Todoist two-way

**Scope:**

- Todoist implements `detectLocalChanges` (mdast walk over `TASKS.md`, emit one
  `ParsedLocalSource` per task line). Internal AST and temp-id maps held in a
  request-scoped `WeakMap`, not the `setRequest` global from PR #2.
- Todoist implements `push`: batch sync commands, temp-id mapping, drop the
  `setRequest` global.
- Conflict policy = `duplicate`: clone the local task with a `(Conflict)` suffix
  and a stripped id; the original remote task survives the next pull.
- Watcher (`chokidar`) optionally lands here behind a `notify_on_change: true`
  integration setting. Default off — most users will be fine with the configured
  `interval`. If on, file changes trigger a tick out-of-band.
- **Identity-marker invariant** (§9) documented in `apps/cli/README` and in the
  connector's own README: don't hand-edit the `[id: "..."]` block; copy-pasting
  tasks creates duplicates on remote.

### 16.7 PR #7 — Notion two-way

This is the largest connector PR by far, but ships behind feature flags so most
of it is dark code until the flags flip. The internal phasing (4a–4d in the
previous draft) collapses into a single PR with three flags:

- `notion.push_properties` — property-only push. **On by default.**
- `notion.body_markers` — pull writes `<!-- nb:... -->` block markers. **Off by
  default.**
- `notion.push_body` — body push (whole-tree replace if `body_markers` is off,
  block-level diff if on). **Off by default.**

**Scope:**

- Typed frontmatter (§10): `syncdown.property_types`, `syncdown.read_only`,
  `syncdown.page_id`. Pull writes; `synthesizeFromMarkdown` consumes.
- Property-only push: `pages.update` with the typed-frontmatter-shaped
  properties. Strips read-only fields. Re-reads property types per tick to
  detect schema drift.
- Idempotency: `syncdown_external_id` rich-text property + `databases.query`
  before create. Documented limitation: only works for pages in databases.
- `notion.body_markers` flag: pull renders block-id markers. Default off; users
  opt in per integration.
- Markdown→blocks via martian (or chosen alternative — settled by the open
  question §17.6). Vendored or pinned exactly.
- `notion.push_body` flag: when on, push computes block-level diff if markers
  present, falls back to whole-tree replace if not.
- Conflict policy = `local-wins` with discarded remote body preserved as a
  `<callout>` block at end of page.
- Round-trip property-test: `pull → re-render with no edit → pull`. Must produce
  byte-identical files. Gates the `notion.body_markers` flag.
- Round-trip block-test: `pull → roundtrip-via-martian → push → pull`. Must
  produce semantically equivalent blocks (some Notion-side normalization is
  unavoidable, e.g. trailing whitespace in rich text). Gates the
  `notion.push_body` flag.

The PR can be reviewed in three commits matching the three flags. They merge
atomically because the marker format and the synthesis hook share types and
would be hellish to coordinate across separate PRs.

### 16.8 PR #8 — Promote two-way to default

After Calendar and Todoist have run for a release cycle without bug reports
against push:

- Default new Calendar / Todoist integrations to `direction: "two-way"`.
- Existing integrations stay `down` until the user opts in (config migration is
  a no-op; we just don't auto-flip).
- Notion stays `down` by default until `notion.push_body` has at least one
  stable release. The `notion.push_properties`-only flow may be promoted
  earlier.

### 16.9 Dependency graph

```
PR1 (Todoist read-only) ───────────┐
                                   ├─▶ PR6 (Todoist two-way)
PR2 (core types) ──▶ PR3 (sink) ──▶ PR4 (orchestration) ──┬─▶ PR5 (Calendar two-way)
                                                          ├─▶ PR6 (Todoist two-way)
                                                          └─▶ PR7 (Notion two-way) ──▶ PR8 (default)
```

PR1 is independent of the foundations. PRs 5/6/7 can run in parallel once PR4
lands. PR8 waits for stability rather than for a specific PR.

### 16.10 What stays out of v1

- Renames (still requires the §17.4 design decision).
- Apple Notes two-way (writeback to AppleScript is feasible but out of scope;
  would be its own PR after v1).
- Gmail push (the API doesn't support meaningful writes other than labels and
  trash; not worth it).
- The TUI conflict dashboard (§17.2). Phase D logs conflicts; the TUI surfaces
  them in a follow-up.

## 17. Open questions

1. **Where does direction live?** Per-integration setting? Per-CLI-invocation
   flag? Both, with flag overriding setting? (Lean: both.)
2. **How do we surface conflicts in the TUI?** A "needs-attention" badge per
   integration with a list of conflicted sources?
3. **Do we want a "stage and review" mode?** I.e. detect changes, render a diff,
   require user confirmation before pushing. Useful for the first few weeks of
   two-way Notion. Probably yes, gated behind a config flag.
4. **Renames.** Treating rename-as-delete-plus-create destroys the remote
   source. The `syncdown.page_id` (or equivalent) inside frontmatter under typed
   frontmatter (§10) gives us a stable handle that survives renames; if we honor
   it for _all_ connectors uniformly, renames just work. Worth doing as part of
   phase 1 rather than deferring.
5. **Schema migrations of `SourceSnapshot`.** Two-way amplifies the cost of
   breaking the snapshot shape — a migration now has to canonicalize _both_
   what's on disk and what's in `state`. We should freeze the snapshot schema
   once two-way ships.
6. **Notion: which markdown→blocks library?** Martian is the obvious choice but
   unmaintained as of late 2024. Alternatives: write our own thin converter on
   top of `remark` (more work, full control), or `notion-markdown-cli`. Decision
   needed before phase 4c.
7. **Notion: do we need block-id markers for _every_ block, or only for
   sub-elements that have content the user is likely to edit?** Markers on every
   paragraph clutter the file. A halfway option: markers only on blocks at depth
   ≤ 2 and on container blocks. Push falls back to whole-subtree replace for
   unmarked deep nesting. Lower fidelity, much cleaner files.

## 18. Summary

PR #1 and PR #2 each invented their own push pipeline. They diverge less than
they look — both reduce to:

> Detect local mutations against the last snapshot. Translate to remote API
> calls. Apply with conflict policy. Re-pull to canonicalize.

The proposal above factors that out: **detection** is a sink/connector
capability, **translation** lives in the connector's `push`, **conflict
detection** is in the framework, **conflict policy** is configurable and applied
by the connector.

Three cross-cutting patterns make Notion fit alongside Calendar and Todoist
without polluting the core types:

- **Identity markers** (§9): inline tokens in markdown that tie sub-elements to
  remote ids. Format is connector-specific (`[id: "..."]` for Todoist,
  `<!-- nb:... -->` for Notion); lifecycle is uniform.
- **Typed frontmatter** (§10): a `syncdown:` block in frontmatter that records
  property types, read-only fields, and stable ids — everything push needs that
  pull alone wouldn't write down.
- **Connector-specific idempotency keys** (§13): each connector picks the best
  mechanism its API supports, framework just calls it. `temp_id` for Todoist,
  external-id property for Notion, best-effort for Calendar.

Notion is the most demanding consumer of all three. The Notion rollout is split
across phases 4a–4d so each capability ships behind a flag and is exercised
against the round-trip property test before promotion.
