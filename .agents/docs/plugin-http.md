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
entries; handles cannot resume after reload. Abrupt process termination may
prevent cleanup and is not represented as successful disposal. No captured
credential is returned by the public API. A trusted renderer plugin can still
inspect other renderer code; this service does not establish a general plugin
sandbox.

Verification uses real loopback HTTP transport with an injected test credential
backend. It exercises owner/origin enforcement, redirects, stream and body
limits, deadlines, abort, revocation and disposal. This is separate from native
Keychain consent and installed Codex runtime verification.
