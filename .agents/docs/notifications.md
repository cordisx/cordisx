# Plugin notifications

Use `ctx.notifications.show()` for operation success, information, warnings and
errors. Host owns the card, plugin identity, source navigation, optional action,
close/details controls, timers, queue and user suppression rules. The
[Protocol v1 contract](https://github.com/cordisx/cordisx-protocol/blob/dfa2c5fa956184df11a97955b8e5c74a76cb8876/.agents/docs/notifications-v1.md)
is the authority for ownership and compatibility. This implementation is a
feature-branch candidate until the provider and Host revisions are merged.

```ts
export const inject = ['notifications']
function reportConnectionFailure(ctx: Context) {
  // Called from the failed connection operation after activation.
  ctx.notifications.show({
    kind: 'connection.failed',
    type: 'error',
    message: '连接失败',
    description: '暂时无法连接来源，请稍后重试。',
    action: { label: '重试', run: signal => reconnect(signal) },
  })
}
```

Show notifications after activation, in response to a real operation or state
transition. Localize message, description and action label with the plugin's
existing i18n service. Never put a request ID, account, translated sentence or
raw exception text into `kind`. A stable semantic kind lets a user mute that
category even when its copy changes. Source name/icon are taken from Host
plugin metadata; notification callers cannot impersonate another plugin.

## Card behavior

Cards appear at the bottom right without changing page layout or taking focus.
The header contains the plugin icon/name, More and Close. Source navigation
opens an authorized parameter-free entry when available and does not dismiss
the notice. If no such entry exists, source identity is plain text. Body text is
selectable, not an implicit button. Optional details expand and can be copied.
One optional action displays a busy state; success dismisses the card, failure
keeps it available to retry. The plugin owns safe retry semantics.

Three cards may be visible. Each owner has a queue ceiling of 20; the renderer
ceiling is 100. Same-owner/kind messages coalesce and show a repeat count. The latest descriptor
replaces message and action; all handles for that group dismiss the same card.
Use category-level recovery actions when several business objects share a kind,
not a last-object retry that could misrepresent earlier failures. A notification
arriving while the previous action is running creates a separate card so the old
action cannot dismiss a newer failure.
Success/info/warning last 3/4/6 seconds; errors remain. Hover, focus, expanded
details, actions and a backgrounded document pause expiration. Reduced-motion
preferences disable arrival motion. Unloading a plugin removes its cards and
aborts outstanding action signals.

## User notification rules

More offers mute this kind, pause this plugin for one hour or until local
midnight, mute the whole plugin, and manage rules. Applying a rule removes all
matching visible/queued cards and suppresses later submissions. An undo receipt
lasts ten seconds. Restoring a rule enables future notices without replaying
old content. Host Manager navigation also exposes Notification rules so a fully
muted plugin never prevents the user from restoring notifications.

Rules are stored by profile in Host renderer local storage, keyed by stable
plugin source/id plus optional kind, with expiry for pauses. Only rules persist;
message bodies, diagnostic details and callbacks do not. Persistence failure is
visible and described as window-only behavior. Clearing the Host browser profile
also clears these preferences. This is not OS notification permission control.

## Required authoring rule

Do not add a plugin Toast provider, manually positioned alert, page-wide error
banner or ad-hoc success/status paragraph for an operation result. Use this API.
Do not catch `show()` failure and recreate the old inline notification. Declare
`notifications` in injection requirements when the operation depends on it;
an older SDK/Host is a capability gap, not permission to access private DOM.

Keep field validation beside the field and durable business state on its object:
message delivery status, match settlement, pet health and a disconnected source
remain business content. They must not become duplicate transient notifications.
Avoid success notifications when the completed action already makes the result
obvious. Never toast each polling failure; notify on a meaningful transition.

Technical details are optional, bounded, plain text and redacted by the plugin.
Use readable localized messages instead of raw `denied`, stack traces or backend
payloads. Copying details happens only on an explicit user action.

## Implementation and verification

`renderer/notifications/model.ts` owns queue, rules and owner-bound facades;
`view.tsx` owns cards and rule management; `host.tsx` mounts the renderer lifetime;
`styles.css` owns the complete notification style surface. Runtime mounts inject
`notifications` per plugin and retire it with the plugin principal. Host starts
one viewport and disposes it with the renderer context. Production packaging
copies the CSS beside compiled modules.

Behavior coverage belongs in `tests/notifications.test.ts`; UI and production
composition must additionally exercise source navigation, More, undo, details,
action pending/retry, theme/keyboard behavior and unload. A model test alone is
not proof of real native Host integration.
