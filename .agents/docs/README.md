# CordisX Documentation

This directory is the public, aggregatable source for CordisX product and architecture documentation.

- `getting-started.md` records local development, launcher, smoke-test, and
  example-plugin instructions that should not live in the product README.
- `architecture.md` defines the current runtime, lifecycle, slot, and security boundaries.
- `manager-content-design.md` is the reusable design guideline for manager
  hierarchy, title de-duplication, tabs, flat lists, cards, states, and
  accessibility/screenshot regression evidence.
- `manager-settings-tabs.md` freezes the host-neutral extensible settings-tab
  surface/content outlet, single ordering model, controlled page-body mount,
  lifecycle, protocol/host/mono PR order, and validation matrix.
- `plugin-configuration.md` defines Schemastery-first forms, the Standard
  Schema validation boundary, revision-fenced persistence, live/restart
  application, last-good recovery, secrets, and lifecycle-owned field
  renderers.
- `host-form-system.md` defines the Host-owned TDesign-aligned primitive
  adapter, official Web Components audit, scoped theme/layout/a11y contract,
  schema selection, draft/validation states, and current Manager integration.
- `plugin-devtools-console.md` defines the plugin-scoped DevTools Console,
  issuance-bound Host instrumentation, native variadic arguments, coverage
  guarantees, Luna rendering, privacy and bounded lifetime.
- `dynamic-plugin-lifecycle.md` defines local package staging, dependency and
  permission planning, minimum-scope plugin generations, atomic activation,
  last-good rollback, uninstall cleanup, and Host-owned manager operations.
- `data-contribution-routing.md` defines the approved structured shell-contribution and
  page/outlet architecture that replaces direct plugin DOM rendering in native shell areas.
- `extension-point-management.md` defines surfaces and outlets as the two
  extension-point families, their localized host catalog, manager search and
  detail experience, point-policy enforcement, and delivery/validation order.
- `marketplace-trust-and-ranking.md` defines the independent Official and
  Certified dimensions, protected Marketplace trust root, exact-artifact
  revocation behavior, bounded stable search order, and Manager projection.
- `ui-extension-catalog-codex-adapter.md` defines the complete host-neutral UI
  catalog, Codex adapter availability, structured payload families, DeepSeek
  Harness mapping/refusals, contextual identity boundary, and validation matrix.
- `distribution-and-cli.md` defines the product monorepo, home configuration,
  app/profile command model, package ownership, and release gates.
- `dynamic-package-store.md` maps source-v1/package-v2 intake and Host-private
  transaction hardening onto the single launcher package/activation stores.
- `platform-capabilities.md` defines the Platform service, permission broker,
  current-connection adapter boundary, manager projection, PR order, and validation scope.
- `multi-provider-sessions.md` defines provider-aware model/session identity,
  Provider Fleet routing, the launcher-private connection plane, CLIProxyAPI
  integration, PR order, and validation scope.
- `agent-events.md` defines the UI-neutral Session/Agent event ledger,
  DSH-aligned messaging facade, permission chain, private adapter boundary,
  honest degradation, and validation matrix.
- `agent-trace-showcase.md` defines the independent development-only Agent
  Trace Showcase plugin, its stacked core-contract dependency, session Timeline
  product boundary, fixture seam, lifecycle, and validation matrix.
- `channel-runtime.md` defines the Channel product operations, composite
  account/tenant/conversation/thread/task binding, Node-side service boundary,
  official Feishu/WeCom/WeChat feasibility, security and reliability contracts,
  DSH/OneWorks facade, PR order, and simulator-first validation matrix.
- `development-plan.md` records staged implementation and validation boundaries.

Normative plugin contracts belong in `cordisx/cordisx-protocol`; private or provisional planning belongs in `cordisx/roadmap`.
