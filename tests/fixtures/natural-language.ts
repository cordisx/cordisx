import type { Context } from '@deepseek-ai/cordis'

export const name = 'natural-language'
export const inject = ['commands', 'slots']

export function apply(ctx: Context): void {
  const title = { key: 'submit-celebration', fallback: 'Send celebration observer' }
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
    const requestId = `natural-language:${Date.now().toString(36)}:${++nextRequest}`
    void control.invoke('presentCelebration', {
      requestId, activationId, effect: 'confetti', durationMs: 2400,
    })
  }
  ctx.effect(() => control.subscribe(consume), 'submit celebration subscription')
  consume()
}
