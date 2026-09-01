# Natural-language development in a live CordisX session

Use this workflow only when the current Codex session was launched by
`cordisx dev` and `CORDISX_DEV_ENTRY` is present.

1. Read the exact entry with `printenv CORDISX_DEV_ENTRY`. It is an absolute,
   already-watched local-development entry. Never guess another path and never
   create a second launcher or watcher.
2. Inspect that file and the request. Keep its exported `name` equal to the
   entry basename because the phase-1 generation authority enforces that id.
3. Implement the request with `cordisx/contracts`, `ctx.commands`,
   `ctx.slots`, routes/pages, and other documented public services. Do not use
   Codex DOM selectors, raw DOM nodes, arbitrary HTML/CSS, renderer globals,
   or a private bridge.
4. Save the entry. The existing launcher observes the transitive build graph,
   stages an immutable candidate, publishes it through the generation
   transaction, and keeps last-good live if the build or activation fails.
   Do not restart Codex or CordisX to simulate reload.
5. Check the launcher's latest local-development diagnostic when it is visible.
   Report the exact entry changed and ask for the intended in-product click or
   navigation. Do not claim success from the file write alone.

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

The following is the maintained minimal pattern for the managed
`natural-language.ts` entry:

```ts
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
  if (control === undefined) {
    console.warn('[cordisx] celebration unavailable: control lease missing')
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
    const requestId = `natural-language:${Date.now().toString(36)}:${++nextRequest}`
    void control.invoke('presentCelebration', {
      requestId, activationId, effect: 'confetti', durationMs: 2400,
    }).then(result => {
      if (result.outcome !== 'accepted') {
        console.warn(`[cordisx] celebration rejected: ${result.reason}`)
      }
    })
  }
  ctx.effect(() => control.subscribe(consume), 'submit celebration subscription')
  consume()
}
```

Keep the existing entry name even when adapting this pattern. Stable downgrade
reasons include `celebration.unavailable`, `point.not-mounted`,
`authorization.denied`, `activation.stale`, `argument.out-of-range`,
`request.conflict`, and `presentation.failed`. Surface the reason; do not hide
it with a fake success or alternate presentation.

Every event subscription or timer not already owned by a returned CordisX
handle must be registered as a Cordis effect so plugin reload, generation
replacement, and runtime disposal remove it.
