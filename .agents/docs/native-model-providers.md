# Native Model Providers

Experimental Host implementation. This is distinct from Provider Fleet's
separate conversation surface. The public renderer contract is
[Model Providers V1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/model-providers-v1.md).

## Ownership

Managed Node plugins register their own service and publish an accepted native
provider catalog. Providers already configured in the effective Codex
`config.toml` are projected beside them from `model_providers`,
`model_catalog_json`, `model_provider`, and `model`. Relative catalog paths are
resolved from `CODEX_HOME`. The global catalog describes model capabilities, not
provider membership. Without an explicit Host mapping, only a top-level explicit
`model_provider` plus `model` pair establishes membership; the global catalog
supplies display metadata for that exact ID. An omitted `model_provider` means
the native default, not the sole custom provider. Managed providers take precedence
when an ID is present in both sources. No particular gateway plugin is required.
The launcher writes each ready managed provider's endpoint and authentication
into the private managed configuration, then exposes only provider titles,
model IDs, aliases and ownership to the renderer. Config provider bodies and all
credentials stay outside renderer descriptors. Unauthenticated managed endpoints
are restricted to loopback.

### Explicit Config Provider Catalogs

Set `apps.codex.profiles.<profile>.configModelCatalogs` in the existing CordisX
home configuration to map each configured provider ID to a local JSON catalog.
For example, the profile body may contain:

```json
{
  "displayName": "Default",
  "dataMode": "shared",
  "configModelCatalogs": {
    "deepseek": "catalogs/deepseek.json",
    "modelhub": "catalogs/modelhub.json"
  }
}
```

Each file uses the existing catalog shape:

```json
{
  "models": [
    {
      "slug": "MODEL_ID_CONFIRMED_FOR_THIS_PROVIDER",
      "display_name": "Model",
      "aliases": []
    }
  ]
}
```

Replace the placeholder only with IDs explicitly confirmed for that endpoint.
The example is not a supported-model list for either service. A gateway can
serve multiple vendors, and different providers can share a model ID. Neither
model prefixes nor display names establish ownership. A single provider's
explicit file is authoritative; the global catalog and active model cannot add
missing IDs. Duplicate IDs keep the first entry within that file. There is no
implicit merge across profiles or discovery of native `*.config.toml` files.

Paths are relative to the effective `CODEX_HOME` (or absolute local paths), not
the CordisX config directory. URLs are rejected. Files are bounded to 32 MiB;
the config is bounded to 4 MiB, and at most 128 mappings are accepted. Only model
IDs, labels and aliases are projected. Empty, missing, malformed catalogs or
removed providers produce sanitized `configModelCatalogs` launcher diagnostics
(`catalog-empty`, `catalog-unavailable`, `provider-missing`), with no file paths
or configuration bodies. Check `cordisx logs codex <profile>` for these codes.

Mapping edits use the normal home configuration and take effect on the next
launch of that CordisX profile. Catalog contents are reread on menu refresh and
submission validation. Vite's unnamed `development` profile does not inherit a
named profile's mappings. No mapping activates a native Codex profile, changes
endpoint/authentication, or grants permissions. Codex still owns request routing.

Existing union catalogs need explicit per-provider membership before all custom
choices can be restored. Keep the global catalog intact for Codex capability
metadata; create the separate files and mappings from known endpoint support.
Without ownership information, an empty custom-provider menu is intentional and
is not evidence that migration or desktop acceptance has completed.

The Host owns the Model services settings destination, provider rows, grouped
model menu, and native selection adapter. Plugins decorate their own published
IDs and can insert supplemental action rows through `ctx.modelProviders`.
An action may open authentication, API-key setup or plugin settings; the Host
does not prescribe a login flow. Plugins remove the supplemental row when it is
no longer needed. Branding does not register an endpoint or establish readiness.

### Selector icons

The Host may infer a provider brand from its structured endpoint and then a
bounded exact provider-name alias. Model icons are resolved separately from an
exact or namespaced model ID and then a display name; they never inherit the
provider icon. Unknown, deployment-style, and ambiguous IDs retain the generic
model icon. Branding is presentation only and does not change catalog
membership, defaults, routing, authentication, or grants.

`apps.codex.profiles.<profile>.selectorIcons` can override those decisions for
non-native providers. `providers` maps a provider ID to a built-in provider
brand key or `generic`. `models` maps a provider ID and exact model ID to a
built-in model brand key or `generic`. An explicit `generic` disables inference.
Provider and model keys are separate, so a Moonshot provider can show a Kimi
model and an OpenRouter provider can show OpenAI, Claude, or Gemini models.

```json
{
  "selectorIcons": {
    "providers": { "gateway": "openrouter" },
    "models": {
      "gateway": {
        "openai/gpt-5.6": "openai",
        "private-deployment": "generic"
      }
    }
  }
}
```

The maps accept at most 128 providers and 512 exact model IDs per provider.
Unknown keys and malformed IDs reject the profile without echoing their values.
The native `openai` provider ID is reserved and cannot be overridden; its Codex
provider mark and native model catalog behavior remain unchanged. Plugin
provider presentation wins over automatic provider inference when no user
override is present. No URL, external image, SVG source, credential, or
connection field is accepted by this setting.

## Selection

Provider changes prefer an exact model ID, then a unique explicit alias. An
ambiguous or absent match opens the provider's model submenu; labels are never
used to guess equivalence. Existing-thread provider changes require confirmation.
An active turn blocks switching and is not interrupted automatically. The Host
does not create a replacement thread or automatically compact history.

