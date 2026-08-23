# CordisX Documentation

This directory is the public, aggregatable source for CordisX product and architecture documentation.

- `getting-started.md` records local development, launcher, smoke-test, and
  example-plugin instructions that should not live in the product README.
- `architecture.md` defines the current runtime, lifecycle, slot, and security boundaries.
- `data-contribution-routing.md` defines the approved structured shell-contribution and
  page/outlet architecture that replaces direct plugin DOM rendering in native shell areas.
- `distribution-and-cli.md` defines the product monorepo, home configuration,
  app/profile command model, package ownership, and release gates.
- `development-plan.md` records staged implementation and validation boundaries.

Normative plugin contracts belong in `cordisx/cordisx-protocol`; private or provisional planning belongs in `cordisx/roadmap`.
