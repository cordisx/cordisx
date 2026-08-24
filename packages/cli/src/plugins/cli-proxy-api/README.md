# CLIProxy Providers

CLIProxy Providers lets one CordisX app work with models and conversations from multiple explicitly configured CLIProxyAPI-compatible providers. It adds a dedicated provider page for choosing models, creating conversations, searching provider history, continuing work, and managing conversation lifecycle without replacing Codex Desktop's native conversations.

## Open the Provider sessions fleet

Use the **Providers** navigation entry, or select the Provider sessions route from the Manager route catalog, to enter the external Provider sessions fleet. The route metadata explains how to reach this destination; the page metadata separately describes the model and conversation management available in the main workspace context.

The canonical route id `providers.sessions`, path `/main/providers/sessions`, `main` outlet, and page id `providers.sessions` are stable machine identifiers and are never translated. Only their user-facing title and description follow the active CordisX locale.

## Configure providers

Run `cordisx config` to locate the active CordisX configuration. The default location is `~/.cordisx/config.json`. Add each external provider to the top-level `providers` list and enable the built-in plugin with `cordisx:cli-proxy-api`:

```json
{
  "version": 1,
  "defaultApp": "codex",
  "apps": {
    "codex": {
      "defaultProfile": "default",
      "profiles": {
        "default": {
          "displayName": "Default",
          "dataMode": "shared"
        }
      }
    }
  },
  "providers": [
    {
      "id": "gateway-a",
      "kind": "cli-proxy-api",
      "displayName": "Gateway A",
      "baseUrl": "https://proxy.example.com/v1",
      "apiKeyEnv": "CLIPROXY_A_API_KEY"
    }
  ],
  "plugins": [
    {
      "id": "cli-proxy-api",
      "entry": "cordisx:cli-proxy-api",
      "enabled": true,
      "config": {
        "providerIds": ["gateway-a"],
        "defaultCwd": "/path/to/workspace"
      }
    }
  ]
}
```

Set the environment variable named by `apiKeyEnv` before launching CordisX. Keep secrets out of `config.json`. Use HTTPS for remote endpoints; loopback HTTP is supported for a provider running on the same machine.

The Manager **Configuration** tab exposes only this plugin's renderer behavior:

- `providerIds` defaults to `[]`. It filters the page to Provider IDs that the launcher has already configured and enabled; an empty list shows every enabled Provider. The list accepts at most 64 IDs, each using the same lower-case `[a-z0-9][a-z0-9._-]{0,95}` format as the launcher.
- `defaultCwd` defaults to `""`. It prefills the new-session working directory; an empty value lets you choose a directory on the Provider page. The value is limited to 4096 characters and cannot contain NUL.

Invalid values are rejected in the Manager before the launcher writer is called. Valid settings use the Host's profile- and generation-bound configuration RPC and take effect after the plugin restarts. Adding or removing Provider connections, changing endpoints, selecting a process, and editing credentials are unavailable in this Manager form. Those settings remain in the launcher-owned top-level `providers` configuration, and the plugin never writes the CordisX home configuration directly.

Provider IDs are persistent identity, not display labels. Keep each `id` unique and stable after creating conversations.

## Model and conversation identity

Every model is identified by both `providerId` and `modelId`. Every conversation is identified by both `providerId` and its remote session ID. The provider is shown with model and conversation results, so two gateways may safely return the same model or session ID without colliding, resuming the wrong conversation, or mixing search results.

## External providers and the native connection

The external Provider Fleet is separate from the Codex Desktop current connection. It does not impersonate the native connection, import native conversations into the provider page, or use an external provider as an automatic fallback for native work. A healthy external provider therefore does not change an unavailable native-current-connection status, and native conversations remain in their existing Codex UI.

## Permissions

The plugin uses the normal CordisX permission flow. Its plugin details expose policies and current-run audit information for:

- `models.read` to list provider models;
- `tasks.catalog.read` and `tasks.content.read` to list, search, and open conversations;
- `tasks.create` and `tasks.control` to create, continue, fork, archive, restore, or delete conversations;
- `turns.submit` and `turns.control` to send, steer, or interrupt turns.

Review these capabilities under **Plugins → CLIProxy Providers → Permissions**. A denied capability remains denied; the plugin does not bypass the broker or fall back to the native connection.

## Empty and unavailable states

With no enabled provider, there are no external models or conversations to display. Add a provider, set its credential environment variable, and relaunch CordisX. If a configured provider is unavailable, verify its endpoint, credential environment variable, network access, and Codex executable. Other provider identities remain isolated, and an unavailable provider is never silently replaced by another one.

## Current boundary

CordisX and this built-in plugin are experimental, unofficial, opt-in local software. Compatibility depends on the configured CLIProxyAPI-compatible endpoint and the installed Codex app-server behavior; support for every gateway version or model workflow is not implied. Credentials stay launcher-side, while the plugin receives only permission-brokered provider operations and user-visible results.
