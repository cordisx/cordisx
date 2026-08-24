# Plugin configuration

## Delivered contract and order

The host implements the configuration-v1 contract merged in
`cordisx-protocol#19` (`d3b503e`) and the explicit configuration-plane v2
contract merged in `cordisx-protocol#34` (`20053fb`). Delivery order is fixed:

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
write. A module may additionally export `configApplies` as `live`,
`plugin-restart`, `service-restart`, or `app-restart`; the default is
`plugin-restart`. The closed v1 spelling `restart` is accepted only as a
compatibility input and normalizes to `plugin-restart` before any Manager or
runtime projection.

## Configuration planes

Launcher/startup configuration is frozen for one application process. The
Codex executable, debug port, selected profile, launch environment, and other
process-start inputs remain owned by CLI parsing and launcher validation. They
are not a Manager global-settings document and cannot be mutated in the
current process. Removing the top-level Settings page removes no parser,
startup snapshot, or redacted diagnostic. A future editor may only persist an
explicit app-restart candidate.

Runtime configuration appears in the owning plugin detail beside that
plugin's permissions. Provider configuration belongs to the CLIProxy plugin;
there is no global Providers category. Marketplace source management belongs
to the Plugin Store workflow rather than a general settings form.

Schemastery is the preferred complete implementation. Its Standard Schema
validator supplies defaults and validation, while its schema nodes supply the
field structure, constraints, descriptions, localized text, roles, and other
form metadata. An arbitrary Standard Schema remains validation-only; the Host
does not infer an editable field form or expose raw JSON in the default Manager
panel.

The default form reads an optional product label from Schemastery
`meta.extra.label` (a string or locale dictionary). When it is absent, the Host
derives one readable label from the final field-path segment. The raw path stays
available for mutation identity and diagnostics but is not repeated in the
normal form.

The concrete Host primitive selection, draft/validation state, responsive
layout, theme containment, official TDesign package audit, and Manager form
integration are defined in [`host-form-system.md`](host-form-system.md). This
does not change the configuration-v1 protocol or let plugins select a UI
library component directly.

`ctx.settings.get()` and `ctx.settings.watch()` expose only the calling
plugin's current immutable snapshot. A `live` write commits under the launcher
revision fence and publishes one snapshot without calling `apply` again. A
`plugin-restart` write stages the candidate, recreates only the owning plugin
fiber, and commits success only after the new fiber is active. An
`app-restart` write persists the candidate but leaves the current fiber and
watchers unchanged; Manager reports the new revision separately from the
current-process `lastGoodRevision`. `service-restart` is writable only when an
owning launcher service handler is registered; the renderer-only runtime
reports it read-only instead of substituting a plugin restart. Blocked plugins
accept a validated live/plugin candidate without mounting and restore with the
latest committed value.

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

The committed `config` and revision are the durable next-start pair. A
candidate is staged separately. Live mode commits it before notification.
Plugin-restart mode mounts it first, commits only after the candidate fiber is
active, and otherwise removes the candidate and remounts last-good.
App-restart mode commits persistence while retaining the current process value
and active revision until a complete restart. A failed last-good remount leaves
the plugin failed and reports rollback failure. A renderer generation disposal
cancels queued work and rejects late bridge results.

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

Required automated coverage includes legacy `restart` normalization,
legacy-to-profile migration, concurrent CAS conflict, atomic persistence
failure, candidate abort, live publication, plugin-restart success/failure and
last-good recovery, app-restart staging without current-fiber publication,
unbound service-restart refusal, rollback failure, secret redaction/refusal,
blocked restore, renderer precedence, renderer throw fallback, and
registration/mount cleanup on block, restart, generation replace, and dispose.
The release gate also requires the full check/build/audit/diff suite and an
isolated real `app://` smoke that verifies live, plugin-restart, and staged
app-restart labels without creating a global configuration category.
