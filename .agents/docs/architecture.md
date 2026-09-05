# CordisX architecture

Type: current implementation overview. This page owns the runtime planes,
responsibility boundaries, and navigation to detailed Host references. Public
plugin formats and compatibility contracts are owned by `cordisx-protocol`.
Implementation, test evidence, formal merge, release, and user acceptance are
separate facts; this overview is not a release or acceptance ledger.

## Goal

CordisX is an unofficial, opt-in local extension Host for Codex Desktop. It
uses a separately launched loopback CDP endpoint and reversible Cordis
lifecycles without modifying the installed application or replacing native
React ownership. Plugins receive no raw authentication or private Host transport.
Host-owned adapters
translate structured plugin intent into UI and brokered operations.

## Product boundary

OpenAI's [supported plugin UI](https://developers.openai.com/plugins/build/chatgpt-ui)
serves portable, conversation-owned plugin UI. CordisX provides
local shell extension where that mechanism does not expose the required
surface. CordisX must never label injected shell integration as an official
Codex plugin API.

Plugins use documented versioned services, schemas, commands, contribution
descriptors, and controlled body seats. The Host owns native DOM probes,
routing chrome, process and transport composition, permissions, and lifecycle.
An independent Provider Fleet is a separate connection plane; it must not
impersonate or replace Desktop's current connection.

## Runtime

```text
explicit-entry bundle / dynamic package generations / Vite development graph
                                  |
                         launcher + CDP bootstrap
                                  |
                       Host renderer + Cordis fibers
                         /                    \
             structured UI registries     brokered Host services
                      |                         |
             Host-owned adapter/UI       launcher/private transports
```

