# Permission V2 Smoke

Permission V2 Smoke is a development-only probe for the Host-owned CordisX Permission Broker. It registers two commands that request public Agent-event and task-catalog operations; it does not implement a permission dialog or bypass a denied policy.

## Probes

- `probe-agent-events` queries the public Agent event ledger for a fixed smoke-test session id.
- `probe-tasks` requests one task from the `codex` provider catalog.

Both commands are useful only in a controlled development fixture. Successful command registration does not prove that a capability was granted or that the underlying provider is available. Inspect the Manager permission and runtime diagnostics for the actual outcome.

## Current boundary

This package is an explicit-local, unsigned smoke fixture. It is not a user-facing plugin and must not be included in the default CordisX setup.
