# CordisX management and service entry

Use the CLI installed for the user's CordisX profile. Check `cordisx --help`
first: older releases may not have the independent Manager command. Consult the
[Host documentation index](https://raw.githubusercontent.com/cordisx/cordisx/main/.agents/docs/README.md)
and the matching release's guides when a command or capability is absent.

To open the independent management page when the selected profile has a running
owner, use `cordisx manager` or `cordisx manager open --profile <id>`. The
command requests the default browser and reuses or starts the profile's local
management process; a successful request does not prove the page opened. The
independent Manager is currently unavailable on Windows. The commands
`cordisx manager start`, `cordisx manager status`, and
`cordisx manager stop` control only that management process, accept
`--profile <id>`, and do not stop the profile owner. The management process
ends when its owner goes away. For a terminal without a browser,
`cordisx manager open --print-url` explicitly prints a
temporary local URL. Do not guess a port, disclose a one-time URL or token in
chat, or make the management service reachable on the network. An open page is
not proof that every plugin, operation, or client adapter is available.

The installed CLI also supports `cordisx start --mode service` and
`cordisx status --mode service --json` for a standalone owner; see the
[service-mode guide](https://raw.githubusercontent.com/cordisx/cordisx/main/.agents/docs/standalone-services.md)
for profiles and limitations. The Manager command does not start a missing
owner. Starting service mode is not required when the existing App already owns
the selected profile, and the existing modes cannot simultaneously own that
profile. Preserve the user's App, conversations, credentials, and profile; do
not stop or restart an existing instance merely to
open the page. If the CLI reports an ownership conflict, explain the actual
state instead of starting a second owner or claiming multiple clients are
connected. Only launch a service or page as part of the user's requested work.

An agent already running under CordisX can inherit `CORDISX_SUPERVISOR_*` and
`CORDISX_DOCK_*` variables for its parent process. They are not credentials for a
new launch; remove those internal variables from the child process environment
before invoking launch or dry-run commands. Preserve the user's `HOME`,
`CODEX_HOME`, and `CORDISX_HOME`. If a non-default CordisX home or profile is in
use, identify it through the existing integration status and select it
explicitly rather than guessing.

Treat model services as shared only where the Host reports that capability.
Codex, Claude Code, and other clients retain their own sessions, connection
status, native capabilities, and model selections. Report pending or
unavailable operations without presenting them as applied. Removing a model
service retains its environment variable because plugins and clients may still
use it; avoid promising that the credential has been removed.