| Plane | Owner and boundary | Detailed reference |
| --- | --- | --- |
| Launcher | Process, configuration, package and service composition, CDP, cleanup | [Launcher runtime](launcher-runtime.md) |
| Renderer | One shared runtime, plugin fibers, validated snapshots, conversation commands | [Renderer runtime](renderer-runtime.md#renderer-plane) |
| UI adapter | Semantic surfaces, route/outlet reconciliation, native history | [Slot plane](renderer-runtime.md#slot-plane) |
| Manager and forms | Host chrome, controls, state projection, configuration UI | [Manager](renderer-runtime.md#built-in-manager-plane), [forms](host-form-system.md) |
| Authority | Brokered capabilities, principal-bound grants, private transport | [Platform capabilities](platform-capabilities.md), [Publisher Grants](publisher-grants.md) |
| Icon themes | Provider handles, semantic seats, profile preference synchronization | [Host icon themes](host-icon-theme.md) |

The headings below preserve existing architecture links. Detailed constraints
have moved to their linked reference once; update those topics rather than
adding a second detailed account here.

### Launcher plane

The launcher owns startup, exact configuration/profile selection, source and
package composition, and cleanup. Explicit-entry bundles, installed package
generations, and the Vite development graph are distinct composition paths.
Configuration publication, fiber restart, dependency-closure replacement,
renderer generation replacement, and App restart remain distinct operations.

- [Launcher integration details](launcher-runtime.md#launcher-plane)
- [CLI and distribution](distribution-and-cli.md), [Vite development](vite-native-development.md)
- [Dynamic lifecycle](dynamic-plugin-lifecycle.md), [package store](dynamic-package-store.md), [bundles](plugin-bundles.md)
- [Provider sessions](multi-provider-sessions.md), [Agent events](agent-events.md), [AgentLoop](agent-loop.md), [history](agent-history.md), [Channel runtime](channel-runtime.md)

### Renderer plane

One Host runtime owns plugin fibers and the shared React singleton. Reload and
replacement retire registrations and pending operations through that lifecycle.
Product pages may own their complete internal renderer inside a controlled page
body, while the Host retains routing, outlet, lifecycle, and authority fences.
Commands and route activation retain exact owner, Session, binding, and
generation coordinates; product visuals cross into Host-owned rows only as
validated generic snapshots.

See [renderer and conversation composition](renderer-runtime.md#renderer-plane),
[the public React authoring boundary](plugin-react-runtime.md), and
[bounded plugin visuals](plugin-visuals.md).

### Slot plane

Plugins contribute structured records or controlled page bodies. The Host
owns rendering, semantic adapter seats, navigation, focus, layout, and cleanup.
Missing or ambiguous native seats remain unavailable; route reconciliation does
not authorize a second history stack or plugin-owned native DOM fallback.

See [adapter and route integration](renderer-runtime.md#slot-plane),
[structured contributions and routing](data-contribution-routing.md),
[the adapter catalog](ui-extension-catalog-codex-adapter.md), and
[extension-point management](extension-point-management.md).

### Host-owned form plane

Schema and bounded presentation metadata flow into one Host-owned form system.
Plugins do not receive a form root, selectors, CSS, portals, or a UI library
instance. Configuration, validation, and apply scopes remain explicit.

See [form composition](renderer-runtime.md#host-owned-form-plane),
[Host forms](host-form-system.md), [Schemastery UI](schemastery-ui.md),
[plugin configuration](plugin-configuration.md), and
[service configuration](service-configuration.md).

### Built-in manager plane

Manager is Host chrome. It projects runtime state and brokered operations;
plugins supply eligible navigation records, structured collections, and body
content within declared seats. Manager is not a second activation, permission,
execution, or persistence authority.

See [Manager integration and trust composition](renderer-runtime.md#built-in-manager-plane),
[Manager design](manager-content-design.md), [Host collections](host-collections.md),
[Settings compatibility](manager-settings-tabs.md), and
[contributed navigation](manager-settings-navigation.md).

### PublisherGrant authorization seam

Publisher Grants use a launcher-only identity and persistence boundary. The
renderer receives bounded status and import operations, never private keys or
payment data. A publisher grant does not establish general execution safety.

See [Publisher Grants](publisher-grants.md#launcher-integration) and
[Platform transport composition](platform-capabilities.md#renderer-transport-composition).

### Host icon-theme authority

The Host owns semantic icon seats and renderer synchronization. Public theme
providers supply bounded descriptors; exact identity, generation, revision, and
correlation fence selection and late results. Failure falls back to Host-owned
Reicon rather than exposing provider internals.

See [icon-theme authority](host-icon-theme.md) and the
[Manager token map](icon-theme-manager-token-map.md).

## Trust and security

Version 0.1 legacy structured plugins and explicit local-development entries
use a trusted-code renderer model. Cordis provides lifecycle and dependency
composition; it is not a general security sandbox. Manifest-v5 Host DOM
artifacts are the exception: they are not evaluated in the renderer main realm
and receive only the isolated, bounded Host DOM worker RPC described in [renderer trust composition](renderer-runtime.md#marketplace-trust-and-host-dom-isolation).

Public marketplace execution outside that narrow Host DOM surface still needs
a general isolated plugin realm, publisher signatures/source identity, CSP and
network policy, and capability RPC for every exposed Host service. The current
Permission Broker controls cooperative Host services and does not sandbox
legacy trusted renderer code. Local package content hashing must not be
described as publisher verification; Official and Certified source assertions
remain independent of execution provenance and never create general authority.

See [Platform capabilities](platform-capabilities.md) and
[Marketplace trust](marketplace-trust-and-ranking.md) for their respective
authority boundaries.

## Compatibility strategy

Compatibility is owned by adapter probes rather than a single brittle selector. A resolver tries narrow stable attributes first, then structural fallbacks. If no candidate is found, the slot remains pending and does not modify the page. Plugin mount failures are contained to that contribution and shown in its outlet while other plugins continue.

Adapter releases should record the Codex versions they were tested against. Unknown versions may run in best-effort mode, but the launcher and Manager must present that state distinctly from verified compatibility.

The built-in manager trigger follows the same rule: its workspace-switcher
probe stays in the host adapter, remains pending when no unique visible target
exists, and must not make plugins depend on Codex-owned class names.

Use the [adapter catalog and matrix](ui-extension-catalog-codex-adapter.md),
[Playground evidence limits](ui-playground.md), and
[delivery rules](https://github.com/cordisx/cordisx/blob/main/.agents/rules/functional-delivery.md)
when choosing validation. Historical installed-App observations do not certify
a current release.

## Decisions deferred

Historical feasibility observations and the original open-question list are
preserved in the [historical development plan](development-plan.md#historical-feasibility-evidence-and-open-questions).
Current unresolved capability or delivery work belongs in its owning topic and
current task ledger, with explicit evidence and scope; this overview does not
carry a second roadmap.
