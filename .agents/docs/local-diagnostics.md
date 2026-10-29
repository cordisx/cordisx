# Local diagnostic journal

CordisX records metadata through its existing launcher, native resource, managed-service,
HTTP authority and native app-server intermediary paths. It does not open an additional
connection or intercept another process to collect diagnostics.

The default location is `CORDISX_HOME/diagnostics/<app hash>/<profile hash>/`.
Every process writes its own private JSONL shard. `runId` identifies that process's run;
`launchId` joins a background CLI invocation to its supervisor. Runtime and service
generations fence resource ownership. Records include wall time and monotonic elapsed
time, CordisX version, discovered Host version (or `unknown`), phase/deadline transitions,
resource validation/injection/acknowledgement, cancellation, service ownership/health/exit
and cleanup. Service health logs retain changes and errors rather than every successful poll.

The automatic cold-launch work budget is 180 seconds, independent of service startup,
CDP injection, shutdown and integrity checks. An explicit user retry starts a fresh
bounded attempt. A verified live recovery window pauses active work time while waiting
for the user; a stale heartbeat or ordinary retry-progress heartbeat cannot renew the budget. A deadline is recorded
before generation-fenced cancellation. Cancellation observations do not establish why a
resource was originally late; use the preceding stage/resource events.

Native turn diagnostics observe queue, dispatch, acceptance, first correlated native event,
completion/failure and cancellation. Provider/model identifiers may be `unknown` when the
native frames do not publish a selection. First native event is not first model token.
Native upstream DNS/TLS, HTTP status and network queue timing are unsupported unless the
existing Host path exposes them. HTTP authority requests record status and safe OS error
codes, but cannot reliably identify the model inside an opaque request body. Logs do not
promise to identify every external failure's cause.

Native startup records distinguish initialization, Desktop input EOF, actual child exit,
and control authentication/closure. Opaque invocation/peer references and source/child PIDs
join these observations. Fixed metadata on the existing stderr path retains the first
closing stage and initialization/exit snapshot when the control connection is already
closing. An exit code of zero alone does not prove initialization succeeded. Ordinary
CLI calls, including version/help probes, startup configuration checks and schema tooling,
pass through to the real CLI without
reserving the app-server's single private control connection.

## Retention and bounds

Maintenance runs at startup, every minute while running, and on normal close. Shards seal
at 8 MiB or one hour and compress to gzip through an exclusive atomic publication. Live
process shards are never compressed by another process. After a crash, a shard whose PID
is no longer alive is recoverable on the next maintenance run. PID reuse conservatively
defers compression. Uncompressed active shards remain readable. Each profile has its own
directory; concurrent writers publish distinct shards and never truncate another writer.

Retention is at least 72 hours from the shard's final write, including compressed shards.
The normal disk budget is 512 MiB per profile, with 16 MiB reserved for failure/cancellation/
cleanup records. A bounded 1 MiB in-memory queue protects the main operation from a slow
log destination. Concurrent writers remeasure shared usage every minute, so the disk
budget is a soft boundary and can overshoot between scans. No recent shard is deleted to
satisfy it. When space/queue/write limits prevent collection, diagnostics degrade explicitly:
a fixed `diagnostic-evidence-gap` warning, a small best-effort gap marker and a dropped-event
count on the next successful write. A completely full/unwritable disk can also prevent the
marker; logging failure never changes the main request outcome. Repair disk access to
resume collection. Abandoned compression temporaries and gap markers expire after 72 hours.

`cordisx logs` reads a bounded recent journal projection (512 KiB); `--follow` follows new
records. Older installations' `host.log` remains a legacy fallback and is not extended by
new detached launches, avoiding persistence of arbitrary stdout, application output or
plugin text. The structured journal is the durable source for new launches.

`cordisx feedback collect --since 3d` reads plain and compressed journal shards and applies
the selected time range. `--launch <launchId>` filters structured records. Feedback export
retains its byte/event bounds, reports truncation/unreadable evidence, re-applies redaction,
and can still include a bounded legacy log excerpt. A legacy excerpt has only partial
correlation and does not acquire a time guarantee from the new journal.

## Privacy

Directories use mode 0700 and shards/archives use mode 0600. A fixed field allowlist excludes
request/response bodies, conversation text, prompts, raw errors/stacks, auth/cookies/headers,
tokens, secret configuration and arbitrary environment variables. Correlation for threads,
turns, resources, plugins and services uses opaque hashes. Provider/model names are bounded
identifiers; unsupported values become unknown or are omitted. Do not paste private local
journals into a public issue or PR; review and export a redacted feedback bundle first.
