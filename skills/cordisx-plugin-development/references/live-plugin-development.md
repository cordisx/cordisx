# Live development in a scaffolded CordisX plugin

Use this workflow only when the current Codex session was launched by
`cordisx dev <entry>` and `CORDISX_DEV_ENTRY` is present.

1. Read the exact entry with `printenv CORDISX_DEV_ENTRY`. It is an absolute,
   already-watched entry inside a CLI-created plugin project. Never guess a
   second path and never create another project, launcher, or watcher.
2. Inspect the entry, its `package.json`, README, tests, and the request. Keep
   the exported manifest id equal to the entry basename because local
   development derives the runtime identity from that basename.
3. Preserve the independent project boundary: product name, description,
   localization, version, license choice, tests, and package metadata belong
   to this plugin rather than to a shared scratch file.
4. Implement the request with `cordisx/contracts`, `ctx.commands`, `ctx.slots`,
   routes/pages, and other documented public services. Do not use Codex DOM
   selectors, raw DOM nodes, arbitrary HTML/CSS, renderer globals, or a private
   bridge.
5. Run the project's normal check command. Saving the watched entry lets the
   existing launcher stage and publish an immutable replacement generation
   while retaining last-good on failure. Do not restart CordisX to simulate
   reload.
6. Check the latest local-development diagnostic when it is visible. Report
   the exact plugin project changed and ask for the intended in-product click
   or navigation. Do not claim success from the file write alone.

For a native Host interaction, use only a cataloged Host-projected safe event
on a controlled contribution. For a visual effect, update only a cataloged
Host-owned structured presentation. If either contract is unavailable in the
installed CordisX version, say so plainly instead of installing a selector or
DOM fallback.

## Native submit celebration profile

For a request such as “make the send button show full-screen confetti when it
is clicked,” consume the exact
`cordisx.composer-submit-celebration/v1` profile. Register one explicit
`proxy` claim on `composer.toolbar.items`; the Host does not render that proxy
contribution as a second toolbar button. Request only:

- property `celebrationProfile`;
- event `submitActivated`; and
- commands `presentCelebration` and `dismissCelebration`.

The Host emits an opaque, one-use `activationId` only after an accepted native
submit activation. Invoke `presentCelebration` with a unique `requestId`, that
activation id, `effect: 'confetti'`, and an integer `durationMs` from 250 to
5000. Treat only `outcome: 'accepted'` as success. Never add a DOM listener,
selector, canvas, stylesheet, timeout, or presentation node in the plugin.

For the `send-confetti` scaffold, the maintained minimal implementation is:

```ts
import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from 'cordisx/contracts'

type Messages = { 'command.observe-submit': undefined }

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'send-confetti',
  name: 'Send Confetti',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export const inject = ['commands', 'i18n', 'slots']

export function apply(ctx: Context): void {
  ctx.i18n.define<Messages>({
    namespace: 'send-confetti', locale: 'en', default: true,
    messages: { 'command.observe-submit': 'Celebrate after sending' },
  })
  ctx.i18n.define<Messages>({
    namespace: 'send-confetti', locale: 'zh-CN',
    messages: { 'command.observe-submit': '发送后播放礼花' },
  })
  const title = { key: 'command.observe-submit', fallback: 'Celebrate after sending' }
  ctx.commands.register({ id: 'celebration-proxy', title }, () => undefined)
  const contribution = ctx.slots.register({
    name: 'composer.toolbar.items',
    id: 'submit-celebration',
    control: {
      claimId: 'submit-celebration', mode: 'proxy', priority: 100,
      requestedBindings: {
        properties: ['celebrationProfile'],
        events: ['submitActivated'],
        commands: ['presentCelebration', 'dismissCelebration'],
      },
    },
  }, {
    anchor: 'submit', placement: 'before', label: title, ariaLabel: title,
    icon: 'host:info', command: { id: 'celebration-proxy' },
  })
  const control = contribution.control
  if (control === undefined) {
    console.warn('[send-confetti] celebration unavailable: control lease missing')
    return
  }
  let lastEvent = 0
  let nextRequest = 0
  const consume = (): void => {
    const snapshot = control.snapshot()
    if (snapshot.state !== 'selected'
      || snapshot.properties.celebrationProfile !== 'cordisx.composer-submit-celebration/v1') return
    const event = snapshot.events.find(item => item.id === 'submitActivated')
    if (event === undefined || event.sequence <= lastEvent) return
    lastEvent = event.sequence
    const activationId = event.payload.activationId
    if (typeof activationId !== 'string') return
    const requestId = `send-confetti:${Date.now().toString(36)}:${++nextRequest}`
    void control.invoke('presentCelebration', {
      requestId, activationId, effect: 'confetti', durationMs: 2400,
    }).then(result => {
      if (result.outcome !== 'accepted') {
        console.warn(`[send-confetti] celebration rejected: ${result.reason}`)
      }
    })
  }
  ctx.effect(() => control.subscribe(consume), 'submit celebration subscription')
  consume()
}
```

Adapt ids and copy only when the scaffold has a different product identity.
Keep the entry basename and manifest id aligned, preserve the README and
project checks, and do not introduce a generic development identity.

Stable downgrade reasons include `celebration.unavailable`,
`point.not-mounted`, `authorization.denied`, `activation.stale`,
`argument.out-of-range`, `request.conflict`, and `presentation.failed`.
Surface the reason; do not hide it with a fake success or alternate
presentation.

Every event subscription or timer not already owned by a returned CordisX
handle must be registered as a Cordis effect so plugin reload, generation
replacement, and runtime disposal remove it.
