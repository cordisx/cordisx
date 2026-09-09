# Local development permissions

`cordisx dev` treats the selected local plugin as developer-controlled code.
Every declared Host permission defaults to allowed, including sensitive runtime
operations. Permission dialogs do not block initial activation, UI admission, or
hot replacement. Manager labels this state **Allowed for development** / **开发模式已授权**.
No opt-in permission flag or per-plugin grant script is required.

## Source and lifetime

The Host accepts only the Launcher-verified local development artifact: matching
plugin id, ready build, source path, local development identity, and artifact
or package generation. A file URL, matching plugin name, or manifest assertion
alone does not establish development authority.

`createRuntimeRegisterController` binds this provenance to the permission
registration before registering extension points or mounting services. Initial
bootstrap and candidate generations use the same entry point. The broker's
shared `developmentPermission` predicate checks both the live registration and
the declared capability. Each capability adapter still validates its own scope.

A successful hot replacement gets a new registration and its current declared
scopes, including newly added permissions. The retired generation loses its
leases. A rejected candidate is disposed without changing the active generation.
An installed replacement never inherits development authority, even if it reuses
the plugin id and source. No development allow is written to the profile's user
permission records, and no synthetic explicit-user decision is created.

## Coverage and boundaries

The default covers platform calls, controlled UI contributions, supported visual
interaction, local usage, Host DOM authorization, and exact Agent/Session leases.
It applies after scope validation; undeclared operations and out-of-scope roots,
points, providers or sessions do not become available. Runtime-exact declarations
still materialize and validate their concrete request before authorization.

Explicit denials remain effective. Reset a stored denial through Manager when
resuming development; per-generation usage and interaction denials retire with
their generation. Existing blocked/disabled-plugin state also remains effective.

Development authorization does not manufacture missing providers, broaden the
public plugin API, grant operating-system device permissions, or change Codex
agent-tool execution policy. General local plugins remain trusted renderer code;
this default is not a sandbox guarantee. Isolated Host DOM authorization can be
tested at the broker boundary, but the current renderer development transport
does not add support for loading isolated Host DOM plugins.

Installed and marketplace packages retain their normal review and persistence
rules. Internal Manager snapshots report the effective development origin;
versioned user authorization plans and stored user policies remain unchanged.

## Verification

The regression suites cover initial point admission, sensitive calls, exact
scope rejection, HMR scope changes, installed replacements, retired leases,
explicit denials, no persistent writes, and the Launcher bundle through renderer
candidate composition. Existing installed
permission, usage, visual, Agent and Host DOM suites must remain green.
A production-native claim additionally requires the isolated `app://` path;
JSDOM composition evidence alone does not establish native verification.
