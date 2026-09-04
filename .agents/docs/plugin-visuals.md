# Plugin visuals

Status: implemented in the renderer runtime; not released.

The public `ctx.visuals` service lets a trusted plugin register a small React
renderer for a bounded, Host-owned visual seat. It is useful for compact status
indicators, badges, sparklines, and similar decoration. The capability has no
built-in product renderer or product-specific role.

## Contract

A plugin imports React from `cordisx/react`, declares `inject = ['visuals']`,
and registers one local provider id:

```tsx
import type { Context } from '@deepseek-ai/cordis'
import * as React from 'cordisx/react'

export const inject = ['visuals']

export function apply(ctx: Context) {
  ctx.visuals.register<{ label: string; level: number }>(
    'service-status',
    ({ data, theme }) => (
      <span
        data-theme={theme}
        style={{ opacity: Math.max(0.4, Math.min(1, data.level)) }}
      >
        {data.label}
      </span>
    ),
  )
}
```

Provider ids use the public local-id grammar
`^[a-z0-9][a-z0-9._-]{0,95}$`. The Host resolves a provider only through the
exact owner attached to the source contribution. It never searches another
owner, parses an id to discover an owner, or loads a fallback implementation.

The renderer receives only `data` and `theme`. `data` is JSON-compatible,
detached from the Host value, and deeply frozen. Its meaning is opaque to the
Host. `theme` is the current `light` or `dark` Host projection. The renderer
receives no Cordis context, Host node, selector, command handle, navigation
handle, or event authority.

## Ownership and lifecycle

`register()` is owned by the calling Cordis fiber. Fiber disposal removes only
that exact registration and unmounts every live instance of it. Removing an
older generation cannot remove its replacement. Disposing the renderer runtime
removes the registry, subscriptions, and mounted provider subtrees.

The registry participates in the existing generation visibility transaction.
A candidate registration is invisible to active Host seats and produces no
live notification. One publication flip makes the candidate visible; rollback
restores the last-good generation. Provider identity never creates a second
package, activation, permission, or generation authority.

Each seat is decorative, inert, non-focusable, clipped to Host geometry, and
excluded from the accessibility tree. The Host continues to own labels,
controls, focus, routing, and layout. A render exception is caught at that seat,
which becomes blank without removing adjacent Host UI. Missing providers and
invalid projection data are also blank.

This remains trusted in-process code, not a sandbox. The framework-neutral data
semantics are defined by `@cordisx/protocol/visuals/v1`; React registration and
Host mounting are CordisX runtime behavior.

## Verification

Focused tests cover detached deep immutability, invalid data rejection, exact
owner isolation, theme changes, Cordis-fiber cleanup, duplicate registration,
candidate invisibility, single publication notification, rollback, stale
generation cleanup, missing providers, and render-failure containment.
