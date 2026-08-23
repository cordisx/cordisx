# Multi-provider Platform sessions

Status: approved delivery architecture for provider-aware Platform routing and
the first CLIProxyAPI connection plugin. Normative plugin-visible changes land
in `cordisx-protocol` before the compatible host implementation.

## Outcome and non-goals

CordisX will let one injected app manage sessions owned by multiple explicitly
configured provider connections. Model selection, session creation, catalog
queries, search, read, resume, control, persistence, and audit all route through
the same provider-aware identity. A model picker change by itself is not a
conforming implementation.

This work does not replace or impersonate the Codex Desktop current
connection. It does not overwrite native sidebar rows, switch a native Codex
session, expose `electronBridge`, expose an app-server transport, or label a
separately managed provider session as native. The existing `app`, `main`, and
`session.content` outlets remain unchanged; the CLIProxyAPI plugin uses the
existing page and route APIs.

CLIProxyAPI is a model gateway rather than a durable Codex conversation store.
The first connection therefore composes two independent parts:

1. CLIProxyAPI supplies a Responses-compatible model endpoint and model
   catalog.
2. A launcher-owned Codex app-server connection supplies agent-session
   persistence, history, search, resume, turns, approvals, and lifecycle for
   that provider only.

Every provider app-server has a private provider-specific `CODEX_HOME` below
the selected CordisX profile. It cannot read or mutate the native app's
conversation store. The process is an explicitly independent provider
connection, not a substitute for the Desktop current-connection adapter.

## Two connection planes

```text
native Codex Desktop current connection
        |
        +-- one current-connection adapter
            (honest unavailable/read-only/read-write status)

CordisX launcher Provider Fleet
        |
        +-- providerId: cliproxy-main
        |      +-- isolated Codex app-server
        |      +-- CLIProxyAPI Responses endpoint
        |
        +-- providerId: another-provider
               +-- independent adapter and persistence root
```

The Agent event runtime remains provider-neutral and owns only the current
connection ledger described by `cordisx.agent-events/v1`. Provider Fleet task
lifecycle is not relabeled as observed Agent events. A future bridge may retain
an explicit host-owned mapping from one Platform session reference to one
Agent session id, but neither side derives the other and plugins cannot supply
or override that mapping.

## Canonical identities

Provider ids are stable user-configuration ids, globally unique within one
CordisX profile, and validated before any process starts. Adapter-local ids are
never globally routable.

```ts
interface PlatformProviderRef {
  providerId: string
}

interface PlatformModelRef extends PlatformProviderRef {
  modelId: string
}

interface PlatformSessionRef extends PlatformProviderRef {
  remoteSessionId: string
}
```

The primary session key is exactly `(providerId, remoteSessionId)`. A canonical
serialization may be used as an internal map or cursor key, but public calls
carry the structured pair. Model identity is `(providerId, modelId)`.

Provider adapters receive only their local `remoteSessionId`. The fleet router
resolves `providerId`, verifies that the returned provider identity still
matches the requested adapter generation, and strips no identity on the way
back. Unknown, disabled, draining, or replaced providers fail closed. A new
adapter generation cannot silently take ownership of an already-running
operation.

Session summaries persist the complete reference. Search results, pagination
cursors, selected rows, route parameters, manager diagnostics, permission
requested scope, and audit entries retain that reference. Bare session ids are
allowed only inside one resolved adapter call.

## Platform API and routing

The existing `ctx.platform` service remains the permission-brokered public
surface. Its adapter becomes a fleet router with these rules:

- model listing returns provider-aware model references and may filter by one
  or more provider ids;
- session listing and search fan out only to authorized providers, then merge
  deterministic pages without discarding provider identity;
- read, resume, fork, archive, restore, delete, turn submission, steering, and
  interruption require a complete session reference;
- creation requires a complete model reference and returns a complete session
  reference before any initial turn is submitted;
- an initial-turn failure retains and returns the created provider-aware
  session;
- adapter status reports each configured provider independently and never
  upgrades unavailable current-connection facts because an external provider
  is healthy.

Permission scope adds structured session references while retaining provider
and cwd bounds. Permission audit records the last requested provider/session
reference, outcome, source-bound plugin identity, and adapter generation. The
renderer remains trusted local code, so this is cooperative API enforcement,
not process isolation.

## Launcher-private provider RPC

