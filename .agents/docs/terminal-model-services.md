# Use Codex CLI with CordisX model services

Available from Host beta.37. Plugin service selection requires a compatible
running Host; shared declarations can launch the CLI without a desktop App.

`cordisx cli` starts the original Codex CLI with inherited terminal input and
output. It preserves its terminal UI, tools, approval controls, `exec`, `resume`,
and `fork`. It does not modify the Codex binary or rewrite global configuration.

## Unified start command

```sh
cordisx start -s aiden -m gpt-6.1-sol
cordisx start --mode cli -s aiden -m gpt-6.1-sol
cordisx start --mode cli claude-code -s aiden -m gpt-6.1-sol
cordisx start --mode cli --list
```

`-M` is the short form of `--mode`, for example `cordisx start -M cli -s aiden -m gpt-6.1-sol`.
`--mode app` is the default. App mode keeps the configured default app/profile;
explicit service/model selection currently targets Codex new drafts. It does
not move an existing chat to a different service. `start` stays idempotent:
a running instance with different launch options is never restarted implicitly.
CLI mode defaults to Codex; `claude-code` selects the original Claude Code
terminal. The `cordisx cli` alias remains supported. `-s`/`-m` mean
`--service`/`--model`. Both must be supplied together, and arguments after `--`
belong to the selected client. `--profile` selects an existing CordisX Codex
service profile, while client profile arguments belong after `--`.

CLI processes have separate terminal sessions and reuse the same selected
CordisX gateway. Starting two terminals never restarts two Host services.
Without service selection the client's own configuration/authentication applies.

## Shared model services

CLI selection also reads the existing
[shared model-service declarations](shared-model-services.md). It reuses service
validation, per-app model lists and configured auth environment without writing
`config.toml`, Claude settings, or changing the desktop default. These services
need no running desktop Host. Codex requires `openai-responses`; Claude Code
requires `anthropic-messages`. A disabled service, unsupported protocol, missing
key or unknown model is rejected before the client starts.

For Claude Code an invocation-scoped `--settings` overlay pins the endpoint and
credential helper, so a user settings `env` entry cannot redirect the explicitly
selected service. The key stays in the child environment, never command arguments
or a settings file. Existing tool permissions are retained; the launcher does
not enable bypass mode. An unauthenticated loopback managed gateway can also
serve Claude Code; a managed bearer gateway is rejected until a Claude-specific
credential adapter is provided. Gateway support for a model remains necessary.

## Select an existing plugin service

Keep the CordisX Host for the selected profile running, with the provider plugin
enabled and logged in. List the exact provider and model IDs:

```sh
cordisx cli --list
cordisx cli --list --profile work
```

Use an exact provider ID and model ID from that output:

```sh
cordisx cli --service PROVIDER_ID --model MODEL_ID
cordisx cli --profile work --service PROVIDER_ID --model MODEL_ID -- --no-alt-screen
cordisx cli --service PROVIDER_ID --model MODEL_ID -- exec 'Explain this project'
```

Plugin-managed services such as Aiden/TraeX and Manager-managed connections use
the live Host's existing gateway and credentials. The CLI does not export plugin
login or copy credentials into Codex configuration. It holds a launch-scoped
command-backed credential lease and releases it when the child exits or startup
fails. Owner/service replacement invalidates the lease; start a new CLI session.
An orphaned launch expires. The existing App and unrelated services are retained.

`--list` merges the live catalog with compatible shared declarations; `managed: true` marks
plugin/Manager gateways, and shared declarations carry `source: "model-service"`.
Without a live Host the result is `complete: false` and lists shared services only.
Other native configured providers use the path below.
The model list reflects current eligibility and provider login state; an absent
or removed model cannot be selected by inventing an ID.

This iteration selects the provider at launch. It adds neither a provider switch
command nor cross-provider entries to Codex's `/model` menu. Changing providers
means exiting this terminal session and starting another with the desired
service. Codex's own model menu still follows that binary's behavior; do not
assume that a menu model is supported by every gateway.

## Native Codex providers

Without `--service` or `--list`, the wrapper starts Codex with its existing
provider configuration and needs no running CordisX Host:

```sh
cordisx cli -- --profile my-provider
cordisx cli -- -c 'model_provider="my-provider"' --model MODEL_ID
cordisx cli -- exec --help
```

Configure custom endpoints and authentication through the
[Codex configuration reference](https://developers.openai.com/codex/config-reference).
Codex requires its supported Responses protocol; an arbitrary Chat Completions
or Anthropic endpoint is not automatically compatible. A CordisX provider plugin
may implement the required gateway adaptation.

Arguments before `--` belong to CordisX. Its `--profile` selects the existing
CordisX profile; a Codex `--profile` goes after `--`. Host-isolated profiles use
their own existing Codex home. Unknown profiles are rejected rather than created.
With `--service`, pass-through arguments cannot replace the selected
provider/model, model catalog, or remote app-server connection.

## Per-run instruction override

```sh
cordisx cli --instructions-file ./prompt.md
cordisx cli --service PROVIDER_ID --model MODEL_ID --instructions-file ./prompt.md
```

Claude Code uses its native `--system-prompt-file` (requires a compatible client).
The file must be nonempty, regular, and at most 1 MB. The wrapper passes the
resolved path as Codex's `model_instructions_file` for this invocation. It does
not change the global default or remove independent tool/permission policies.
Whether an already-loaded or resumed thread adopts a different override depends
on the selected Codex version; this command is not a promise to rewrite past
history or instantly replace a running thread's instructions.

## Availability and verification

- Missing Codex CLI: install a compatible CLI or select it with
  `--codex-executable /absolute/path/to/codex`.
- Missing or older live Host: `--service`/`--list` report unavailable. They never
  start another App, fabricate an inactive runtime, or fall back to stale login.
- A gateway that does not implement Codex's required wire contract may fail even
  when its model appears in a catalog. Check the actual provider response.
- Exit status follows the Codex child. Startup errors and provider retirement
  return nonzero status.

Source tests cover the production management socket, exact model selection,
credential-helper execution/revocation, process startup failure, owner lifetime,
and pass-through arguments. A local real-Codex Responses fixture covers request
routing and instruction-file delivery. These do not establish external provider
account acceptance or a native desktop UI test.
