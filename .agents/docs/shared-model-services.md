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

Sessions default to bypass permissions mode. Each launch writes
`<profile>/managed/managed-settings.json` (the machine's own managed settings
with `permissions.defaultMode: "bypassPermissions"`) and points
`CLAUDE_CODE_MANAGED_SETTINGS_PATH` at it, for this app only. Claude offers
bypass only to accounts it is enabled for, so the launcher also sets
`bypassPermissionsGateByAccount` and `bypassPermissionsOptInByAccount` in the
profile's `claude_desktop_config.json` for every account the profile has used;
a profile never opened before gets them on its second launch.

`stop` sends SIGTERM and waits up to 20 seconds for the app to save, then
SIGKILL.

## Agent bridge

A Codex launch starts the agent bridge: an owner-only HTTP endpoint on
`~/.cordisx/run/agent-bridge.sock`, with its token in `agent-bridge.json`.

Both apps get the same five tools, named the same in each:
`list_sessions`, `read_session`, `start_session`, `send_message`, and
`check_operation`, each with
an `app` argument (`"codex"` or `"claude"`). A new app is a new `app` value,
not new tool names. Results carry `codex://` or `claude://` links. Both apps
also have `list_model_providers`, which returns the same shape on either side.

Every declared argument does something on both sides; a tool never accepts a
value it ignores.

| Argument                             | Codex                                                              | Claude                                                                   |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `read_session.limit`                 | newest `limit` transcript entries, on top of the 60k-character cap | same                                                                     |
| `start_session.title`                | `thread/name/set` right after `thread/start`                       | written into the session record `list_sessions` reads                    |
| `start_session.providerId` / `model` | a catalog provider and one of its models                           | a `model-service` declared for Claude and one of its `models.claude` ids |

`list_sessions.searchTerm` matches message content as well as titles and returns
`matchedIn` plus a short `match` excerpt and role. Codex searches at most eight
recent thread-read attempts per call, across all providers, with a 60-second
search budget; Claude reads at most forty transcript tails of 1 MiB
each. The total character budget is 4 MiB. `scan.capped` names an incomplete
scan; narrow the query or read a known session directly. `scan.reason:
"read-unavailable"` identifies an interrupted transcript read, rather than a
complete search with no matches. Failed reads count toward the attempt budget;
subsequent fast candidates may still match before the elapsed limit is reached. A matching title does not
require reading its transcript.

`start_session.context: "summary"` appends a mechanical summary of the calling
conversation, capped at 4,000 characters and marked as background. The caller's
app supplies it: Codex uses trusted tool metadata to read the source thread;
Claude uses its session messages. No model call generates the summary. The
result reports `context.summary: "included"` or `"unavailable"`; the default
`"none"` sends the prompt alone.

`start_session` and `send_message` return an `operationId`. Retain it and reuse
it for an identical retry: the bridge returns the existing session instead of
starting a second turn. Reusing it for a different brief is rejected. Operations
live in bridge memory; after a restart `check_operation` returns
`operation-not-found`, so inspect the session before deciding whether to retry.
`check_operation` reports `running`, `done`, `failed`, or `submitted`: a Codex turn is done
only after its matching turn reports completion, and a Claude CLI turn only
after the process exits. A failed readback leaves its state running. An open
Claude session's plugin can confirm that a message was submitted; that
submission acknowledgement does not prove the subsequent model turn finished.

`start_session.dryRun: true` is optional. It checks the provider, model, working
directory and required key without starting an app or spending a model call,
even with a remembered launch preference. Successful combinations are cached
under `run/bridge-validation.json`, keyed by app, provider, model, cwd and the
provider configuration digest. Provider configuration changes invalidate the
cache; keys, directories and the Claude CLI are checked live on every dry run.
The cache contains no credentials. An unavailable bridge refuses enhanced
operations rather than falling back to a path that cannot honor them.

Failures carry `status`, `reason`, `retryable`, `howToContinue`, and a short
`message`, so an agent can determine the next action without parsing prose.

