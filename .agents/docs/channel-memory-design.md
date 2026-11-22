# Channel memory proposal

Status: locally implemented core with remaining extension/publication gates
(2026-11-22), not deployed.
The delivery ledger below distinguishes tested code from proposed capabilities.
This document does not
grant message-history access or activate automatic personal-data collection.

## Local implementation ledger (2026-11-22)

### Current integration update (supersedes earlier gap notes below)

The iterative implementation now resolves own-topic group disclosure from the
accepted incoming message via ChannelAgentAccess, bounded to owned-topic
matches. Configured actor/source administrators are stored in a CAS local
authority registry; Agent metadata cannot configure it. Natural grant input
normalizes source/destination conversation IDs and uses that resolver.
grant/revoke/list operate on retained memory, including future content and new
destination members. Single-use expiring human identity challenges require
confirmation by the actual second-account context and explicit challenge text.

Consumer composes persona registry and local administration operations. Native
start injects the bounded configured capsule and pins the session, suppresses
same-version repeats, reinjects changed profile/style or reset epochs and keeps
old tasks pinned after rebind. Continuation preparation also receives the
configured identity. Memory tools resolve the task's persona directory. Style
defaults/conversation overrides are explicit configured preference data used
before generating final/manual user-visible text, never rewriting tool JSON.

Every scoped native business prompt includes concise save/update/recall guidance,
independently of whether an identity capsule is configured or repeated. Useful
task milestones, verified progress, decisions and corrections should be retained
selectively; search/get precedes revision-checked updates of the same assertion.
Questions about other conversations first use authorized retrieval, with source
time and uncertainty preserved. This does not import transcripts, infer person
identities, configure a persona, or grant broader access. It guides the model's
choice of tools; it does not guarantee that every useful fact is saved.

Chinese own-topic questions extract the explicitly owned subject, stripping
question/progress framing instead of treating the whole sentence as a keyword.
Generic requests such as "my project progress" without a subject do not disclose
all private records in a group. Existing owner, identity and scoped-grant checks
continue to filter every result.

The verified owner may read their own retained records in the same source
conversation without an explicit recall phrase, so ordinary progress messages
can find and update existing assertions. This does not open other members'
records, another account's records, or cross-group retrieval without the existing
topic or grant checks.

Tests exercise actual native start/bridge prompt assembly and real command
grant/revoke/new-member/challenge/confirmation flows. Real-model corrected
own-topic, admin grant/new-member and cross-platform confirmation runs passed.
See the validation reference for precise versions/results; earlier blocked
records below retain historical evidence and do not describe these fixes.

Remaining gaps: cross-account persona task reuse still requires explicit human
binding or scoped grants; unknown context resets must notify the reset seam.
Platform-sourced admin attestations beyond explicit operator configuration,
account/personal style layers/unset semantics, styled Host-owned fixed progress
copy, ask-specific model coverage, global lesson promotion, semantic search,
context neighbors/source excerpts and public Protocol publication remain gates.

### Progressive retrieval as the corpus grows

`guide` lists small discoverable topics; `guide --input '{"topic":"write"}'`
(or `organize`/`recall`) loads only the relevant instructions. Write guidance
covers one reusable assertion/event/decision per record, self-contained
subject/date/reason/source, confirmed alias/entity pointers, fact/claim/impression
distinctions, search-before-write and revision-checked correction. Organize
guidance explains current tag/entity indexes and explicitly identifies missing
supersedes graphs, transactional preview/apply/revert and relation indexes.
These are instructions, not silent new schema or authorization capabilities.

Do not build a growing root summary or inject all records. Retrieval proceeds
from small authorized navigation pointers (project/entity/time/source), to
paged hit cards, to selected `get`/`batch`, then bounded context neighbors and
authorized source excerpts only when needed. The model chooses relevance and
stops once sufficient evidence is available. Derived summaries are rebuildable
and retain provenance; they never confer identity or grant authority.

