# Shared model services and the Codex–Claude bridge

Experimental Host implementation. A model service is declared once in the
CordisX home config and projected into each app's own configuration when
CordisX starts that app. The same launch connects Codex Desktop and Claude
Desktop so each can list, read, start, and message the other's
conversations.

## Declaring a model service

Top-level `providers` in `~/.cordisx/config.json` holds two kinds of entry.
`cli-proxy-api` entries run a launcher-owned gateway
([multi-provider sessions](multi-provider-sessions.md)). `model-service`
entries start nothing; they describe a vendor:

```json
{
  "id": "sub2tok",
  "kind": "model-service",
  "displayName": "sub2tok",
  "baseUrl": "https://api.sub2tok.com",
  "apiKeyEnv": "SUB2TOK_API_KEY",
  "protocols": ["anthropic-messages", "openai-responses"],
  "models": { "codex": ["gpt-6.1-sol"], "claude": ["claude-opus-5-5"] }
}
```

- `protocols` decides which apps can use it: Codex reads `openai-responses`,
  Claude reads `anthropic-messages`. `appliesTo` narrows the apps further.
- `apiKeyEnv` names the variable that holds the key. Put the value in
  `environmentVariables` or the launch environment; no key is written into an
  app's configuration.
- `baseUrl` must be HTTPS, or HTTP on loopback.

The manager's **Model services** page lists these declarations under
**Model services for Codex and Claude** and adds, edits, and deletes them as
one compare-and-swap edit. A key typed there is stored in
`environmentVariables` as `CORDISX_MODEL_SERVICE_<ID>_KEY` and is never read
back; deleting the service removes that variable. Changes apply on the next
launch.

## Codex

Before every host launch (prelaunch, `run`, and `dev`), CordisX writes each
Codex-capable declaration into `<CODEX_HOME>/config.toml` as
`[model_providers.<id>]` with `wire_api = "responses"`, `env_key`, and
`requires_openai_auth = false`. Keys the declaration does not own in an
existing table are kept. Codex only loads `wire_api = "responses"`; any other
value fails the whole file, so there is no wire API option.

`cordisx start codex <profile> --provider <id>` also sets `model_provider` and
`model` to that declaration. Without `--provider`, the configured default is
left alone.

The Codex model selector and the agent tools (`list_model_providers`,
`create_thread_with_provider`) read the native tables merged with the
declarations; a declaration wins over a table of the same id.

## Claude

```sh
cordisx start claude [profile] [--provider <id>]
cordisx status claude [profile]
cordisx stop claude [profile]
```

The profile lives in `~/.cordisx/apps/claude/profiles/<profile>/data-3p` and is
passed as `--user-data-dir`. Claude reads its third-party setup from
`<userData>-3p` unless the folder already ends in `-3p`; signed builds ignore
`CLAUDE_USER_DATA_DIR` and fall back to the user's own data folder, so the
launcher never sets it. The app refuses debugging switches, so Claude gets no
CDP host.

CordisX seeds `configLibrary/<uuid>.json` per Claude-capable declaration with
`inferenceProvider: "gateway"` and the `helper-script` credential kind: a
helper in the profile prints the variable `apiKeyEnv` names. `_meta.json`
`appliedId` must be a lowercase UUID; CordisX derives one per provider id.
Entries the user adds in Claude's own settings, and their applied choice on a
plain relaunch, are kept. `--provider` makes a declaration the applied one.

`stop` sends SIGTERM and waits up to 20 seconds for the app to save, then
SIGKILL.

## Agent bridge

A Codex launch starts the agent bridge: an owner-only HTTP endpoint on
`~/.cordisx/run/agent-bridge.sock`, with its token in `agent-bridge.json`.

Both apps get the same four tools, named the same in each:
`list_sessions`, `read_session`, `start_session`, and `send_message`, each with
an `app` argument (`"codex"` or `"claude"`). A new app is a new `app` value,
not new tool names. Results carry `codex://` or `claude://` links.

- **`app: "codex"`** runs on the Codex desktop's own app-server through the
  intermediary's `native-request` control message, which allows only
  `thread/list`, `thread/read`, `thread/start`, `thread/resume`, `turn/start`,
  and `turn/interrupt`. Threads it starts show in the Codex sidebar;
  `start_session` can pick a declared provider and model.
- **`app: "claude"`** from Codex waits in the bridge queue until a Claude Code
  session's plugin (`assets/claude-bridge`, loaded through
  `CLAUDE_CODE_PLUGIN_DIRS`) polls for it and answers with Claude's own session
  tools. A session polls once Claude's session tools are connected. From
  Claude, the plugin calls those tools directly. A session it starts is
  detached so it is the user's own.

Claude Desktop asks the person to allow every new session ("Allow Claude to
start the session?"), whoever requests it; a settings allow rule does not
change that. `start_session` with `app: "claude"` therefore shows that prompt
in the answering session and waits for it (up to about three minutes).
`send_message` needs no approval. `cordisx start claude` still adds both tools
to `permissions.allow` in `~/.claude/settings.json`.

The Codex side needs a running CordisX Codex launch; the Codex → Claude side
needs at least one open Code session in the CordisX-launched Claude. Each side
reports the other as unavailable otherwise. Codex asks the user to approve the
first CordisX tool call in a conversation, as for any MCP tool.
