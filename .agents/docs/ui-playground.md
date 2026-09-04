# Local UI Playground

`npm run dev:ui` starts a loopback-only Vite development page for CordisX and
plugin developers. The page uses React Fast Refresh and native ESM HMR for the
Host shell and React component tree. It runs an independent Cordis renderer
generation and composes the configured plugin modules with the same runtime,
Manager, HostForm, theme projection, icon, dialog, and lifecycle source used by
the production renderer. It does not start Codex Desktop, Chromium, or a
ChatGPT browser profile. By default it starts no app-server and needs no
authenticated session. A composition may explicitly set
`codex.agentLoopBackend` to `local-cli`; that opt-in starts an independent,
launcher-owned app-server using the existing Codex CLI login solely behind the
normal provider/AgentLoop bridge.

For deterministic consumer development, a composition may instead set
`codex.agentLoopBackend` to `mock`. This is accepted only when the renderer is
built as the explicit UI Playground. The visible `Mock / Simulator` task list
and exact task detail page are Host-owned debug surfaces, separate from Recent
tasks and plugin content. They show redacted structured execution evidence and
never expose opaque bindings, provider handles, paths, credentials, or tokens.
Reset creates a new in-memory Simulator generation with deterministic counters.
Production bundle construction rejects this backend.

Vite is a development transport, not a second renderer implementation. Normal
immutable production startup still uses `buildRendererBundle` and an injected,
self-contained IIFE. Explicit `cordisx dev` is the native development path: its
`app://` renderer loads the Host and plugin ESM graph from a launcher-owned Vite
server and receives updates through Vite HMR. See
[`vite-native-development.md`](vite-native-development.md). The browser
Playground remains useful supporting evidence, but does not replace native
verification.

```sh
npm run dev:ui
npm run dev:ui -- --config /absolute/path/to/cordisx.config.json --port 43124
```

The default fixture is `cordisx.config.playground.json` (`Comprehensive UI
demos`). It activates seven local, credential-free renderer plugins:
`slot-showcase`, `hello-toolbar`, `form-schema-gallery`, `settings-tab-demo`,
`console-showcase`, built-in `channel`, and built-in `cli-proxy-api`. This
covers structured slots/pages/routes, schema-driven configuration, Manager
content navigation, Console entries, and the Channel/Provider projections. The
last two remain honestly unavailable when no launcher-side connection or
configured provider exists; the fixture never invents one.

`console-showcase` intentionally performs one optional `models.read` probe, so
the first runtime may show the normal Host-owned permission confirmation. It is
local to the temporary Playground profile: allowing or denying it neither
creates a Codex connection nor contacts a provider. Denying it leaves the
Console and all unavailable diagnostics available for inspection.

The default page is a compact Agent Desktop fixture rather than a catalog of
empty rectangles. Its persistent shell contains a Host-owned sidebar and
session list, workspace and session headers, a conversation timeline, and a
composer. `有会话` and `空会话` switch between mounted and absent session
contexts so developers can verify both contribution states. The floating
developer tools panel reports the fixture name, active plugin count, every
current plugin status, theme/locale controls, runtime reload, and reset without
occupying the product canvas.

To select another real composition, start with `--config`; the minimal
`cordisx.config.example.json` remains a documentation example and is not the
Playground default. A provided composition file is read once, then
materialized below a fresh temporary `CORDISX_HOME`.
Its plugin entries become absolute paths, while writable configuration,
candidate state, cache, and reset data stay in that temporary root. Closing the
process closes the loopback server and removes the root. The source composition
is never written. `重置 fixture` restores the materialized composition and
clears its temporary state.

Fixture metadata may contain `playground.permissionPolicies`. The Playground
strictly normalizes those records and uses them only in its temporary in-memory
permission store. This is the narrow preview mechanism for an explicitly
authorized internal composition; absent records remain denied/unavailable.

### Declarative Agent/Session scenarios

An explicit fixture may also provide a Host-only `playground.sessionScenarios`
catalog. The catalog is accepted only by the UI Playground launcher, is parsed
with exact fields and bounded codes, and is never injected into a plugin
Context or enabled for the production renderer. The message text must equal a
configured code and the receiving Session must use the scenario's exact
`entryAgentId`; otherwise the deterministic transport handles it as an ordinary
message.

