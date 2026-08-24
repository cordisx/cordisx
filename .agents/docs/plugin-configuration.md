# Plugin configuration

## Delivered contract and order

The host implements the configuration-v1 contract merged in
`cordisx-protocol#19` (`d3b503e`). Delivery order is fixed:

1. protocol schemas, conformance, and security boundary;
2. launcher persistence and renderer runtime lifecycle;
3. Manager default Schemastery form;
4. lifecycle-owned custom field renderers; and
5. the exact merged `cordisx` gitlink in `cordisxmono`.

The Host change must retain the already merged Manager Settings Tabs, Agent
Trace/history, Channel documentation, structured toolbar, composer, and README
work. A feature branch from another task is not an integration base.

## Schema and developer interface

Plugin modules may export `Config`, any synchronous Standard Schema validator.
CordisX validates it before the first `apply(ctx, config)` and before every
write. A module may additionally export `configApplies` as `live` or `restart`;
the default is `restart`.

Schemastery is the preferred complete implementation. Its Standard Schema
validator supplies defaults and validation, while its schema nodes supply the
field structure, constraints, descriptions, localized text, roles, and other
form metadata. An arbitrary Standard Schema remains validation-only and gets a
bounded JSON editor rather than an inferred field form.

`ctx.settings.get()` and `ctx.settings.watch()` expose only the calling
plugin's current immutable snapshot. A live write commits under the launcher
revision fence and then publishes one snapshot without calling `apply` again.
A restart write stages the candidate, recreates only the owning plugin fiber,
and commits success only after the new fiber is active. Blocked plugins accept
a validated write without mounting and restore with the latest committed
value.

`ctx.configRenderers.register()` accepts exactly one selector: Schemastery
role, exact field path, or an owner-bounded namespace. The registration and
every active field mount are effects of the registering Cordis fiber. The Host
creates the field container and retains the label, help, validation error,
dirty state, save/reset controls, focus behavior, and accessibility tree.

## Persistence and failure behavior

The launcher owns `~/.cordisx/config.json`. Browser plugins receive neither the
path nor a file writer. Writes travel through a generation/profile-bound CDP
request and use the existing cross-process lock, strict revalidation, private
permissions, fsync, atomic rename, and directory sync.

Each profile/plugin section has a monotonic revision. Legacy `plugin.config`
is the revision-zero fallback; the first scoped write creates the profile
section without rewriting unrelated configuration. Every candidate records
its expected revision and generation. A mismatch returns conflict and performs
no validation, runtime change, retry, or overwrite.

The committed `config` and revision are always the durable last-good pair. A
candidate is staged separately. Live mode commits it before notification.
Restart mode mounts it first, commits only after the candidate fiber is active,
and otherwise removes the candidate and remounts last-good. A failed last-good
remount leaves the plugin failed and reports rollback failure. A renderer
generation disposal cancels queued work and rejects late bridge results.

An abrupt launcher/process crash can leave a staged candidate record after its
owner token is gone. The active `config` and revision still remain last-good and
are what the next launcher loads, but the abandoned candidate deliberately
blocks another write instead of being guessed stale or overwritten. Automatic
lease expiry/recovery is not implemented in v1; recovery currently requires a
launcher-owned repair flow or removal of that candidate record while CordisX is
stopped. This is a fail-closed availability boundary, not silent rollback.

## Secret and trust boundary

`secret`, `credential`, `credential-ref`, `permission`, and `capability` roles
are Host-reserved. Ordinary descriptors, JSON mutation operations, diagnostics,
and custom renderers never contain those values. Until a launcher credential
broker is implemented, these fields are visible only as Host-owned unavailable
slots and are not writable; CordisX does not pretend config-file JSON is a
credential store.

CordisX plugins remain trusted local code, matching the existing product
boundary. Lifecycle attribution and a private launcher writer prevent an
accidental or normal public-API write, but they are not a sandbox against a
malicious bundled module. Unlike DSH's trusted loader/config plane, CordisX
does not give an ordinary plugin a host configuration writer.

## Validation matrix

Required automated coverage includes legacy-to-profile migration, concurrent
CAS conflict, atomic persistence failure, candidate abort, live publication,
restart success, restart failure plus last-good recovery, rollback failure,
secret redaction/refusal, blocked restore, renderer precedence, renderer throw
fallback, and registration/mount cleanup on block, restart, generation replace,
and dispose. The release gate also requires the full check/build/audit/diff
suite and an isolated real `app://` smoke that edits one live and one restart
field and observes only the owning fiber lifecycle.
