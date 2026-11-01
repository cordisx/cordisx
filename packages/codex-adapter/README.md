# @cordisx/codex-adapter

CordisX-owned structural adaptation rules for Codex Desktop. This package has
its own immutable npm versions and release tags, independent of Host/Creator.
It contains submission/model-selection, account-discovery and task-creation
modules, the older audited layout, and synthetic regression fixtures.

The self-contained `dist/adapter.mjs` entry implements Host adapter API 1 and
relay contract 1. It has no runtime npm dependencies or installation scripts.
Only CordisX's verified adapter loader should execute downloaded entries.
Installed native App files are never changed. Native resources and complete
transformed resources stay on the user's machine.

See the [adapter reference](../../.agents/docs/codex-adapters.md) for source
trust, exact selection, coexistence, cache policy, activation and release gates.

After building, `npm test` in this package directory runs the shipped synthetic
checks with Node alone. The same checks run directly from an unpacked artifact.
