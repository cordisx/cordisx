# Notification interaction demo

Run `npm run dev -- --config cordisx.config.notifications.json` from the Host
repository to exercise the public `ctx.notifications.show()` service. This fixture
uses synthetic connection errors and performs no network or account operation.
Use an isolated profile for automated native checks. The maintained smoke script
is `packages/cli/scripts/notification-smoke.mjs`, launched by
`packages/cli/scripts/run-isolated-app-smoke.mjs`.

See the [notification guide](../../../.agents/docs/notifications.md) for card
behavior, stable message categories, source ownership and user suppression rules.
