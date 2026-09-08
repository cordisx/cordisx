# Entity project and projectless execution contexts

The optional public [Entity execution context v1](https://github.com/cordisx/cordisx-protocol/tree/main/.agents/docs/entity-execution-context)
service resolves a future task's context without changing Entity definition bytes
or an existing Session. Chatroom's normal new-Room composer is the initial
consumer; this Host mechanism has no Room UI or Leader business policy.

## Owned configuration and workspace

The Entity RPC verifies the signed active owner, profile, installation and exact
Entity revision before reading or changing a binding. Bindings use the existing
locked owner-document CAS store under a private Entity-configuration source.
They survive an Entity text revision, but a write still names its exact current
revision and the binding's expected revision. Normal plugin document CRUD cannot
address this private configuration source. No Session event or task ledger is
copied into the binding record.

An absent binding is explicit projectless mode. Resolution provisions a private
0700 directory below the selected CordisX profile's `workspaces/projectless`,
keyed by Entity owner and retained product operation. It does not register a
project or create a Session. Symlinked, foreign-owned and redirected directory
components fail closed. This location is never inferred from the launcher cwd.
The consumer retains the resolved selector throughout an uncertain task retry.

A project binding is validated using the current native project authority before
it is persisted and again before task creation. A missing native catalog or
removed project is unavailable, not a signal to fall back to projectless mode.
The optional cwd must resolve inside one of the project's canonical roots; the
first native root is the default when omitted. Root access and symlink escape
checks run in the launcher. Project discovery reads existing projects only.

## Existing Desktop connection

Desktop build 8109 is the audited initial adapter. Its bundled app-server's
experimental schema declares `project/list`, `project/read`, and nullable
`thread/start.projectId`; the generated schema is version-specific, as explained
in the [official app-server documentation](https://learn.chatgpt.com/docs/app-server#message-schema).
The adapter uses the already connected `mcp-request` bridge, not another
app-server process or an IPC/DOM fallback exposed to plugins.

The native create request carries the verified project ID, or explicit null for
projectless execution, together with the resolved directory. The returned native
metadata must match both. A mismatch retains the actual native binding and fails
the one task operation rather than reporting acceptance or creating again.
Older audited transport pins retain their existing v1 behavior; this new project
port is unavailable when its exact adapter capability is absent.

Context resolution does not grant execution authority. The existing task
transaction still validates Entity/tool setup, installs required approval and
CLI bindings, authorizes the exact new Session, and submits the first input once.
The native UI and real model/CLI round trip remain separate acceptance evidence.
