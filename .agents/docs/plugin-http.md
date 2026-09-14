# Plugin HTTP Host implementation

Public authority: [Protocol HTTP v1](https://github.com/cordisx/cordisx-protocol/blob/codex/game-platform-capabilities/.agents/docs/plugin-http/README.md).

`ctx.http` is scoped to a plugin owner and module generation. Host consent shows
an exact origin and captures a bearer token in a masked field. The launcher
stores it in macOS Keychain and injects it only for the bound origin. This
extends the public plugin context; Channel private credentials are separate.
HTTP bearer origins require HTTPS except exact localhost, 127.0.0.1 and ::1.

An unauthenticated connection skips the consent prompt only when its canonical
origin is an exact URL leaf in that plugin generation's raw user or project
configuration. Resolved schema defaults, URLs with paths, other plugin
configuration and unconfigured origins do not grant this authority. Bearer
connections always use the Host consent surface.

Requests use a relative path, three allowed headers, a 1 MiB UTF-8 body and
response bound, manual redirect refusal and a 30-second maximum transport
lifetime. Browser cancellation reaches the launcher transport. Retirement,
revocation and disposal abort pending requests and remove transient Keychain
entries; old handles cannot resume after reload. Explicit v2 sessions use a new live grant. Abrupt process termination may
prevent cleanup and is not represented as successful disposal. No captured
credential is returned by the public API. A trusted renderer plugin can still
inspect other renderer code; this service does not establish a general plugin
sandbox.

Verification uses real loopback HTTP transport with an injected test credential
backend. It exercises owner/origin enforcement, redirects, stream and body
limits, deadlines, abort, revocation and disposal. This is separate from native
Keychain consent and installed Codex runtime verification.

Each renderer HTTP client has a private transport lifetime. Its disposal or
transient connection revocation cannot close another live renderer client's
grants for the same plugin owner and module generation. The marker stays inside
the Host bridge; plugins receive no renderer or target identity. Canonical owner
documents, trust and retained session partitions are unchanged. Observed Native
account changes still retire the matching owner grants. Explicit retained
session logout continues to remove its shared credential revision.

Manager plugin Logs and diagnostics identify a client ownership rejection before
launcher dispatch separately from a launcher `connection-unavailable` reply.
Each distinction is recorded once per client lifetime. Normal launcher output
also records HTTP retirement reasons with hashed transport and connection tags.
It does not include Native account identity, target ID, bearer values, owner
tokens or raw connection handles. These passive records establish a cleanup
branch when observed; a public unavailable summary alone does not identify the
branch. The new launcher and renderer implementation requires normal SDK
assembly, rather than page-only HMR.

## Explicit session retention (v2)

`ctx.http` now advertises `cordisx.http-client/v2`; the normative successor is
[Protocol HTTP v2](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/plugin-http/v2.md).
The launcher reuses its system Keychain backend. `retain` explicitly copies an
existing bearer into a stable session partition; `resume` returns a fresh live
grant to that same bearer; `forget` removes the partition. Ordinary exchange
grants remain transient. Runtime disposal removes transient grant copies while
preserving only explicitly retained credentials. Explicit revoke removes the
matching retained revision, so a stale handle cannot delete a replacement.

The partition includes Host profile, Native account identity, requesting plugin
source and ID, exact origin, and plugin source/account labels. Account facts
come from launcher-driven CDP evaluation in the calling Native context using
the same exact audited pins as current-user. The lookup only reads account-info;
profile-image or profile-endpoint readiness is irrelevant. RPC callers cannot
supply an account identity. Unknown builds, signed-out sources and unavailable
secure storage fail closed. Retained requests verify account before transport
and before returning success. Host account changes leave prior-account sessions
isolated and retire their runtime grants; they do not synthesize remote identity.

For the audited typed Native input, Host releases the individual account-read
RPC invocation on caller abort and after settlement. It does not dispose the
shared input service. A retained Native grant validates both account pins using
one fresh read at each request checkpoint: before secret retrieval, before
transport, and before accepting the complete response. Account observations are
never reused across these asynchronous phases; conflicting or changed pins
fail closed.

Launcher HTTP account reads allow five seconds for the fresh Native input, inside
six-second evaluation and 6.5-second CDP response budgets. These bounded waits
accommodate deferred delivery in hidden windows; they do not reuse an earlier
identity. A real timeout still retires Native-bound grants and work continuity.
After the Native input recovers, consumers can open a fresh account connection
or restore its retained session; retired handles and late read results remain
invalid. Current-user uses the same pinned input reader with its separate
ten-second caller budget.

Consumers validate restored sessions through the server's ordinary session
endpoint, forget on confirmed invalid-session/expiry, and perform remote logout
plus local forget on active exit. Transport failure must preserve the session.
The v2 launcher/CDP authority cannot be upgraded by renderer HMR alone: a normal
launcher maintenance boundary is required once for this implementation. Real
Native/Keychain verification remains separate from injected-backend tests.

Normal Native-account observation diagnostics also report a bounded unavailable
phase with the same one-way client tag. The launcher distinguishes a closed or
missing calling context, CDP timeout/exception, exact pin/module readiness,
typed identity/connection/retired state and typed read failure. Raw Native
status messages, identifiers and error payloads are never logged. Each phase is
reported once per client. A closed, missing, destroyed or rejected calling context
fails that caller closed and retires its own Native-bound grants; it is not an
observation of the owner's Native identity and cannot invalidate healthy peers.
Each healthy grant still reads the real Native identity at its existing fences.
Real Native unavailable results and identity changes retain owner invalidation.
These private distinctions do not retry authentication, reuse cached identity
or select another target. A typed identity unavailable
result is not proof that the user explicitly signed out.

Invalid-request diagnostics identify fixed Host rejection branches, including
operation-id shape/duplication, the unchanged eight-request grant limit, request
schema checks and the outer authority exception path. They use existing trusted
client/connection tags and report each branch once per client. Pre-client malformed
requests still fail closed without creating a client solely for diagnostics.
No request/error payload, path, headers, in-flight count or private Native state is
logged. Public failure codes, concurrency limits and credential fences are unchanged.