The launcher owns provider processes, environment-variable credential lookup,
timeouts, retry/cancellation, generation drain, and deterministic cleanup. A
narrow CDP `Runtime.addBinding` request/response channel carries only validated
Platform operations and sanitized results. It follows the existing marketplace
binding pattern but has separate names, payload limits, request limits, and
abort ownership.

API keys, management API credentials, app-server JSON-RPC messages, child
process handles, provider configuration files, and raw streams never enter the
renderer. The renderer adapter receives only provider/model/session metadata,
normalized content, bounded diagnostics, and operation results. Direct binding
use is not a public plugin contract.

## CLIProxyAPI connection plugin

The first delivery packages a normal CordisX renderer plugin plus a
launcher-owned provider connection:

- the local composition declares a `cli-proxy-api` provider connection with a
  stable `providerId`, display name, base URL, and API-key environment-variable
  name;
- the launcher accepts HTTPS endpoints and loopback HTTP endpoints only;
- the provider speaks the Responses wire API; Chat Completions-only endpoints
  are rejected;
- the renderer plugin declares ordinary model/task/turn capabilities, appears
  with its canonical source in manager permission and runtime views, and uses
  `ctx.platform` rather than the private binding;
- the plugin contributes one existing sidebar navigation item, route, and
  `main` page for provider filter, model choice, session creation, merged
  session list, search, and session detail;
- disabling the plugin removes its UI and grants; disabling the connection
  drains and terminates the provider adapter without deleting its isolated
  persisted sessions.

The connection is not the CLIProxyAPI management API. Account login, account
pool mutation, quota administration, usage accounting, and starting or
upgrading the CLIProxyAPI binary are separate future capabilities.

## Dependency and PR boundaries

1. Architecture checkpoint in `cordisx`: this document plus architecture and
   development-plan links. It has no runtime behavior.
2. Protocol PR in `cordisx-protocol`: provider/model/session identity, list and
   search inputs, permission scope/audit rules, compatibility text, schemas,
   vectors, and conformance. It is based on Agent event protocol commit
   `e615572` and does not change Agent event identity or experimental adapter
   fields.
3. Host core PR in `cordisx`: provider-aware Platform types, Permission Broker
   scope/audit, fleet router, launcher-private RPC, Codex app-server client,
   CLIProxyAPI adapter, configuration, lifecycle, tests, and diagnostics.
4. Plugin/UI PR in `cordisx`: the CLIProxyAPI page built only on the public
   Platform, page, route, command, i18n, and existing outlet services. It does
   not modify the separate UI extension catalog document or add a surface.
5. CordisXMono PR: from the then-current `origin/main`, pin only compatible
   merged protocol and host commits while retaining all concurrent pointers.

The host core and UI may share one repository branch during implementation,
but review evidence and commits keep their validation boundaries distinct.

## Validation boundary

Protocol validation covers strict structured identities, duplicate provider
ids, cross-provider remote-id collisions, provider-aware scope fingerprints,
session list/search pages, cursor/provider mismatch, and rejection of naked
session ids.

Host automated coverage includes:

- provider registration conflict, generation replace/drain, health, timeout,
  cancellation, and cleanup;
- two providers returning the same remote session and model ids without
  collision;
- model list, create, initial-turn partial failure, list, search, read, resume,
  fork, archive/restore/delete, submit, steer, and interrupt routing;
- persistence across adapter restart with provider-specific data roots;
- source identity, provider/session permission scope, last-target audit, deny,
  unsupported capability, and plugin disable/re-enable;
- app-server handshake, request correlation, notifications, malformed frames,
  process exit, and secret-free diagnostics;
- CDP binding payload/concurrency/timeout limits and proof that no raw bridge,
  child handle, credential, or app-server message reaches the renderer;
- CLIProxyAPI model endpoint compatibility with a deterministic mock Responses
  server;
- page provider filter, composite selected-session state, search, model choice,
  creation, detail, error, empty, loading, keyboard, focus, and cleanup states.

Repository gates are focused tests followed by `npm run check`,
`npm audit --audit-level=high`, and `git diff --check` in every owning
repository. Real smoke uses an isolated Codex Desktop renderer, a provider-
specific temporary `CODEX_HOME`, the installed `codex app-server`, and a local
mock CLIProxyAPI Responses endpoint. It must show two providers with colliding
remote ids routed correctly, capture the real provider/session page, and prove
that native Codex session selection was never changed.
