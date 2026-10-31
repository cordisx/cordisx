# Use Codex CLI with CordisX model services

Status: implementation candidate; not present in Host beta.36. Use a compatible
installed Host and CLI after this feature is released.

`cordisx cli` starts the original Codex CLI with inherited terminal input and
output. It preserves its terminal UI, tools, approval controls, `exec`, `resume`,
and `fork`. It does not modify the Codex binary or rewrite global configuration.

## Select an existing service

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

`--list` includes native configured providers for context; `managed: true` marks
services supported by `--service`. Native configured providers use the path below.
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
