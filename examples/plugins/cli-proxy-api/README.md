# CLIProxy Providers

Trusted-local CordisX plugin for managing models and sessions from launcher-configured CLIProxyAPI gateways.

The plugin calls only the permission-brokered `ctx.platform` API. Provider credentials, Codex App Server processes,
raw JSONL messages, and adapter cursors remain in the launcher process. Every model and session uses a composite
provider identity, so identical remote ids from different gateways do not collide.