Implemented bounded layer: `navigate` and `search-page` return at most 20 cards
(default 8), under a caller-selected 512–16,384 byte budget (default 4,096).
Cards contain stable ID/revision, title, short derived text, entity/project/time
and source pointers, not full records. Navigation omits text. Search matches
stored keyword/tag/entity aliases without loading person profiles. Round-robin
source ordering diversifies results; revision-bound pagination invalidates after
correction, deletion or grant changes. `batch` admits at most eight selected
records under a separate byte budget. Older `search` remains compatibility-only.

Not implemented: semantic/vector expansion, canonical alias registry, date-range
routing, explicit supersedes chains, context-neighbor retrieval and authorized
source-excerpt provider. Keywords must actually match; paraphrase success is
measured in the real-model large-corpus scenario, not claimed from design intent.
The current manifest still grows internally and has a 4 MB capacity limit; a
sharded scoped index is required beyond that floor. Byte budgets conservatively
bound payloads but no tokenizer-specific token quota is yet implemented.

Dedicated worktree: `channel-memory`, branch
`codex/channel-memory-design-20261122`. No automatic ingestion, deployment,
restart, commit, or publication is part of this delivery.

- Host storage is implemented in
  `packages/cli/src/launcher/channel-memory-store.ts`, with identity/grant policy
  in `channel-memory-policy.ts` and safe atomic files in `channel-memory-files.ts`.
  Immutable record revisions become visible through one atomic state manifest;
  interrupted writes leave unreferenced revisions rather than replacing the
  current record. The manifest contains bounded keyword/entity metadata; search
  returns at most 20 metadata results and 16 KiB, scans at most 2,000 candidates,
  and loads selected record content on demand. Stored files are capped at 4 MB.
- `cordisx channel memory remember|get|search|update|forget|index` uses the existing
  configured Host RPC, profile and active incoming context. Input JSON contains
  `record`, `id`, `revision`, or `query`/`entity` as appropriate. Actor, provenance
  and source scope come from `ChannelAgentAccess.caller`, not JSON. CRUD supports
  explicit records only; it does not establish that a model-supplied summary
  contains solely the author's contributions.
- Direct-chat self recall is non-admin. Group own-topic disclosure is supported
  by the policy engine when verified `ownDisclosure` is supplied, but **not yet
  admitted by the production command**: message text or a caller boolean is not
  authority. Existing destination grants are evaluated at each read/search.
- Directed full-source grants cover retained past and future memory records of
  every kind. A destination conversation target includes new members only when
  requesting in that conversation. Reciprocal sharing requires two separately
  authorized edges. Expiry, bounded record-ID grants and immediate revocation
  are implemented. `grant`, `revoke` and `grant-list` CLI requests fail closed
  until an authorized provider is integrated; they are not production-supported
  administrator commands merely because the storage operations exist.
- Account tuples distinguish Feishu, WeChat, QQ, Telegram and Discord.
  `bindConfirmed` is an internal storage primitive requiring already-confirmed
  accounts, with collision protection and self-unbind. There is **no exposed
  bind/confirm operation** or provider challenge flow. CLI `identity-unbind`
  removes the verified caller's binding only. Entity targets and bound-account
  self recall work in synthetic tests, not a live platform binding workflow.
- `tests/channel-memory.test.ts` uses synthetic IDs/content for non-admin self
  recall, own-topic authorization, A→B future content/new members, unrelated
  destination denial, unilateral/reciprocal grants, revoke/expiry, binding
  collision/unbind, CRUD/search/index recovery, traversal/symlink rejection,
  metadata injection, real Host context resolution and interrupted revisions.

### Required owner changes and remaining gates

The pinned Protocol checkout is unavailable here; these are integration gaps,
not a verified claim about the latest upstream Protocol. Before exposing plugin
support, `cordisx/cordisx-protocol` must supply a versioned public memory service and
operation schemas, verified incoming account/person/conversation identity
projection, source-specific memory-grant administration (including revocation
authority), and trusted explicit own-topic disclosure intent with audience.
It must also define binding challenge/confirmation and collision/unbind
lifecycle, adapter capability/unavailability projections, structured errors and
grant audit semantics. The existing Host dispatch token is implemented, but is
not a substitute for these public memory contracts. No plugin-facing service,
private Host permission fallback, or fabricated platform admin support is added.

