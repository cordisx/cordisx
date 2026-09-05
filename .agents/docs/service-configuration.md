# Plugin-owned service configuration

Status: Host data/API foundation and the CLIProxy Providers plugin-detail
bridge are implemented against the formally merged
`cordisx-protocol@871f028c57cffaa3080b06f6319baebfb4107438` contracts. The
Manager bridge uses the existing Host TDesign form and a token/profile/generation
fenced CDP binding; it does not create a global Provider settings category.

For an independent product-mode renderer check, use the normal launcher path
with a temporary Home Config rather than `dev --config` (which is intentionally
read-only and has no service-config binding):

```sh
proof_root="$(mktemp -d)"
node packages/cli/scripts/run-isolated-app-smoke.mjs \
  --port 17426 --profile-dir "$(mktemp -d)" \
  --home-config "$PWD/cordisx.cli-proxy.example.json" -- \
  --manager-screenshot "$proof_root/manager.png" \
  --manager-tab plugins --manager-plugin cli-proxy-api \
  --manager-detail-tab config --manager-viewport-width 480 --report "$proof_root/report.json"
```

The runner copies that fixture into a new temporary `HOME` and launches
`codex smoke --data host-isolated`; it does not read a pre-existing profile. It also
keeps cleanup evidence from masking a smoke failure when no report was written.
Its `runnerCleanup` report record and `[cordisx-smoke-cleanup]` line require
`homeRootRemoved=true` and `homeRootExists=false` alongside the port, profile,
and Crashpad checks.

A new isolated profile does not inherit the daily App login state. Before a
visible semantic smoke, confirm both the public route/outlet and the visible
login state. A logged-out run can still prove bootstrap and cold-graph network
behavior, but acceptance of the real main outlet, page, or avatar UI requires a
logged-in profile. If login UI replaces those semantic anchors, classify the
result as an authentication precondition rather than an adapter regression.
Use `--show-window` only with an explicit custom `--smoke-entry`; the built-in
harnesses remain minimized and automation-owned.

## Boundary

Launcher service configuration is not renderer `Config`. It is stored under
the owning plugin and exact service id, projected through Host-owned schema and
form metadata, and mutated only through an identity/profile/generation/revision
fenced API. Plugins receive no home path, filesystem writer, service handle,
credential value, selector, or raw bridge.

The Host owns CAS, atomic persistence, permission classification, secret
reference brokerage, restart orchestration, last-good state, diagnostics, and
cleanup. The plugin owns its schema, defaults, localized descriptions,
normalization, redacted projection, and fixed `configApplies` declaration.

`permission-denied` is distinct from `validation-failed`. Authorization occurs
before reading the current revision, validating the candidate, persisting a
secret reference, or restarting a service. A read-authorized but write-denied
descriptor reports `writable=false`; a write attempt returns the protocol
permission code and revision zero without invoking the restart callback.

## Persistence and activation

Generic state lives at:

`plugins[pluginId].services[serviceId].profiles[profileId]`

One profile records desired revision/config, last-good revision/config, an
exclusive generation/owner-token candidate, and an explicit app-restart flag.
Every update uses the existing private home-config lock, strict parse, atomic
replace, and file-mode path.

- `service-restart`: stage one candidate, restart the owning service, validate
  its new generation, then publish revision and last-good together. Restart
  failure aborts the candidate and keeps the old configuration active.
- `app-restart`: persist the next-start configuration and retain the active
  last-good configuration. The descriptor shows both and reports `staged` plus
  `restartRequired=true`. A later complete launcher readiness step promotes it.

No field-dependent inference changes the declared mode after Save.

## CLIProxy Providers planes

The built-in plugin declares two protocol-owned Schemastery-backed contracts:

- `providers-runtime` (`service-restart`): provider id/display name, enabled
  state, endpoint, opaque Host credential reference, timeout, and remote/public
  model mapping;
- `providers-startup` (`app-restart`): executable and isolated provider data
  directory used by the next application process.

Runtime and startup entries join only by provider id. Orphan startup entries,
duplicate ids, remote cleartext HTTP, credentials in endpoint URLs, inline
secrets, duplicate source/public model ids, multiple enabled defaults, and
shared normalized data roots fail closed.

Provider Fleet continues to route models and sessions by composite identity.
Model mapping changes only the provider-local model id; it cannot remove or
substitute `providerId`. External providers remain separate from the native
current connection and never expose a raw App Server bridge.

## Credentials

Stored service configuration may contain only `keychain:` or `host-secret:`
references. Descriptor configuration and results omit reference values and
expose exact secret field paths plus configured state. A non-secret mutation
that omits a reference preserves the existing one.

The process boundary resolves a reference launcher-side and passes the value
through a child-only environment key; the reference and value are absent from
App Server argv and renderer metadata. `host-secret:env/NAME` resolves from the
launcher environment. Other schemes require an explicit Host resolver and are
honestly unavailable when none exists.

## Legacy import

The existing top-level `providers` reader remains an import-only compatibility
fallback until the plugin-detail migration is product-accepted. Once a
`providers-runtime` service record exists for the selected profile it is
authoritative and legacy top-level entries are ignored. New provider-specific
state is never written to a CordisX core settings category.

The final Manager slice must migrate through the narrow API, preserve a
recoverable last-good value, remove product documentation that instructs users
to edit top-level providers, and prove the plugin-detail flow in an isolated
`app://` renderer before legacy write guidance can be removed. The bridge
projects only `providers` and configured-secret state; it never sends a secret
reference value or credential value to the renderer.
