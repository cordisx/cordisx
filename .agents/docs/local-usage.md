# Local usage projection

The Host implements the Protocol [local usage v1 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/usage-v1.md)
through `ctx.usage`. A manifest/package v11 declaration requests `usage.read` for
`{ profile: 'current' }`. This grants metadata-only input/output aggregates; it
does not grant message history, raw session files, account billing or native
commands. Permission is explicit and scoped to the current plugin generation.

Read immediately after activation and subscribe for invalidation hints. The Host
emits hints on permission changes and every five seconds while authorized.
Actual rollout scans share a 30-second cooldown through the committed SQLite
snapshot; hints and repeated reads during that interval reuse the last confirmed
projection, including across windows and Launcher processes.
Consumers coalesce reads, baseline the first accounting namespace, and atomically
persist their business update with the last revision/aggregate. Identical reads
and hints are not transactions. Reward rates and pet inventory belong in plugins.

The Launcher scans the current Codex home's `sessions` and `archived_sessions`
rollouts. First observation of each source establishes a baseline. Validated
append records contribute input plus output once; cache/reasoning subsets are
not added again. Unsupported forks, missing intervals and synthetic counters are
excluded. Owner identity deduplicates archive copies. Prefix hashes fence
rewrites; shorter aliases do not move checkpoints backwards, and conflicting
sources are quarantined. Coverage always reports partial.

SQLite stores the namespace, aggregates and metadata-only checkpoints in one
transaction under the Host profile's cache directory. Compare-and-swap sequence
checks prevent separate Launcher processes from committing the same increment.
Corrupt storage returns unavailable. Profile or Codex-home changes select a new
namespace; reinstalling the same plugin does not reset the Host aggregate.
Development and release profiles may have different namespaces.

Scans are bounded to 20,000 sources, 64 MiB per rollout, 256 MiB per observation
and a cooperative five-second budget. Deferred sources resume in later reads.
An oversized or unsupported source remains excluded; no historical estimate is
substituted. This is local observed usage, not authoritative cross-device or
account-wide billing. The service is unavailable without the Launcher bridge.

Implementation owners: `launcher/local-usage.ts` (durable projection),
`launcher/usage-reducer.ts` (metadata semantics), `renderer/usage.ts` (bound public
service), and `renderer/platform/platform-usage-permission.ts` (generation leases).