Missing integration: provider-verified administrator capabilities, natural
language grant/revoke/list routing and concise audience warning, authenticated
cross-platform challenges, person roles/alias confirmation, collaboration and
conversation-purpose evidence workflows, retention/audit policy, and live
adapter tests. The generic record kinds alone do not complete these workflows.
Grants do not change platform remote-history/message-get capabilities.

Deletion removes indexed content first and then record revisions; interrupted
deletion can leave inaccessible files. Orphan revision cleanup, stale-lock
operator recovery, backup retention and production privacy review remain gates.
The single-writer lock fails closed rather than guessing that another process
is dead. Filesystem protection assumes the private runtime directory is not
concurrently replaced by another process with the same OS-user privileges.

### Local validation evidence

Real-model scenario harness and separate evidence boundaries are documented in
[real-model validation](channel-memory-model-validation.md).

Focused Vitest: 9 new memory tests and 5 existing conversation-tool tests pass.
Strict TypeScript checking of storage/files/policy passes with the existing
temporary toolchain's Node types. Package-wide typecheck is blocked by absent
repository dependencies, including Node types, `@cordisx/protocol`, Cordis and
Channel runtime declarations. The existing command-composition test cannot
load `@larksuiteoapi/node-sdk`. No dependency installation or incompatible Aiden
Darwin package workaround was attempted; the full suite was not run.

A delegated read-only Codex review completed. Its update disclosure, global
index traversal and permissive-directory findings were corrected; account/entity
grants are now direct-context only, while conversation grants supply explicit
group destinations. Residual retention and missing Protocol verification gates
remain documented above. This is synthetic implementation evidence, not live
platform or formal delivery evidence.

## Goal and ownership

### Scoped assistant context profiles (design only)

Latest user decision supersedes the earlier single-global-persona restriction:
support **multiple persona spaces, each with one continuous configurable
assistant identity**. Each persona owns its profile, distilled general lessons,
guidance/index namespaces, scoped memories and contextual overrides. One persona
may bind multiple platform bot connection accounts, including several accounts
on the same adapter. Conversation tasks through those accounts use that space;
context adapts its role/style without creating another identity.

Resolve exactly one explicit effective persona per task. Account-to-persona
binding is not assumed many-to-many: a future authorized task override must be
explicit. Task records retain personaId and binding revision. Rebinding affects
new tasks; existing tasks remain pinned. Explicit migration is a separate,
currently unsupported operation, never a silent merge of memories. Within a
persona, record scope grants still apply. Cross-persona access requires explicit
authorized export/share, not account rebinding or identity continuity.

Local staged foundation: `channel-memory-personas.ts` implements schema-v1
profiles, CAS account bindings, persisted task resolution and separate memory
directories per persona. Profile name/identity input has a 2,048-byte cap; this
is not enforcement of the entire proposed root capsule budget. One account has
one current persona binding, and old tasks retain their original revision.
Synthetic tests cover two fake adapter accounts sharing a persona, separate
persona isolation, rebind pinning and scope denial. This internal registry is
not wired into production Channel dispatch or memory CLI:
verified local administration, Protocol contracts and task lifecycle plumbing
are still required. No claimed caller persona ID is accepted as authority.

#### Automatic initialization capsule boundary

##### User-visible delivery style (staged design)

Apply effective persona/conversation style before generating **all user-visible
outbound text**, not merely the automatic final: manual send/send-many, ask
questions and displayed option labels, and progress notifications use the same
delivery-preparation context. Internal planning, technical/tool data, raw
memory/index records and ask semantic option values remain untouched. Do not
request, expose or test private chain-of-thought. No mandatory second-model
rewrite: generation gets the style once, preserving facts/uncertainty and never
claiming delivery or making promises without evidence.

The latest playful examples illustrate possible explicitly configured styles;
they do not authorize setting defaults or mutating any persona. Respect the
earlier preference for normal good-night language rather than dramatic promises
to stay awake or guard someone. Context/current-request overrides still apply.

