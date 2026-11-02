# Progressive startup

Type: Host implementation reference. This page explains launcher composition,
service preparation, and the user-visible readiness states. Public declarations
and runtime callbacks are owned by the versioned
[Startup](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/startup/README.md)
and
[Startup runtime types](https://github.com/cordisx/cordisx-protocol/blob/main/types/startup-runtime.v1.d.ts)
and
[instance configuration](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/startup/instance-configuration-v1.md)
contracts. Source behavior here does not establish publication, native Send
verification, or user acceptance.

## Workspace and capability readiness

A workspace can become ready while an admitted provider is still preparing.
The launcher first adopts the core and legacy service composition, installs the
renderer, and publishes workspace readiness. Progressive managed services
continue their preparation in the owning lifecycle. A slow or unavailable
provider does not become available merely because the Host window is ready.

The Host owns one startup authority for the admitted capabilities. It combines
service health, authentication, catalog, provider publication, and declared
milestones. A provider is executable only after all required evidence is ready.
An empty catalog is unavailable. Authentication-required, failed, stopped,
revoked, and stale-generation states retain their explicit unavailable reason.

The model selector and Model Services page observe this authority through the
Host bridge. Pending providers can be shown before their model catalog is ready;
their actions remain governed by the current availability projection. A broken
observation connection is shown separately from the provider's last-known state.
The Host retains the existing selector, Manager header, tabs, and navigation.
Declared pages observe their scoped entries; page actions additionally require
the declared capability dependencies to be available. Authentication actions
use the owning service login flow instead of promoting the provider to ready.
The observation stream itself supplies no credential or login authority.

## Caller requirements

A declaration selects `background`, `when-selected`, or `always` independently
for interactive and command launches. The Host authority resolves those policies
for the requested mode; the current command path uses command requirements.
Preparation begins for all enabled admitted capabilities regardless of wait
policy. `when-selected` controls a wait requirement, not lazy service startup.
Ordinary workspace readiness and a
caller's selected capability are separate requirements. An explicit provider or
model request waits for that target plus the applicable always-required targets.
The waits share one finite caller budget and fail promptly on a terminal reason.

Cancelling or timing out one caller cancels only its waiters. It does not stop
shared provider preparation, acquire credentials, retry a service, or shut down
the Host. The normal service and launcher lifecycles remain responsible for
those operations. Dependencies require an admitted package dependency and the
corresponding service grant; unknown targets and dependency cycles are rejected.

## Managed preparation and configuration

Manifest-v15 startup services use the admitted Node module's preparation
callback. The Host reserves endpoints and adopts services before preparation,
then provides a generation-bound reporter. Late reports from replaced or
revoked attempts cannot update the current authority. Authentication, catalog
publication, and retry remain distinct operations instead of being folded into
window readiness.

Preparation receives a snapshot of the selected instance configuration through
the versioned startup-runtime contract. For a non-empty configuration, the
admitted Node module's Config must validate its declared structure and defaults.
The Host excludes reserved secret fields and rejects unknown keys, unsupported
schema projections, asynchronous validators, and validators that reintroduce
secret values. The accepted projection is a closed raw object with a `dict` of
inline primitive, array, or object nodes. Renderer schema envelopes, uid/refs,
and arbitrary Schemastery extensions are not accepted Node configuration.
The normal configuration writer persists an edit for its documented apply
scope; it does not hot-rotate the running preparation or service credentials. Configuration failure uses a bounded diagnostic rather than
publishing validator output. Credentials retain their existing Host-private
service path.

Replacement and disposal abort the affected preparation attempt and fence its
reports. A callback that ignores cancellation cannot keep the Host's waiter
alive indefinitely; the owning component still performs service cleanup. No
other service, App instance, profile, or process is a cleanup target.

## Native adapter preparation

Native resource discovery starts in a launcher-owned Worker and can overlap
Host startup. The launcher still waits for the adapter result before installing
its native interception composition. Cancellation drains the Worker and releases
only its preparation lease.

The adapter materialization session reuses a transformed result only when the
module declares `fixed-original-v1` and the observed resource's SHA-256 matches
its discovery input. Arbitrary legacy transform functions retain their normal
execution semantics. The persistent cache binds the selected adapter identity,
analyzer version, client diagnostics, and original resource hashes, and verifies
cached transformed bytes before reuse. Native resources remain local and are
never included in release evidence or uploaded artifacts.

The bundled baseline ships with the Host. Independently downloaded adapters
retain their own version, trust, native validation, and release gates; see
[Codex adapters](codex-adapters.md). Preparing an adapter or rendering a model
catalog does not prove a native first-turn or existing-thread Send.