A useful first fixture catalog can reserve `0` for a non-streamed plain-text
baseline, `1` for a streamed reply, `2` for tool call/result, `3` for an
approval branch, `4` for Room delegation, and `01234` for a composed regression
flow. These values are fixture-owned catalog keys, not Runtime commands.

```json
{
  "playground": {
    "sessionScenarios": {
      "version": 1,
      "revision": "local-smoke-1",
      "enabled": true,
      "scenarios": {
        "01234": {
          "entryAgentId": "chatroom.generalist",
          "label": "Full local smoke",
          "steps": [
            { "type": "assistant-reply", "text": "Starting the declared flow." },
            {
              "type": "room-delegation",
              "as": "reviewer",
              "memberId": "reviewer-member",
              "targetAgentId": "chatroom.reviewer",
              "task": "Review the declared flow."
            },
            { "type": "activate-session-scope", "actor": "reviewer" },
            { "type": "tool-call", "actor": "reviewer", "call": "inspect", "name": "workspace.inspect", "arguments": { "scope": "current" } },
            { "type": "tool-result", "actor": "reviewer", "call": "inspect", "content": "Inspection complete." },
            { "type": "assistant-reply", "actor": "reviewer", "text": "Review complete." },
            { "type": "final-summary", "text": "The declared flow completed." }
          ]
        }
      }
    }
  }
}
```

Steps support `assistant-reply`, `final-summary`, `tool-call`, `tool-result`,
`approval-request` with outcome branches, `room-delegation`, `followup`,
`activate-session-scope`, `failure`, and `cancel`. A delegation binds its `as`
actor only after the existing Room bridge admits a Session whose exact Agent
identity and task text match the declaration. `activate-session-scope` requires
that bound actor and derives its exact Session, plugin owner, and route from
Host authorities; it accepts none of those values from the fixture. The Host
captures the originating Shell Room binding, active run, source Session, and
source MessageId while the composer command is accepted, then commits that
capability only when the same Agent submission is accepted. Asynchronous
scenario steps therefore never recover authority from a transient foreground
route lookup. It keeps the visible Lead route intact while the delegated exact
route is active, waits for normal `approvals.request` authorization, and closes
on the first run, Room unmount/navigation, generation, permission, connection,
reset, or disposal fence. Scenario
progress is an ignorable Host SessionEvent in
the same durable Session ledger; tool, approval, assistant, and terminal facts
use their existing SessionEvent variants. The run identity derives from source
message id, catalog revision, and code. Completed or failed runs do not execute
again after reload; a generation interrupted mid-step is closed as a readable
failure and can be retried by sending the code as a new message.

## What it proves

- configured local plugin modules bundle, load, activate, dispose, and rebuild
  as a new renderer generation through the normal CordisX runtime;
- Host React components update through Vite Fast Refresh without maintaining a
  copied Playground-only Manager implementation;
- Manager pages, plugin details, configuration forms, Host dialogs, theme
  tokens, icons, locale attributes, and explicit `app`/`main`/`session.content`
  page seats render in a normal browser;
- existing structured contributions render through the production Host
  renderer in explicit Playground seats for `sidebar.navigation.items`,
  `sidebar.footer.before-control`, `sidebar.footer.after-control`,
  `workspace.toolbar.items`, `session.header.actions`, and
  `composer.toolbar.items`; and
- configuration writes use the existing revision-fenced Config bridge, but
  target only the temporary materialized composition.

The Playground adapter is intentionally separate from the Codex adapter. It
uses only explicit `data-cordisx-playground-*` Host seats and never probes or
inserts Codex selectors, DOM, native anchors, a current connection, or a raw
bridge. The shell consumes the existing formal page/route/surface catalog; its
development seats are not new public protocol. Missing shell seats remain
inspectable/pending in Manager and are not silently replaced with a
Codex-shaped fallback.

## What it cannot prove

The page deliberately reports the Desktop current connection, native Codex
session, native anchor resolution, and any native Host bridge as unavailable.
An opted-in local Provider Fleet task does not upgrade those facts. It cannot prove
the actual Codex theme extraction path, native-anchor placement, CDP injection,
or Host session data flow. Those require the existing isolated real `app://`
smoke after the owning change is merged.