Inspected outputs: consumer completion sends automatic final text; conversation
tools dispatch manual send/send-many; ChannelQuestions constructs question
notifications/cards with unchanged option values. These paths currently lack a
shared verified persona-style preparation service. Such a service should
provide one versioned destination-aware generation context, not rewrite tool
payloads after generation. Manager/system progress copy also requires owning
notification integration. This is staged design, not production style support.

Acceptance: with a configured style, model-generate an auto reply and equivalent
manual send/ask/progress text; verify factual/style consistency, unchanged ask
values and normal raw technical outputs. No fixed exact phrases or private
reasoning fixtures. This scenario is not yet run because mock memory tools do
not implement outbound delivery and production style routing is missing.

`ChannelMemoryPersonas.bootstrap` now builds a schema-v1 capsule from a
persisted task/account binding and the pinned persona's current profile. It
contains personaId/profile revision/binding revision/name/identity, an explicit
preference-not-policy trust label and memory guide/navigation pointers. The
entire serialized capsule is capped at 2,048 UTF-8 bytes. No historical memory,
credentials or private evidence are loaded. Reopening the registry preserves
task pinning; profile changes are reflected on the next builder invocation,
without following a rebound account into a different persona.

Inspected production path: `ChannelConversationConsumer.pump` obtains the
verified `record.input.source.event`, builds message context, then calls
`ChannelNativeSessions.start`; that method builds the Channel prompt and calls
`start_session` or `send_message`. `startContinuation` constructs a separate
preparation prompt, and `startLiveBusiness` handles takeover business turns.
These paths currently have **no persona-registry initialization hook**. Adding
a capsule only to a mock prompt would not prove production initialization.

Required integration: resolve/persist effective persona before first turn,
deliver capsule at first turn or explicit reset/recovery, retain an acknowledged
persona/profile revision per context epoch, and suppress repeats within that
epoch. At an idle subsequent turn admit updated profile revision; an account
rebind must not migrate existing tasks. Recovery must revalidate the pinned
binding/task before loading any capsule/memory. Missing admission or mismatch
must remain unavailable, not select a default persona. Protocol must establish
initialization-context provenance/lifecycle and authorized binding ownership
before exposing this as a plugin contract.

The real-model `persona-blank-bootstrap` prototype uses the actual registry
builder automatically for each blank model context. It tests recognizing a
configured identity and progressively retrieving facts, **not** production
initialization, resume deduplication, safe-turn application or persona-scoped
memory routing. Effective role/style overrides and general-principle pointers
remain absent because their stores/merge/promotion are not implemented.

Human person entities and their role scopes below represent people, confirmed
accounts, aliases and observations. They are distinct from the assistant
identity profile; neither human entity binding nor role scope creates an
assistant persona. Assistant identity configuration remains separate from
factual memory, human profiles and access grants.

#### Distilled continuous experience (design; promotion not implemented)

Top-level experience is not an event diary. Keep the stable assistant identity
minimal and expose only a few cross-context reusable distilled lessons beside
it; explicit identity/style settings remain separate from historical lessons.
Person/group/project episodes, petty observations and incidental chatter stay
in their original local scopes. A single observation never automatically
becomes a global rule.

Promotion requires an explicit user request, or an evidence-backed proposed
generalizable rule supported by multiple contexts or recurrences and accepted
explicitly before application. Strip identifiers and private anecdotes from
the proposed lesson. Preview the abstraction and audience; search for existing
lessons, deduplicate or revision-check updates, and retain competing/conflicting
claims rather than silently installing a contradictory rule. Lessons remain
fallible historical learning, not settings, instructions or permissions.

Store supporting evidence/provenance links separately in authorized local
scopes. Loading a global lesson must not load or disclose private excerpts,
source titles or anecdotes; a link does not grant evidence access. Index deeper
experience on demand with bounded pointers/cards, not an expanding startup
summary. Proposed hard limit: the entire serialized root capsule is at most
2,048 UTF-8 bytes, including stable identity, effective context and selected
lesson pointers. If over budget, omit optional lessons or reject an oversized
identity edit; never silently enlarge the limit or concatenate every lesson.