`read_session` reports `transcriptTotal` and `truncated`; pass its `nextCursor`
as `cursor` to continue reading older text. Character clipping preserves the
remaining head of the clipped message on the following page. Cursors are
opaque and valid for the current transcript; changing the transcript can make
one invalid.

`limit` bounds message entries, so a short request never spends its budget on
character clipping; the 60k-character cap still applies underneath it.

- **`app: "codex"`** runs on the Codex desktop's own app-server through the
  intermediary's `native-request` control message, which allows only
  `thread/list`, `thread/read`, `thread/start`, `thread/resume`,
  `thread/name/set`, `turn/start`, and `turn/interrupt`. Authenticated replies
  to outstanding native requests may contain up to 8 MiB of history; commands
  and diagnostics retain their 256 KiB frame limit. Threads it starts show
  in the Codex sidebar; `start_session` can pick a declared provider and model,
  and names the thread when `title` is given (`thread/start` has no name field,
  so the name is set immediately after it).
- **`app: "claude"`** runs on the profile `cordisx start claude` launched
  (recorded in `~/.cordisx/run/claude-desktop.json`) with no Claude session
  open and no prompt:
  - `list_sessions` and `read_session` read the profile's session records
    (`claude-code-sessions/<account>/<org>/local_*.json`) and the CLI
    transcripts in `~/.claude/projects`.
  - `start_session` runs the turn with the Claude Code CLI that Claude Desktop
    installed (the profile's, else the person's own Claude data folder's), in
    bypass mode, on the profile's model service (`ANTHROPIC_BASE_URL` and
    `ANTHROPIC_AUTH_TOKEN` in the child's environment only), with a session id
    chosen up front. When the turn ends, CordisX sends
    `claude://resume?session=<id>` to that profile's process by pid (an Apple
    Event, never to whichever Claude would pick), and Claude imports it as
    `local_<id>`.
  - `start_session.providerId` picks another declaration for that turn: the id
    must be a `model-service` the CordisX config declares for Claude (a service
    only the profile's own `configLibrary` holds has no endpoint here to run
    from), and `model` must be one of its `models.claude` ids. The turn runs on
    that declaration's `baseUrl` and `apiKeyEnv` key. `model` without
    `providerId` names a model of the profile's own service.
  - `start_session.title` writes the title into the session record, so
    `list_sessions` shows it instead of an empty title.
  - The first turn may run for minutes, so the call answers `"started"` without
    waiting for it. It waits up to about eight seconds first: a turn that ends
    in that window adds `turn: { status: "succeeded" }`, or
    `turn: { status: "failed", error }` with the CLI's own reason (the model
    service key is scrubbed out). A turn still running adds no `turn` field and
    a `note` saying to call `check_operation` to see whether it finished. The
    call never blocks on a long task.
  - `send_message` to a session the app is not running resumes it the same
    way (`--resume`). A session the app has open (a Claude Code process with
    `--resume=<id>`) gets the message from its own CordisX plugin
    (`assets/claude-bridge`, loaded through `CLAUDE_CODE_PLUGIN_DIRS`), which
    claims requests addressed to it and submits them with `$.prompt.submit`.

`list_model_providers` in the Claude plugin answers `{ providers: [{ providerId,
title, models: [{ id, label }] }] }` — the CordisX config's Claude-capable
`model-service` declarations merged with the profile's own `configLibrary`
entries. The Codex tool answers the same shape from its own catalog, plus
`threadCreation` (whether `create_thread_with_provider` is available). Neither
returns an endpoint or a key.

From Claude, the plugin's tools send `app: "claude"` through the bridge too, so
starting a Claude session from Claude skips the "Allow Claude to start the
session?" dialog; without a bridge they fall back to Claude's own session
tools.

Why this route: Claude Desktop accepts no debugging switch, reads
`scheduled-tasks.json` only at startup, and refuses its session and routine
tools to runs nobody opened, so nothing inside the app can start a session
unattended. Its own CLI import is the one entry it offers.

### When the other app is closed

Both directions answer the same way, at once, instead of failing or waiting:

