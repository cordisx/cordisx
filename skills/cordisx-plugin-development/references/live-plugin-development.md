# Live CordisX plugin development

Use this workflow when the current session is already attached to a CordisX
development project.

## Locate the active project

If `CORDISX_DEV_ENTRY` is set, read it with `printenv CORDISX_DEV_ENTRY` and use
that exact legacy single-plugin entry. Do not guess another entry or start a
second launcher or watcher.

For config-driven development, prefer an explicit `--config` from the running
command. Otherwise walk upward from the current directory; the nearest project
wins, and within each directory prefer `.cordisx/config.json` over the
compatible `cordisx.config.json`. Resolve every plugin entry relative to that config file.
Treat `plugins[]` as the authoritative enabled-entry set; there is no separate
multi-entry environment variable.

Inspect the selected plugin entry, its nearest package and tsconfig boundary,
the project config, available README files, tests, and the request. In an
embedded project, plugin code belongs under `.cordisx/plugins/<id>` and CordisX
dependencies belong to the `.cordisx` package boundary, even when a workspace
manager links them through the business project's root lockfile.

## Implement and observe

Use public CordisX services and structured Host surfaces. Keep plugin ids equal
to their config ids, and keep product effects under the owning Cordis lifecycle.

Run the project's normal check. Saving a refresh-compatible React component
module uses Vite React Fast Refresh. Changes to the plugin entry, manifest,
`apply`, or another non-refresh boundary may stage and replace that plugin's
generation. Check the in-product result and cleanup; do not claim success from a
file write alone.

The Manager's **Reload plugin** action is a second development trigger for an
active local plugin. Use it when the task needs an explicit reload check. It
invalidates and reloads that selected development module; it does not make
install, enable, disable, or uninstall available for unmanaged local entries.

Restart `cordisx dev` only for changes outside the renderer HMR contract, such
as project config, package installation, or Node-side launcher/bridge code.
When the running session shows a failed candidate, preserve and inspect the
last-good plugin instead of repeatedly restarting over the diagnostic.

For native behavior, verify the actual isolated `app://` App launched by
CordisX. A Playground or browser harness is useful supporting evidence only
when it exposes the same public capability.

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