The capability-checked Codex adapter synchronizes the native composer selection and
uses native session operations to change an idle thread's effective provider.
The effective response, not the historical provider embedded in thread metadata,
is the transition receipt. New drafts use the private configuration defaults.
Within one App/profile launch, the Provider explicitly selected in a new draft
becomes the default Provider for later new drafts. Before that first explicit
draft selection, `apps.<app>.profiles.<profile>.defaultModelProvider` is used
when it resolves to `openai`, a ready managed Provider, or an available
config-backed Provider. The precedence is therefore last explicit new-draft
Provider, configured profile default, then the native Codex default. This
launch-scoped memory stores only the Provider ID, never credentials or a model;
each draft reuses the normal exact-ID, unique-alias, provider-default, then
first-model selection strategy to choose a legal model for that Provider.
Existing-thread switches, restoration, catalog projection, and automatic
initialization do not update the preference. Restarting the App clears the
launch-scoped memory and reads the profile configuration again.
Config-backed providers pass only the selected `model_provider` and `model` to
Codex, which continues to own their configured endpoint and authentication.
Custom choices are checked against their provider's catalog, including changes
within the same provider. A stale native global entry cannot bypass membership.
Pending config selections are revalidated at preparation and marked-request
authorization; a stale effective config model is rejected before pass-through.
Canceling a pending switch can still restore the exact prior pair. The built-in
`openai` path retains native model selection and is not configurable by this map.
Managed providers continue to use launch-scoped credential leases and provider
tables.
Only an accepted native operation changes the selected Provider shown to users.
Failed transitions attempt to restore the prior effective session/configuration;
failed recovery disables the replacement instead of claiming success.

Native controls remain available when the adapter is unsupported, its audited
composer seat cannot be found, or the replacement cannot represent the current
selection. Disposal restores native visibility and removes owned React roots,
portals, subscriptions, timers and action signals. Reasoning controls remain
reachable alongside model selection.

## Desktop Compatibility

Native submission admission reads the installed App's initial and primary
JavaScript resources without modifying or launching it. Desktop version/build
strings are diagnostics, not an allowlist. The Host parses submission, model
completion, draft/first-turn context, request normalization and final dispatch
structures. Missing or ambiguous structures report the specific capability.
Local minified identifiers and asset hashes are discovered from the resource.
The older two-stage resource layout retains an exact-content adapter; it is
selected only when both complete resource digests match, regardless of version.
New resource layouts use structural discovery, not additional build entries.
The selector consumes the launcher's verified capability and does not maintain
a second Desktop version allowlist. Admission runs after submission options are
bound, before subsequent native guards and effects; those guards remain intact.
Model-update callbacks are resolved within their owning function, so unrelated
minified bindings with the same spelling do not reject a compatible resource.

The launcher admits a new renderer only while its title or URL still identifies
Codex/ChatGPT. After that strict admission, the Desktop may retitle the document
for the open thread; the launcher retains the installed native renderer only
while its target id, debugger endpoint, live session, and `app://-/` origin
remain stable. Evicting an installed renderer on a cosmetic retitle disposes
the submission channel, rejects an in-flight first turn, and reloads the page.

Managed provider tables are launch-scoped request overrides, not persisted Codex
configuration. A restarted app-server therefore rejects `thread/resume` for a
thread that still names a managed provider, which also leaves the native model
control, and with it the Host selector seat, unrendered. Only the explicit
missing-provider configuration error is eligible for recovery. The intermediary
verifies that provider against the persisted thread and retries once with a
candidate provider table. The candidate lease replaces the thread binding only
after native resume succeeds; other native errors and failed retries leave the
existing binding unchanged. When the Host cannot vouch for the provider, the
native failure stands.

Each successful discovery binds interception to the observed resource SHA-256.
A resource update between discovery and interception fails closed. The existing
operation-token validation, awaited admission, native permission checks,
credential isolation, execution acknowledgement and disposal fences remain.
Production and Vite development share this composition.

Managed-source account reads use the typed native account capability. The
resource parser resolves its exported service from the native account query;
the calling context verifies the resource and method before reading. A typed
failure never falls back to legacy POST or a cached account. Display-profile
adaptation and the separate Agent/Session transport remain separate capabilities;
neither gates composer submission. Their existing version restrictions are not
evidence that native submission is incompatible.

After building the Host, run
`node packages/cli/scripts/check-native-submission-resources.mjs --app /path/to/Codex.app`
for read-only resource verification, or pass `--resources-dir` for an existing
initial/primary resource directory. This verifies source compatibility and
reports resource hashes; it does not prove a native submission or account read.

## Verification Boundaries

Registry, selector, managed-service RPC, configuration and native transport tests
cover their individual contracts. Production package staging and a real isolated
`app://` composer flow are additionally required before claiming native usability.
Mock upstream request logs prove destination/authentication handling without
spending real model credentials; they do not prove an internal service login or
every model's compatibility with the conversation history.

Installed plugins use the normal scoped permission review for
`manager.settings.navigation-items` and `manager.content`. Until those grants
are accepted, their settings destinations may not be visible. Provider
readiness and permission to render a settings page are separate states.

The audited Desktop build also creates background title-generation threads
with its own model choice. Those requests do not originate from the composer
selection transaction; a global model fallback can select a model unsupported
by the default provider. Verified main-conversation routing does not establish
correct routing for every background request.

Managed-service preparation currently fails the launch if a required plugin
cannot start. Partial preparation is disposed, but isolating startup failure
to one plugin is not implemented by this candidate.

Formal dependency pins, repository delivery gates, publication and explicit user
acceptance remain separate from an experimental local candidate.