```json
{
  "status": "needs-confirmation",
  "reason": "claude-not-running",
  "question": "Claude Desktop is not running. Start it?",
  "howToContinue": "…"
}
```

(`codex-not-running` from Claude.) The agent asks the person; on a yes it
calls again with `launch`:

- `"once"` starts the app for this call.
- `"always"` starts it and remembers the answer, so later calls start it
  without asking. The answers live in `~/.cordisx/apps/claude/bridge-launch.json`
  and `~/.cordisx/apps/codex/bridge-launch.json`.
- `"ask"` forgets a remembered `"always"`.

Claude is started by the Codex launch as `cordisx start claude <profile>`
would, on the profile it last ran. Codex is started by the Claude plugin with
`$.process.run`, as `cordisx start codex <profile>` on the profile recorded in
`~/.cordisx/run/codex-launch.json`, using the CLI named in `CORDISX_CLI`, which
`cordisx start claude` sets. Background `start` supports both a built
CordisX and a source checkout run through `tsx`: the source entry forwards
its loader arguments to the supervisor. Reading Claude sessions needs only the profile's files, so
`list_sessions` and `read_session` for Claude answer while Claude is closed.

### Checking the integration (`integration_status`)

Both apps' agents get one more tool with the same name, schema and result,
`integration_status`, registered beside the session tools. It takes no
argument but an optional `app` (whose side to report as `self`; the default is
the app asking) and is read-only and fast: it starts nothing, runs no turn and
writes no file. On Codex it goes through the same launch-scoped endpoint and
authorization as the session tools; on Claude the plugin sends it to the same
token-guarded bridge (`POST /status`) and, when no bridge answers, assembles the
same shape from the profile files it can read — Claude's own side and the
declared model services. It reports Codex process state as `unknown` when
this fallback cannot probe it; an unanswered bridge never proves the App is closed.
The fallback reports `unavailable`, keeps the requested `self`/`other` perspective,
and checks native Claude session tool availability rather than assuming it.

The result reports, each with a `status`, a stable `reason` and a `remedy`
whenever it is not `ok`:

- **`self` / `other`** — for each app: its profile, whether it is running (the
  process is checked, not a stale pid or binding file), the model service it
  was launched on and whether the config still declares it, and its side of the
  bridge. Codex's liveness comes from the supervisor state its launch writes;
  Claude's from `runningClaudeProfile`. Codex distinguishes `unreachable`
  (running, no bridge answer — restart the launch) from `not-running`.
- **`modelServices`** — every `model-service` declaration with the models each
  app can actually use (`usable` says whether the protocol, `appliesTo`, the
  enabled flag and a non-empty model list all agree) and `keySet`: whether the
  key variable resolves in the launch environment or `environmentVariables`.
  The key's value is never read into the report.
- **`plugins`** — whether the Claude profile's assembled plugin directory
  exists, whether an open Claude session's plugin is polling (the same proof a
  queued message requires, so it means its session tools connected), and
  whether the Codex app-server answers a one-thread read. Bridge and native
  app-server probes have a 1.5-second deadline each; the Claude plugin caps its
  status request at 3.5 seconds.
- **`problems`** and a top-level `status` (`ok`, `degraded`, `unavailable`) —
  the flattened list of everything not working, so an agent can act instead of
  re-deriving it.

The report reuses what already exists — `cordisx status`'s supervisor state,
`runningClaudeProfile`, the binding files, `loadHomeConfig` — rather than
adding probes. It never contacts a model service: a declared key that is
missing is reported, never tested.

### Skills

`cordisx start claude` assembles the profile's plugin in
`<profile>/cordisx-plugin` on every launch: the bridge plus the bundled CordisX
Skills that a Codex launch deploys (`cordisx`, `cordisx-docs`, `cordisx-qa`,
`cordisx-plugin-development`, `cordisx-feedback`). Claude lists them as
`cordisx:<name>` in that profile's sessions only.

Codex runs CordisX's tools without a per-call prompt: the launch passes
`mcp_servers.cordisx_models.default_tools_approval_mode="approve"`. The Codex
side needs a running CordisX Codex launch.
