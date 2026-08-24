# CordisX Channel Runtime

Launcher-side, host-neutral Channel core and local simulator. This package is
private while the Node service loader, production store, manager projection,
and real platform adapters are still being delivered.

## Status

| Area | Status | Evidence or boundary |
| --- | --- | --- |
| Channel identity, sourced input, binding, snapshot, and manifest v2 | implemented | `cordisx-protocol` main `643b0a35a407c452193d715fe45a98a3c252a399` |
| Host-neutral task gateway, JSON durable store, inbox/outbox, retry, binding, audit, generation fencing, and last-good activation | implemented | this package |
| Local simulator create/query/open/continue/followup/steer/interrupt/archive/restore | verified | `tests/channel-runtime.integration.test.ts` |
| Duplicate event, restart recovery, retry/backoff, permission denial, descriptor redaction, and generation disposal | verified | `tests/channel-runtime.integration.test.ts` |
| Completion/failure/approval/reply outbox delivery handles | implemented; completion/reply verified | automated Agent notification subscription and approval resolution remain planned |
| Node Cordis `channel` service connection list, sourced-message subscription, and queued send | verified | source-bound service integration test |
| Cross-plugin subscription across launcher restart | experimental | current subscription is explicitly `live-experimental`; durable consumer checkpoints are not implemented |
| Launcher manifest-v2 module loader and production policy/secret/store adapters | planned | no package entry is loaded by the launcher yet |
| Manager Settings Tab and session header projection | planned | renderer receives no Channel runtime object |
| Feishu/Lark, WeCom, and WeChat Service Account adapters | planned | no credential, developer app, public webhook, or deployment is claimed |
| Personal WeChat client automation | unavailable | reverse-engineered clients and unauthorized hooks are excluded |

`implemented` does not imply `verified`. Real platform behavior remains
unavailable until a named official adapter and credentialed smoke land.

## Runtime boundary

The core receives four narrow authorities:

- `ChannelTaskGateway`: the only path to CordisX Platform/Agent task methods;
- `ChannelPermissionBroker`: source-, plugin-, generation-, capability-, and
  target-aware `ask`/`allow`/`deny` decisions;
- `JsonChannelStore`: a single-process, atomic-replacement simulator/core store;
  and
- `ChannelAdapterDefinition`: transport-specific start/send/stop lifecycle.

It receives no renderer, DOM, CDP session, raw bridge, generic app-server RPC,
provider process, or secret value. Adapter descriptors are copied through a
closed allowlist before persistence. Remote ingress is manually validated as a
closed `cordisx.channel-user-input/v1` contract and can only use `role=user`.
Attachments contain opaque quarantine handles, never URLs or local paths.

The JSON store fsyncs an atomic replacement and its parent directory for each
transaction. It is intentionally a phase-one, single-launcher implementation,
not a claim of multi-process database coordination. A production store adapter
must preserve the same transaction, replay, lease, and generation contracts.

## Cordis plugin composition

The Host registers `CordisXChannelService` as `ctx.channel` in the Node Cordis
root. Launcher-created plugin child contexts carry canonical package source,
plugin id, and generation metadata. The service derives that identity from the
requesting Context; a caller cannot pass it as an API argument.

```ts
export const inject = ['channel']

export async function apply(ctx: Context) {
  const accounts = await ctx.channel.connections.list()
  const dispose = await ctx.channel.messages.subscribe(
    { account: accounts[0].ref },
    event => console.log(event.input.source.event.eventId),
  )
  ctx.effect(() => dispose)

  await ctx.channel.messages.send({
    target,
    kind: 'reply',
    text: 'Queued through the durable outbox',
  })
}
```

The API exposes redacted connection snapshots, sourced normalized input, and
delivery handles. It never exposes the adapter connection. Adapter plugins use
`ctx.channel.adapters.register(definition)`; the registration and consumer
subscriptions are Cordis effects tied to their owning fiber.

Permissions remain separate:

- `channel.accounts.connect`: contribute/start an adapter connection;
- `channel.events.receive`: adapter-side durable platform ingress;
- `channel.accounts.read`: consumer-side redacted discovery;
- `channel.events.subscribe`: consumer-side sourced message events; and
- `channel.messages.send`: enqueue an external message.

The core rechecks send permission before claim. A delivery is cancellable while
queued/retrying. Once claimed, the result is honestly `irreversible` unless the
adapter returns a supported recall handle.

## Reliability

The runtime promises at-least-once processing plus idempotency, never
exactly-once:

- inbound uniqueness is `(adapterId, accountId, eventId)`;
- a duplicate with different normalized content fails integrity validation;
- a gateway operation receives a stable `operationId` and must be idempotent;
- expired inbox/outbox claims are recovered after restart;
- retry uses bounded exponential backoff and a terminal dead letter;
- replacement prevents the old generation from claiming work;
- a failed candidate retains the current last-good generation; and
- audit projections include caller source/plugin/generation, capability,
  complete Platform target, binding revision, event key, and outcome, without
  message content.

The cross-plugin message subscription currently runs only in process after
durable ingress acceptance. It is intentionally labeled `live-experimental`:
handler failures are isolated, but consumer cursor/ack/replay across restart is
planned.

## Simulator

`./simulator` exports a manual clock, permission broker, idempotent task
gateway, simulated adapter, and sourced input fixtures. It requires no external
account, secret, public callback, or network.

Run the isolated suite:

```sh
npm test -- --run tests/channel-runtime.integration.test.ts
```

Run the owning repository gate before delivery:

```sh
npm run check
```

The full architectural contract, official platform feasibility, UI plan, PR
boundaries, and validation matrix are in
`.agents/docs/channel-runtime.md`.
