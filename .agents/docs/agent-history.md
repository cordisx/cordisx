# Agent history Host architecture

## Outcome and boundary

CordisX exposes durable adapter history through the public
`cordisx.agent-history/v1` contract from `cordisx-protocol@e4c1fea`. The
service supplements, but never mutates, the generation-owned live
`ctx.agentEvents` ledger. A Timeline consumer can render both sources through
one store while retaining origin, coverage, and truth.

The first adapter imports Codex rollout JSONL for the exact selected Agent
session. It does not read prompt-history or transcription-history indexes, does
not expose a path picker, and does not give renderer code `HOME`, `CODEX_HOME`,
filesystem, file descriptor, path, offset, inode, source-line, or decrypt
authority.

## Planes and ownership

```text
plugin ctx.agentHistory.query/tail
        |
        v
renderer service -- Permission Broker -- session/generation fence
        |
        v
private randomized CDP binding (validated JSON only)
        |
        v
launcher AgentHistoryService
  resolver -> rollout parser -> redactor -> sparse snapshot/cache -> page
        |
        +-- selected Codex profile sessions/ and archived_sessions/
```

The launcher/Node plane owns all source access. The renderer service owns the
public call shape, caller identity, permission check, cancellation, generation
fence, and result validation. The plugin receives immutable serializable pages
only. The private binding follows the existing token-bound CDP binding pattern.
It is not published on `electronBridge`, plugin context, manager snapshot, or
diagnostics. Current plugins remain trusted renderer code and can inspect host
globals; therefore the binding accepts only this exact history RPC and never a
path or general filesystem operation. Capability enforcement is cooperative,
not renderer-process isolation.

The Host profile binding resolves one configured Codex data root. Requests name
only an Agent `sessionId`. Resolution checks the canonical rollout filename,
`session_meta` identity, realpath containment, regular-file status, and
active/archive roots. Symlinks, traversal, arbitrary paths, profile selection,
and Platform session references fail closed. Active-to-archive movement is
treated as the same logical source only when the validated session identity
and immutable prefix match.

## Parsing and projection

The importer accepts the bounded JSONL envelopes observed in supported Codex
rollouts: `session_meta`, `turn_context`, `response_item`, `event_msg`, and
`compacted`. It uses explicit session/turn/item/message/tool/call identities
and top-level timestamps where present. Older records without ordinal or item
completion are projected conservatively from their explicit record type.

Allowed public facts are session resume/compaction, turn lifecycle, item
lifecycle, user-message metadata, assistant/reasoning/tool/content references,
native status, and timing. Record-order lifecycle synthesis is `inferred`.
Direct source facts are `observed`. Imported events always use the
`codex-history` adapter source and never `cordisx` provenance.

The importer does not emit `message.delivery`, `input.contribution`, permission
decisions, prompt evaluation, claim/projection/forwarding, or model-consumed.
It ignores compaction replacement bodies, encrypted payloads, `world_state`,
token/rate/credit details, environment/cwd/git metadata, instructions, and
unrecognized content-bearing fields.

Default `referenced` payload policy emits identifiers, roles/kinds/status,
timing, sizes, and opaque references. `summarized` may emit a bounded redacted
summary for explicit message text. `inline` is separately prompted by the
broker and remains clamped, size-bounded, and secret-redacted. Raw tool
arguments/results, diffs, instructions, encrypted fields, credentials, paths,
and environment values are never inline. Redaction precedes caching,
diagnostics, logging, and binding serialization.

## Snapshot, paging, tail, and dedupe

Source lookup is exact and on demand. The Host never scans every JSONL body at
startup. For a selected file it builds an in-memory sparse index containing
record boundaries, projected event counts, time bounds, native identity keys,
and source fingerprints. The only persistent cache material in this slice is
a 32-byte HMAC key with mode `0600`; projected events and offsets are rebuilt
after restart, and the importer persists no content body.
Each call has line-size, bytes-read, event-count, and elapsed-time limits.

