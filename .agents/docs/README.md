# CordisX documentation

This is the public, aggregatable source for Host product explanations, guides,
and implementation references. Choose an entry by the task below. A reference
may describe compatibility, experimental, or unavailable paths; its stated
scope and evidence do not imply that every path is released or user-accepted.
Historical plans and delivery records are grouped separately and retain their
original evidence states.

Normative plugin contracts belong in `cordisx/cordisx-protocol`; private or
provisional planning belongs in `cordisx/roadmap`. Host references describe the
implementation of those contracts, not a second public specification.

## Use CordisX

| Document                                            | Type     | Use it for                                                            |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| [product-overview](product-overview.md)             | Overview | Product scope, background, ecosystem, and licensing                   |
| [product-overview.zh-CN](product-overview.zh-CN.md) | Overview | Simplified Chinese product overview                                   |
| [getting-started](getting-started.md)               | Guide    | Installation, local setup, launch modes, examples, and smoke commands |
| [startup-qa](startup-qa.md)                         | Guide    | Startup troubleshooting                                               |
| [startup-qa.zh-CN](startup-qa.zh-CN.md)             | Guide    | Simplified Chinese startup troubleshooting                            |

## Develop and inspect plugins

| Document                                              | Type                   | Use it for                                                                                            |
| ----------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| [vite-native-development](vite-native-development.md) | Guide / reference      | Vite graph, update boundaries, and native development evidence                                        |
| [ui-playground](ui-playground.md)                     | Guide                  | Local UI and scenarios, configuration, and evidence limits                                            |
| [plugin-react-runtime](plugin-react-runtime.md)       | Reference              | Shared React authoring, controlled body seats, and lifecycle                                          |
| [plugin-visuals](plugin-visuals.md)                   | Reference (unreleased) | Owner-scoped decorative renderers, opaque data, theme, generation visibility, and failure containment |
| [plugin-configuration](plugin-configuration.md)       | Reference              | Schema forms, persistence, apply scopes, secrets, and recovery                                        |
| [service-configuration](service-configuration.md)     | Reference              | Launcher service schemas, credentials, and restart planes                                             |
| [plugin-devtools-console](plugin-devtools-console.md) | Reference              | Plugin-scoped Console attribution, coverage, privacy, and lifetime                                    |
| [agent-trace-showcase](agent-trace-showcase.md)       | Reference              | Development-only Trace plugin, Timeline, fixtures, and validation scope                               |

## Understand runtime composition and delivery

| Document                                                        | Type      | Use it for                                                                        |
| --------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------- |
| [architecture](architecture.md)                                 | Overview  | Runtime planes, ownership, trust, and detailed-reference navigation               |
| [launcher-runtime](launcher-runtime.md)                         | Reference | Node/CDP composition, exact authority, durable state, and services                |
| [renderer-runtime](renderer-runtime.md)                         | Reference | Renderer, conversation, adapter, routing, Manager, and trust integration          |
| [distribution-and-cli](distribution-and-cli.md)                 | Reference | CLI grammar, launch profiles, package ownership, and release contract             |
| [dynamic-plugin-lifecycle](dynamic-plugin-lifecycle.md)         | Reference | Dynamic package generations, activation, rollback, and cleanup                    |
| [dynamic-package-store](dynamic-package-store.md)               | Reference | Source intake, private transactions, permissions, and leases                      |
| [plugin-bundles](plugin-bundles.md)                             | Reference | Bundle claims, lifecycle coordination, permission merging, and Manager projection |
| [showcase-capture-integration](showcase-capture-integration.md) | Guide     | Host support for website-owned capture workflows and artifacts                    |

## Design Host UI and extension points

