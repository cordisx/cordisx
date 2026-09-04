import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from 'cordisx/contracts'

type Messages = {
  'plugin.name': undefined
  'command.observe-submit': undefined
}

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
    namespace: 'send-confetti',
    locale: 'en',
    default: true,
    messages: {
      'plugin.name': 'Send Confetti',
      'command.observe-submit': 'Celebrate after sending',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'send-confetti',
    locale: 'zh-CN',
    messages: {
      'plugin.name': '发送礼花',
      'command.observe-submit': '发送后播放礼花',
    },
  })
  const title = { key: 'command.observe-submit', fallback: 'Celebrate after sending' }
  ctx.commands.register({ id: 'celebration-proxy', title }, () => undefined)
  const contribution = ctx.slots.register({
    name: 'composer.toolbar.items',
    id: 'submit-celebration',
    control: {
      claimId: 'submit-celebration',
      mode: 'proxy',
      priority: 100,
      requestedBindings: {
        properties: ['celebrationProfile'],
        events: ['submitActivated'],
        commands: ['presentCelebration', 'dismissCelebration'],
      },
    },
  }, {
    anchor: 'submit',
    placement: 'before',
    label: title,
    ariaLabel: title,
    icon: 'host:info',
    command: { id: 'celebration-proxy' },
  })
  const control = contribution.control
  if (control === undefined) return
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
    })
  }
  ctx.effect(() => control.subscribe(consume), 'submit celebration subscription')
  consume()
}
