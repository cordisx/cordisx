# Plugin dialogs

Experimental implementation on the shared-dialogs candidate. The
[Protocol contract](https://github.com/cordisx/cordisx-protocol/blob/88a08f1b20ab89f33b5ebd0a4791b80dd8271658/.agents/docs/dialogs-v1.md)
is an experimental provider commit pending merge. Require `dialogs` in plugin injection and a compatible Host.
Do not recreate a modal with fixed-position plugin markup or import TDesign.

## Full JSX bodies

```tsx
import { useState } from 'cordisx/react'
import { Button, Dialog, DialogProvider } from 'cordisx/ui'

// Capture ctx.dialogs during activation and pass it to your page component.
function Page({ dialogs }) {
  const [open, setOpen] = useState(false)
  return (
    <DialogProvider service={dialogs}>
      <Button onClick={() => setOpen(true)}>Room details</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Room details"
        size="large"
        headerActions={[{
          id: 'share',
          label: 'Share',
          icon: 'share',
          onAction: shareRoom,
        }]}
        footer={{
          primaryAction: { id: 'join', label: 'Join room', onAction: joinRoom },
        }}
      >
        <RoomOverview />
        <PlayerSelector />
        <GamePreview />
      </Dialog>
    </DialogProvider>
  )
}
```

The declarative body preserves the surrounding React context and component
state. Async data, hooks, editors, uploads, lists, previews and multistep flows
belong here. Host Suspense and an error boundary keep close controls available.
`useDialog()` inside the body returns its lifetime signal and handle. Setting
`open=false` or unmounting forcibly disposes the surface; use the handle's close
method for a vetoable close request. Keep unsaved-state checks in `beforeClose`.
Task cancellation and stopping a remote operation are separate responsibilities.

The title and description are strings. Header actions are descriptors (up to
eight); two render directly and the rest use More. The rightmost close icon is
always Host-rendered. Footer supports status, up to three secondary actions and
one primary action. No JSX footer/header, arbitrary styles, class names or
replacement close controls are accepted. The body supports `scroll` (default)
or `fill` layout and small/medium/large viewport-bounded sizes.

## Commands and notifications opening complex views

```tsx
import { defineDialog } from 'cordisx/ui'
export const inject = ['dialogs', 'notifications']
export function apply(ctx) {
  const unregister = ctx.dialogs.register(
    'room-details',
    defineDialog(RoomDetails),
  )
  ctx.effect(() => unregister)
  // In a user-triggered action:
  const handle = ctx.dialogs.open({
    kind: 'room.details',
    instanceKey: roomId,
    title: 'Room details',
    content: { id: 'room-details', props: { roomId } },
  })
}
```

A registered component receives `{ props, dialog, signal }`. It has an independent
React root: explicitly supply business providers; it cannot inherit context from
the command's caller. Mounting adapters receive only the body DOM seat. Unregister
and plugin retirement dispose matching views and settle their results.

Use `confirm({ kind, title, confirmLabel, run })` for standard confirmations and
`form({ kind, title, fields, submitLabel, submit })` for small string/number/
boolean drafts. Form fields reuse HostDraftFields. Rich schema-driven workflows
continue to use existing configuration semantics or a JSX body. One explicit
same-owner `parent` handle permits a child confirmation (for example discard
unsaved changes); ordinary open requests queue.

Operation failures use the existing owner-bound notification viewport, moved
inside the active modal while necessary so native inertness cannot hide it.
Do not toast every polling failure or duplicate durable object state.

## Implementation and limits

`renderer/dialogs/model.ts` owns bindings and results; `host.tsx` mounts shadow
chrome and light-DOM body seats; `view.tsx` owns frame and actions; `react.tsx`
provides context-preserving JSX and registration adapters. Chrome CSS lives in
one module copied to the production artifact. Host theme projection supplies
semantic tokens. Native `<dialog>` handles modal focus and background inertness.

The closed shadow root prevents ordinary plugin selectors from restyling header
or footer. Light-DOM body seats preserve existing plugin styles. This is style
isolation, not a security sandbox for hostile trusted renderer JavaScript.
Host HoverCard follows the dialog body portal context. Third-party overlays must
use a container within the body; portals to document.body are outside the modal.

Existing object-array editors and marketplace source editors adopt the shared
frame. Permission authorization remains a separate privileged surface; this API
does not confer consent or permission authority.

See the [candidate ledger](history/dialogs-candidate-2026-09-10.md) for actual
verification and merge status. Protocol checks, model tests and browser harness
checks each have distinct scope; none alone proves native app delivery.