| Document                                                                    | Type                           | Use it for                                                                  |
| --------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| [data-contribution-routing](data-contribution-routing.md)                   | Reference                      | Structured shell records, pages, outlets, localization, and routing         |
| [extension-point-management](extension-point-management.md)                 | Reference                      | Surface/outlet catalogs, diagnostics, and point policy                      |
| [ui-extension-catalog-codex-adapter](ui-extension-catalog-codex-adapter.md) | Reference                      | Host-neutral catalog, Codex adapter availability, and verification matrix   |
| [manager-content-design](manager-content-design.md)                         | Reference                      | Host UI hierarchy, navigation, controls, layout, and accessibility          |
| [manager-settings-tabs](manager-settings-tabs.md)                           | Compatibility reference        | Stable Settings content-tab seam and honest not-mounted behavior            |
| [manager-settings-navigation](manager-settings-navigation.md)               | Reference                      | Contributed first-level Manager destinations and standard page composition  |
| [host-collections](host-collections.md)                                     | Reference                      | Host-owned list/detail collections, actions, search, and lifecycle          |
| [host-form-system](host-form-system.md)                                     | Reference                      | Host form primitives, TDesign adapter, theme, layout, and validation        |
| [schemastery-ui](schemastery-ui.md)                                         | Reference                      | Form-engine package boundary, presenters, and layout semantics              |
| [host-icon-theme](host-icon-theme.md)                                       | Reference                      | Icon provider handles, preference persistence, and renderer synchronization |
| [icon-theme-manager-token-map](icon-theme-manager-token-map.md)             | Reference / recorded decisions | Manager semantic icon seats and retained acceptance-map entries             |
| [ui-copy-principles](ui-copy-principles.md)                                 | Reference                      | Concise product copy, localization, diagnostics, and review principles      |
| [ui-copy-catalog](ui-copy-catalog.md)                                       | Reference / historical scan    | Copy inventory and explicitly dated integration observations                |

## Understand authority, Agent, Channel, and Marketplace features

| Document                                                          | Type                   | Use it for                                                                      |
| ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| [platform-capabilities](platform-capabilities.md)                 | Reference              | Platform service, Permission Broker, adapter availability, and transport        |
| [publisher-grants](publisher-grants.md)                           | Reference              | Device-bound PublisherGrant authority, persistence, and optional registry       |
| [multi-provider-sessions](multi-provider-sessions.md)             | Reference              | Provider Fleet, structured identities, independent connections, and CLIProxyAPI |
| [agent-events](agent-events.md)                                   | Reference              | Session/Agent events, messaging, permissions, and private adapter boundary      |
| [agent-history](agent-history.md)                                 | Reference              | Read-only durable history, paging, deduplication, redaction, and ownership      |
| [agent-loop](agent-loop.md)                                       | Experimental reference | Principal-bound AgentLoop path, catalog resolution, and unsupported boundaries  |
| [channel-runtime](channel-runtime.md)                             | Reference              | Node Channel services, bindings, adapters, reliability, and evidence scope      |
| [marketplace-source-management](marketplace-source-management.md) | Reference              | Source management, cache behavior, and Manager information architecture         |
| [marketplace-trust-and-ranking](marketplace-trust-and-ranking.md) | Reference              | Official/Certified dimensions, revocation, search, and projection               |

## Read historical plans and delivery evidence

| Document                                                                                    | Type                        | Use it for                                                            |
| ------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| [development-plan](development-plan.md)                                                     | Historical plan             | Recorded stages and feasibility observations; not the current roadmap |
| [manager-feedback-ledger-2026-08-26](manager-feedback-ledger-2026-08-26.md)                 | Historical delivery record  | 2026-08-26 requirement batch and its retained evidence states         |
| [certified-dom-permission-ledger-2026-08-30](certified-dom-permission-ledger-2026-08-30.md) | Historical candidate record | 2026-08-30 candidate SHAs, local checks, and pending gates            |

## Maintainer and artifact entry points

[AGENTS.md](https://github.com/cordisx/cordisx/blob/main/AGENTS.md) routes maintainers to repository rules;
[CONTRIBUTING.md](https://github.com/cordisx/cordisx/blob/main/CONTRIBUTING.md) records contribution terms. Those
instructions are not public product reference material.

Package READMEs, including [the CLI](https://github.com/cordisx/cordisx/blob/main/packages/cli/README.md), stay beside
their published artifacts. [Example READMEs](https://github.com/cordisx/cordisx/blob/main/examples/plugins/hello-toolbar/README.md)
explain individual demos. The [plugin-development Skill](https://github.com/cordisx/cordisx/blob/main/skills/cordisx-plugin-development/SKILL.md)
is shipped with the CLI and keeps its task references together for installed
use. These local entry points may summarize a feature and link to the detailed
reference without duplicating its authority.