A snapshot binds source identity, size/mtime, immutable prefix fingerprint,
parser version, payload policy, profile, session, owner, and generation.
Opaque cursors are registry tokens, not encoded paths or offsets. One page has
at most 500 ascending events. Corrupt middle lines, oversized lines, and a
partial tail line are counted and skipped/retained without exposing their
contents. Truncation, replacement, incompatible parser change, or generation
replacement invalidates old cursors.

Tail uses bounded Node-side stat polling and a partial-line buffer. It opens no
renderer watcher. Appends create a new snapshot/page after a complete newline;
an unchanged tail returns no duplicate event. Plugin block, permission block,
fiber disposal, session switch, and generation disposal abort work and release
pollers, cursors, buffers, and source handles.

Stable event identity prefers native `(session, turn, item, message, tool,
call, fact phase)` keys. Missing identities use an HMAC over validated source
identity, parser/schema version, ordinal or byte offset, and projection
sub-index. Raw fingerprint ingredients never leave Node. Repeated imports and
restart reproduce the same identity for unchanged source. A Trace composite
provider deduplicates historical/live overlap by native fact key; the live
observation wins the duplicate while historical-only earlier facts remain.

## Permission and honest degradation

`agent.history.read` uses existing required/reason/fingerprint and
allow/ask/deny/timeout behavior with `scope.sessionIds`. The Host also binds the
call to the configured `codex-history` adapter and opaque profile. A renderer
cannot use a provider-aware Platform session scope to widen it. Requested
`inline` policy prompts independently; the Host may clamp any request to a less
revealing effective policy.

Current Desktop Agent forwarding may remain `unavailable` while history is
`complete` or `partial`. The two status surfaces are independent. Historical
events never upgrade live adapter mode and are never labeled live. A missing
history source reports sanitized `unavailable`; no selector, raw bridge,
second app-server, or renderer filesystem fallback is created.

## PR ownership and dependency order

1. `cordisx-protocol#18` owns `cordisx.agent-history/v1`,
   `agent.history.read`, schema, vectors, and conformance; merged as
   `e4c1fea227cb53e3a0833a0c84c5f9f487f107c5`.
2. The Host PR owns public TypeScript types, Permission Broker vocabulary,
   launcher resolver/parser/redactor/index/tail, randomized CDP binding,
   renderer service, lifecycle wiring, fixtures, and tests. It contains no
   Agent Trace UI or Codex selector.
3. A separate consumer PR owns the Trace composite provider, Timeline history
   status/coverage/paging, manager projection, README, fixtures, and renderer
   screenshots. It reads only public `ctx.agentHistory`/`ctx.agentEvents`.
4. A final CordisXMono PR updates compatible merged `cordisx` and
   `cordisx-protocol` gitlinks. Roadmap remains uninitialized and
   `update = none`.

## Validation matrix

| Layer         | Required evidence                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Contract      | valid/invalid page, max 500, scope, policy clamp, provenance, no path/provider/delivery leakage                  |
| Resolver      | active/archive, exact identity, profile separation, symlink/traversal refusal, movement                          |
| Parser        | old/current fixtures, session/turn/message/tool/timing/compaction, native-id preference                          |
| Robustness    | corrupt middle/tail, partial/oversized line, truncation/replacement, multi-GB sparse paging                      |
| Privacy       | secret fixtures, all payload policies, diagnostic/cache/binding no-content assertions                            |
| Paging/tail   | restart stability, duplicate import, 500 boundary, append, invalid/stale/cross-scope cursor                      |
| Lifecycle     | A/B switch, allow/ask/deny/timeout, block/restore, generation/fiber dispose                                      |
| Consumer      | one store seam, historical/live/fixture origin, overlap dedupe, stable ordering, coverage UI                     |
| Real renderer | selected old session metadata-safe projection, current app route/header/DOM/URL preservation, report/screenshots |