Acceptance must mix local trivia and recurrent useful observations, verify
trivia remains local, propose an identifier-free lesson, promote only after
explicit confirmation, and verify dedup/conflict updates and a bounded capsule
as detailed experience grows. These are remaining acceptance gates: there is
no global lesson store, propose/promote command, root-capsule builder or budget
enforcement yet. Generic remember stays local and cannot stand in for promotion.

Explicit editable context profiles are separate from facts, derived indexes and
grants. Layers: global → platform/account → conversation (group/direct), with
personal preferences applied only contextually. Current request overrides style;
conversation settings override inherited defaults. Missing means inherit;
explicit unset means remove/suppress that inherited field, not an empty-string
preference. Profile fields include purpose, assistant role, language, verbosity,
tone and stable project/entity pointers. A tiny boot capsule should contain
only those active settings and pointers; deeper facts stay on-demand.

Do not derive authoritative profiles from historical messages. Private personal
preferences must not be disclosed to a group or automatically override its
professional style. Style never changes permissions. A full A→B memory grant
does not merge profiles: recall of A in B uses B's effective context and current
request. Explicit profile edits require separate revision-checked operations
and source attribution, with explainable precedence and distinct unset values.

Only the internal versioned persona profile/account/task registry is implemented.
Production profile/account-binding CLI, context merge resolver and boot capsule
are not implemented. The real-model style-separation scenario is therefore blocked and
cannot establish professional-group versus casual-private behavior. Passing
direct-chat style following alone would not prove durable profile support or
authorized group recall. Public profile contracts remain an owner contribution.

Provide a CLI-first, directory-backed memory service across Channel adapters.
Keep durable facts, explicit preferences, people aliases, collaboration events,
and conversation purposes discoverable without loading complete chat histories.
The generic storage and authorization service belongs to Host; externally
observable contracts require a versioned Protocol contribution. Platform
adapters supply verified source identities, not separate memory databases.

## Identity and scopes

Source references retain adapterId, accountId, tenantId, conversationId,
messageId, actor userId, and observed time. Platform IDs are namespaced opaque
identifiers; never infer a name from an ID. Support Feishu/Lark, WeChat, QQ,
Telegram, Discord, and future adapters without treating their IDs as equivalent.
Connect identities across accounts or platforms only with explicit authorized
confirmation; matching display names alone is insufficient.

Use a stable person entityId and a dedicated role scope to collect verified
platform-account references, confirmed aliases, collaboration records and
dated impressions. A binding records adapterId, accountId, tenantId, userId,
display name, verification method, verifier, verifiedAt and revocation state.
Account references are identifiers, not passwords, access tokens or sessions.
The entity's role scope is a profile namespace, not an authorization role.

Prefer a short-lived single-use binding challenge initiated by an authorized
actor and confirmed through the other platform's verified Channel identity.
Administrative attestations must be explicitly distinguished from proof of
account control. A forwarded challenge or matching display name is not proof.
Support unbinding, conflict review and correction without silently merging
entities or deleting their provenance. Binding identities does not merge
conversation ACLs, disclose private records, or grant permissions inherited
from another account. Every recall still checks the actual current caller,
destination and record scope, including records referenced by a role scope.

Scopes are explicit: conversation-private, actor-private, project-shared, and
operator-managed shared spaces. Default writes stay conversation-private.
Each shared space has an owner, allowed readers/writers, and eligible source
conversations. Scope creation, grants, cross-scope publication, and identity
links are distinct authorized operations, not effects of saving a memory.

A user in conversation A can explicitly save a permitted summary into shared
space P. In conversation B, search P only if the verified caller and destination
are authorized readers. Membership in both conversations does not itself grant
cross-group disclosure. Search filters scopes before ranking and returns no
titles, snippets, counts, or existence hints from denied scopes. Memory never
expands the Channel message-get parent-chain or remote-history permission.

### Administrator grants and contextual disclosure

Do not make conversation isolation an irreversible barrier. A verified
administrator with the relevant memory-grant capability can authorize a bounded
recall through natural language or a command. The agent translates that intent
into the same CLI grant operation; Host checks the actual actor's configured
authority, never a claimed administrator title in message text. Grants record
source scope, recipient or destination, purpose, expiry and revocation state.
Prefer a one-request grant when persistent sharing was not requested. Show a
short clarification only when the source, audience or requested scope is unclear.

