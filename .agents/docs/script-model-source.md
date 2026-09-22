# Developer script model source

Status: independently composable Host implementation. Provider configuration,
production launcher/CDP wiring and Manager controls are not connected by this
slice. No public plugin API is added. Real-App verification is not claimed.

## Trust and configuration

This source runs a developer's own local program to produce model membership.
Saving its Provider configuration is the trust decision. There is no session
grant, command approval registry, content fingerprint or per-run confirmation.
Editing the script itself does not require saving or approving it again.

The Host configuration surface should display `SCRIPT_EXECUTION_NOTICE`: the
command runs with the user's OS permissions, including file and network access.
Neither structured execution nor `shell:false` is a sandbox. Plugins must not
receive this configuration or access to the save/run/cancel operations.

Configuration (`ScriptSourceConfig`, with optional budgets normalized by
`parseScriptSourceConfig`):

```json
{
  "schemaVersion": 1,
  "command": {
    "kind": "exec",
    "executable": "node",
    "args": ["./models.cjs"]
  },
  "cwd": "/absolute/project/path",
  "environment": {
    "inherit": false,
    "refs": { "API_KEY": "MY_PROVIDER_API_KEY" },
    "values": { "LANG": "C" }
  },
  "timeoutMs": 10000,
  "maxStdoutBytes": 1048576,
  "maxStderrBytes": 65536,
  "maxModels": 1000
}
```

`exec` passes an executable and literal argument array with `shell:false`.
Relative script paths resolve under `cwd`; a bare executable uses normal OS
executable lookup. Executable scripts with a shebang are supported. For shell
syntax the user explicitly chooses
`{"kind":"shell","command":"node ./models.cjs"}`. That mode runs through the
platform shell and is local command execution, not restricted expression parsing.

The default environment is empty. `refs` maps child variable names to existing
Host environment variable names; missing references fail with a fixed error code.
`inherit:true` explicitly inherits the Host environment, including any credentials
it contains. Literal `values` override inherited variables; a name cannot be both
a reference and a literal. Prefer references or script-owned credential handling
to literal secrets. No managed Provider key or adapter request capability is
automatically injected, and this module never calls their owners. Resolved
environment values exist only in the execution path, not snapshots or diagnostics.

## Manual execution and output

Saving/restoring configuration, reading status, subscribing, startup and generic
catalog refresh must not execute a script. Only the explicit Run operation starts
it. There are no timers, file watchers, automatic retries or queued reruns.
The runtime allows at most four concurrent processes and one per binding.

Output must be exactly one UTF-8 JSON document:

```json
{
  "schemaVersion": 1,
  "complete": true,
  "models": [{ "id": "exact-model-id", "label": "Optional display label" }]
}
```

The JSON schema rejects unknown fields, partial results, duplicate object keys,
invalid UTF-8, control characters and budgets over 1 MiB stdout / 64 KiB stderr /
1,000 models. IDs are exact and case-sensitive (maximum 512 characters); labels
are at most 256. Duplicate model IDs keep the first item. Model metadata cannot
declare aliases, capabilities, endpoint, authentication, defaults or scope.
Both streams are continuously drained, but raw stderr is never retained and raw
stdout exists only until validation. Script output can itself reveal a secret as
a model ID; this is trusted developer code, not a secret-detection guarantee.

Only exit zero with a complete valid output produces an atomic result. Valid empty
is authoritative; nonzero exit, malformed output, timeout or cancellation preserve
the same-config/same-scope LKG and mark it stale. Changing configuration, binding
scope or replace/supplement mode clears this runtime's old members. Invalid saves
leave the existing configuration unchanged. Snapshots are currently session-only;
the owner persists Provider configuration and may restore it without execution.
This module does not write configuration, cache files or credentials.

POSIX execution owns a process group, closes stdin and drains both output pipes.
Cancel, timeout, overflow and disposal send group SIGTERM, then SIGKILL after one
second. Even a successful root exit cleans up remaining group children. Normal
Host process exit sends group SIGKILL; the owner must await `dispose()` during its
normal shutdown lifecycle. Windows is unsupported until tree cleanup is provided.
Process groups do not confine deliberate daemonization into another session or
survive arbitrary Host SIGKILL; no OS sandbox/job-container guarantee is made.

## Host integration

All imports are from `packages/cli/src/launcher/model-catalog/script-*`:

- `script-types.ts`: pure `ScriptSourceConfig`, `ScriptSourceBinding`,
  `ScriptIntent`, `ScriptSourceSnapshot`, `ScriptSourceEvent` and notice text.
- `script-runtime.ts`: `new ScriptSourceRuntime({environment?, maxConcurrent?,
  diagnostic?})`. The environment callback is read only when explicitly needed.
- `save({bindingRef, scopeRevision, mode}, config)` registers trusted Provider
  configuration and returns status without executing. New configuration receives
  an opaque `authorityRevision`. Identical saves do not reset LKG or a running job.
- `run({bindingRef, scopeRevision, expectedRevision})` returns immediately with
  `started`, `already-running` or `busy`. `cancel` takes the same current-view CAS
  intent and resolves after cleanup. No command/path/env is in either intent.
- `readStatus(bindingRef)` is synchronous; `subscribe(listener)` emits bounded
  invalidations carrying binding, scope, authority/config revision and run
  generation. Re-read status, and compare all identities before accepting results.
- Await `remove(bindingRef)` or `dispose()` to drain owned jobs. Saving a changed
  binding aborts the old job; it cannot publish into the replacement entry.
- `createScriptManagementHandler(runtime, admit)` strictly parses only
  `{kind:'read'|'run'|'cancel', bindingRef, scopeRevision, expectedRevision}`.
  Install it only behind current Host document/profile management admission.
  The ordinary catalog-read token or plugin service is not management admission.

`composeScriptMembers` demonstrates membership-only target composition.
`script-replace` fully replaces the base, including complete-empty. A supplement
is included only in native/auto augment mode, never auto-only or manual-replace.
Complete-empty base leaves supplements; empty supplement removes only its own
declaration. Exact duplicate IDs preserve both provenance values; supplement-only
items are `notListed:true`. Results are always `script-declared`, not API evidence.
The owner must still enforce native/plugin admission, overlay policy and target
CAS; this helper grants no execution capability and changes no selection/default.

## Evidence scope

`script-source-parser.test.ts` and `script-source-composition.test.ts` cover
strict configuration/output and membership semantics. The two
`script-source-*.integration.test.ts` suites generate isolated temporary fixture
scripts to cover real process cleanup, budgets, environment choices, scope/config
isolation, LKG and management intents. They never execute user scripts, read real
Provider configuration or launch an App. Production/UI/native evidence belongs to
the subsequent owner integration, not these module tests.
