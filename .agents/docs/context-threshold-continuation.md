# Context threshold and live continuation

This reference describes the intended Host integration of the optional
[Agent context v1](https://github.com/cordisx/cordisx-protocol/blob/be1e7fcb49c730c5806db6ca1925958804288674/.agents/docs/agent-context/README.md)
and [Channel Manager v14](https://github.com/cordisx/cordisx-protocol/blob/be1e7fcb49c730c5806db6ca1925958804288674/.agents/docs/channel-runtime/manager-v14-continuation.md)
contracts. Runtime availability depends on the active adapter and its evidence;
this page does not establish a released Host or real-App acceptance. The
[Channel CLI guide](channel-cli.md#fresh-channel-continuation) separately
describes the existing idle/send-boundary policy.

## Threshold and settings

Continuation is opt-in and disabled by default. When enabled, the profile
default ratio is 0.90; accepted ratios are finite, greater than zero, and at
most 0.95. The ratio applies to the effective native automatic compaction
threshold, not to the raw model window. For a 100K raw window, an 80K native
threshold, and a 0.50 ratio, the trigger amount is 40K tokens.

Channel presents the Host-owned form in its existing Settings navigation.
Profile defaults apply to new Channel sessions; an explicit session override
takes precedence, and clearing it restores inheritance. An unknown effective
budget, configuration or indeterminate override must not be guessed or
represented as a resolved threshold. A Host that cannot establish the needed
facts reports unavailable instead of triggering automatically.

## Context observation

Plugins can use the optional public `ctx.agentContext` service to read a
session snapshot or watch a threshold, subject to `agent.events.read` and the
exact Session grant. A `reported-snapshot` represents a native-reported context
measurement for a request; it can lag current activity and is not cumulative
billing usage. Its accounting scope and budget must be compatible. Stale or
unavailable measurements do not become threshold events. A notification is
best effort and cannot guarantee that it precedes native compaction.

## Target-ready handoff

For a supported live Channel continuation, the intended sequence is:

1. Create a fresh independent task while the source turn keeps working. The
   target reads bounded source history to prepare without executing the same
   business work.
2. Once the target reports ready, use the Host's independently authorized exact
   source-turn control. Confirm the old turn is terminal before handoff.
3. Catch up on source history added during preparation, move the eligible
   Channel bindings and queued work, and restore and verify the source task's
   execution settings before the target continues business work.

Preparation failure leaves the source task running. If interruption or another
native effect has an uncertain result, do not automatically repeat it; inspect
the reported state before further action. Exact-turn authority is distinct from
permission to read context, and an unsupported or unowned turn cannot be
interrupted through a context observation alone. The ordinary Desktop input
queue is not claimed to migrate with Channel jobs.

## Availability and evidence

The headless adapter's current-connection tools and Desktop next-owned startup
budget capture are under integration. A public type, a locally installed package,
or a settings tab does not by itself prove a resolved budget, an active Host
capability, a real threshold crossing, or successful takeover. Read the active
Host's capability and operation results; preserve unavailable states. An
installed CLI and the Host already running in an App window can also be
different versions, so installation and activation must be checked separately.