For example, an authorized person asking in a group to recall their own earlier
private discussion can authorize topic-bounded retrieval and disclosure of the
relevant summary to that group. Distinguish permission to retrieve from permission
to publish: an unrelated private detail or another participant's confidential
information is not covered. Do not routinely require a second confirmation when
the request already identifies both the topic and current audience. A memory
grant does not unlock platform history permissions; fetch original messages only
through an independently supported, authorized history operation. Otherwise use
the permitted stored memory and state that original history was not fetched.

Another person's request does not inherit that grant. Let the agent explain
naturally that private conversations cannot be shared with them, without a fixed
refusal template or leaking the private topic. For group-origin content, reuse
information already available to the requesting audience instead of blanket
refusal. Across groups, consider existing shared-scope grants, intended audience
and confidentiality; being said in a group does not make content globally public.

Keep a small deterministic boundary for verified identity, explicit grants,
revocation and unauthorized file access. Within eligible records, let the agent
decide relevance, useful context, redaction and wording. Code should not attempt
absolute semantic privacy guarantees or block every cross-conversation recall;
model judgment must not manufacture privileges or execute instructions from
historical records. Tests cover both successful authorized disclosure and denial,
including own-private-topic recall in a group and ordinary group-context recall.

Recall is not administrator-only. Ordinary users and other configured roles can
recall their own eligible private or group contributions across conversations,
using verified identity bindings and applicable personal or shared grants. A
self-recall request may authorize disclosure of the caller's own relevant
contribution to the current audience; it does not expose everyone else's private
replies or an entire source conversation. Existing grants can permit broader
recall without requiring administrator intervention for each question.

Administrators with the relevant grant-management authority can also issue
persistent, full-conversation grants, rather than topic-only grants. Model each
grant as a directed source-to-recipient edge: source conversation A may be fully
read and summarized in destination B, or by a specified person/entity. Explicit
two-way sharing creates both edges; do not infer reciprocity from a one-way
request. Full sharing removes memory-level topic and message-kind restrictions
for eligible retained content, not platform capabilities or credentials limits.
Keep the source identity tuple and tenant/account administrative boundary.

A destination-conversation grant targets the conversation itself, not a snapshot
of its members. Any verified caller making a request within B, including newly
joined members, receives this access while the grant is active. It does not
require per-member grants or grant the same caller access from unrelated chats.
Explicitly record whether the grant covers existing records and future records;
an instruction to fully connect the conversations covers both unless narrowed.
Warn succinctly that current and future members can access source content, but
do not demand repeated approval for an unambiguous authorized instruction.

Person grants target a verified account or explicitly bound entity, with defined
permitted destinations; they are distinct from destination-conversation grants.
Support listing, narrowing and revoking either kind. Recheck active grants and
current request context for every search/read and invalidate dependent cached
results on revocation. Acceptance tests include non-admin self-recall, full A-to-B
sharing across message kinds, a new member asking inside B, an unrelated chat
being denied, one-way versus two-way access, and immediate revocation.

## Structured directory

```text
memory/
  schema.json
  scopes/<opaque-scope-key>/policy.json
  scopes/<opaque-scope-key>/records/<uuid>.json
  scopes/<opaque-scope-key>/index.json
  audit/<date>.jsonl
```

Store outside source repositories with owner-only filesystem permissions.
Use generated opaque directory keys, not platform names or raw user input.
Reject traversal, symlinks, unsafe roots and unexpected schema versions.
Record files are authoritative; indexes are disposable and rebuildable.
Atomic writes, revision checks and a single-writer lock prevent partial updates
and lost concurrent writes. An interrupted index rebuild must leave the last
valid index usable. Backups retain the same authorization and deletion rules.

Records include schemaVersion, id, revision, scopeId, kind, title, summary,
tags, entityRefs, provenance, createdAt, updatedAt, expiresAt, confidence,
evidenceType, supersedes and status. Kinds include fact, preference, person,
conversation, collaboration and impression. Provenance retains source IDs and
minimal supporting excerpts only when authorized, not entire transcripts.

People records distinguish confirmed names/aliases, observed work, explicit
preferences and subjective impressions. Label impressions as observations with
date and evidence, not objective personality claims; avoid inferred sensitive
traits. Conflicts retain competing source claims until corrected rather than
silently overwriting. Conversation purposes have evidence and last-confirmed
time; the inventory covers authorized observed groups, not every platform group.

## Proposed CLI

Memory commands belong under the existing `cordisx channel` subcommand as
`cordisx channel memory <operation>`, not a separate executable or top-level
memory command. Reuse Channel's profile, verified incoming context, operation
IDs, authorization and structured errors. Keep runtime memory data outside the
repository even though the CLI is part of Channel.

The following commands are proposed, not current supported commands:

```sh
cordisx channel memory remember --context <verified-context> --scope <id> --input-file <record.json>
cordisx channel memory search --context <verified-context> --scope <id> --query <text>
cordisx channel memory get --context <verified-context> --scope <id> --id <record-id>
cordisx channel memory update --context <verified-context> --id <record-id> --revision <n> --input-file <record.json>
cordisx channel memory forget --context <verified-context> --id <record-id> --revision <n>
cordisx channel memory index --scope <id>
cordisx channel memory entity get --context <verified-context> --id <entity-id>
cordisx channel memory identity bind --context <verified-context> --entity <entity-id>
cordisx channel memory identity confirm --context <verified-context> --challenge <id>
cordisx channel memory identity unbind --context <verified-context> --binding <id>
cordisx channel memory grant --context <verified-context> --input-file <grant.json>
cordisx channel memory revoke --context <verified-context> --grant <id>
```

Channel operations use the incoming verified context. Caller-supplied account,
actor or scope IDs cannot replace Host-derived identity. Index rebuild is an
operator operation or an explicitly authorized bounded task, not an automatic
all-scope capability exposed to a Channel caller. Scope policy and identity
administration need separate CLI operations with explicit authorization.

Initially accept explicit instructions such as "remember this in project P".
Offer a candidate when something seems worth remembering, but do not silently
save people profiles or whole conversations. Read-only recall uses authorized
scopes with small result/byte caps, then loads selected record files on demand.
Use keyword/tag/entity lookup first; optional embeddings later must not send
private content to external services without separate approval.

## Recall safety and lifecycle

Returned memories are untrusted historical data, not system instructions or
permission grants. Cite record provenance, time and uncertainty in summaries.
Do not execute instructions embedded in records, import credentials, or follow
external URLs automatically. Credentials and authentication tokens are not
memory content. Scope publication should preview the exact summary and audience.

Corrections, expiry and deletion update both records and index. Revoke grants
immediately at read time, including previously selected results and cached
snippets. Audit actor, operation and record IDs without retaining deleted
content. Define hard-delete and backup-retention behavior before production.
CLI and model prompts must not expose memory storage paths to other groups.

## Delivery stages and acceptance

1. Implement storage, schema, atomic revisions, keyword index and local CLI with
   synthetic tests; no automatic Channel ingestion.
2. Integrate verified Channel context and scope authorization with tests for
   denied writes, searches, existence leaks, identity collisions and revocation.
3. Exercise explicit save in A and authorized recall in B, with a denied C
   control. Verify correction, forget, expiry and index recovery.
4. Add adapter fixtures, privacy review and optional suggestions. Live platform
   checks and user acceptance remain separate from unit-test success.

The first implementation should not promise automatic knowledge of all groups,
automatic cross-platform identity resolution, unlimited transcript access,
speech understanding or cloud embeddings.

## Memory directory troubleshooting

A memory directory may live beneath a valid ancestor symlink. The Host resolves
and pins its canonical directory while still rejecting a symlink at the memory
directory itself, foreign ownership and group/world access. Retargeting an
already prepared ancestor does not redirect subsequent memory operations.

`MEMORY_UNSAFE_ROOT` remains a real validation failure for an unsafe leaf. A
dispatch failure retains that safe diagnostic instead of losing it behind a
generic uncertain-effect code. The task stays fenced for reconciliation; the
Host does not automatically replay a dispatch whose outcome is unconfirmed.
