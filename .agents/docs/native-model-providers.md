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

### Experimental Dynamic Catalogs

The opt-in profile field `dynamicModelCatalog: true` watches the configured
local catalog files and base Codex configuration asynchronously. Selection and
submission consume an atomic in-memory projection instead of rereading those
files. Parent-directory watching handles atomic editor saves; bounded periodic
reconciliation repairs missed file events. Renderer invalidations are scoped
to the admitted document generation and reload a complete safe snapshot.
The default remains the existing pull/read-on-validation behavior.

An invalid model catalog retains the prior list only while its base configuration
source identity is unchanged. A valid empty catalog clears membership; removing
a configured provider removes it. A broken or changed connection configuration
cannot attest account/endpoint continuity and does not reuse the old list.
This base-file identity is not an effective layered native connection resolver.
The option preserves branding and never changes native endpoints, credentials,
defaults, or an active request. Live updates do not apply draft model fallbacks.
Full model-source management and script execution are not provided by this flag.

Host-private discovery provides an explicit owner-binding capability and an
adapter registry. The built-in registry has separate strict adapters for
DeepSeek, OpenCode Go and OpenRouter. For those exact official endpoints, the
selected profile may use its effective `env_key` or inline private bearer token
for one bounded `GET /models`. Selection receives only safe model metadata; the
credential and endpoint remain in launcher Node. A title alone never redirects a
credential to a different endpoint. Unsupported endpoints, unauthenticated
providers and unknown or layered credential shapes remain static/manual.

Remote discovery is enabled by default for supported native config providers.
Set `nativeModelDiscovery: false` on the selected CordisX profile to keep only
its native active-model and `configModelCatalogs` membership:

```json
{
  "displayName": "Default",
  "dataMode": "shared",
  "nativeModelDiscovery": false,
  "configModelCatalogs": {
    "deepseek": "catalogs/deepseek.json"
  }
}
```

This profile-wide setting takes effect on the next launch. It is independent of
`dynamicModelCatalog`, which only watches local files. When disabled, startup,
timers and Manager refresh make no remote model-list request. This stage does
not provide per-Provider source strategy editing or a native-config script source;
those require a separate configuration and management contract.

Automatic native-config results and their last-known-good copy are session-only
Host memory. `native-catalog-management.json` stores display overlays, not the
remote model list, endpoint or credential. A restart reacquires the list in the
background; failed same-scope refreshes retain only the current session's LKG.

### CordisX-Owned And Native-Only Connections

CordisX-owned Provider discovery and native-only credential reuse are different
paths. The Host-private `ManagedProviderOwner` owns explicitly provisioned
endpoint, protocol, discovery consent, strategy and supplement settings. It
stores its index and connection records through the existing OS Keychain backend
in a dedicated `cordisx/host-provider/v1` namespace. There is no plaintext file
fallback and no automatic import of Codex configuration, environment or secrets.
The generic channel secret resolver rejects this namespace. Plugin service
configuration is deliberately not used: no plugin receives this key, a resolver,
or a request capability. These APIs are not plugin extension contracts.

### Explicit target-profile synchronization

An optional `apps.codex.profiles.<profile>.providerBindings` list binds an
existing CordisX-managed connection to one stable provider ID in that selected
Codex profile. Each entry contains only a stable binding ID, stable connection
ID, target-local provider ID, enablement, `process-env` credential delivery, and
optional display overlay. Endpoints and credentials remain in the managed owner;
they are not duplicated into the CordisX home configuration. The native target
receives an environment-variable name, while the corresponding secret is added
only to the launched process environment after the target write is committed and
read back.

Native `model_providers` remain authoritative and are discoverable without any
write, import, adoption, or ledger creation. Import and adoption are separate
explicit lifecycle operations. Stable connection and binding identities, rather
than names, endpoints, credentials, or model IDs, distinguish connections and
make repeated startup idempotent. Disable, detach, and tombstone stop management
without deleting the target table automatically.

Managed updates compare the last-applied, desired, and actual target values in
coherent `display` and `routing` groups. A user edit that conflicts with one
group is preserved and reported as a non-modal warning; independent groups and
other connections continue. Unknown fields, comments, unrelated tables, native
providers, and catalog paths are preserved. CordisX never silently reverse-
imports a target edit.

The Codex adapter validates TOML before a compare-and-swap commit, journals the
target and private non-secret binding ledger for recovery, and reads the actual
target again for projection. The read model separates persisted, resolved,
runtime, and synchronization state. A persisted route is not presented as
runtime-active; layered resolution is unsupported and runtime activation remains
unverified. Codex direct-profile discovery, synchronization, import, adoption,
and detach are implemented. Claude Code, Gemini CLI, and OpenCode target adapters
remain unsupported and are reported as such rather than inferred from similar
configuration concepts.

The owner issues random connection, scope and credential revisions, never a hash
of a key or a reference name presented as an upstream account identity. Replacing
a key, endpoint or protocol rotates the credential-binding scope. Supplement
migration across that boundary requires a separate explicit action; an update
with old nonempty supplements is rejected. Other setting changes preserve scope
but retire old request leases. Removing a connection retires the durable index
entry before deleting its secret. A Keychain cleanup journal retries retired
items on reopen; cleanup failures are reported without reactivating them.

One owner holds a private, profile-scoped directory lock. It never steals a
possibly live lock; abnormal termination requires explicit stale-lock recovery.
Keychain index changes or lock loss retire the owner. Records remain in Keychain,
not ordinary home configuration, catalog JSON, feedback exports or backups of
CordisX files. OS Keychain backup policy remains controlled by the operating
system. A 60-second Host-private capture callback is the only secret input to
the internal management API; read/save results contain safe metadata and status,
not keys or keychain locations. No shared renderer secret field is provided.

Built-in adapters receive only a fixed request capability. It admits exactly the
saved official API base plus `/models`, with no caller headers, body or redirects:
`https://api.deepseek.com/models`, `https://opencode.ai/zen/go/v1/models`, or
`https://openrouter.ai/api/v1/models`. The Host resolves that connection's own
credential for a short operation, bounds the body to 8 MiB and cancels old
operations on update, deletion or disposal. Its production registry contains
only built-in Host adapters and accepts no plugin registration.
Errors from Keychain and transport are value-free. The existing trusted-code
model still applies: this is capability isolation, not a sandbox against arbitrary
code running with the user's OS identity.

The production profile launcher now composes this owner with model discovery,
the management channel, scoped overlays, manual supplements and developer scripts.
An OS-native secure text prompt captures provider keys; the management channel
only carries replacement intent. Script configuration is write-only and trusted
when explicitly saved; see [developer script sources](script-model-source.md).
Restoring settings never executes a script, and generic refresh never runs one.

Profile catalog state contains source LKG, overlay preferences and script
configuration, encrypted with AES-256-GCM using a separate Keychain-held key.
The owning profile lock serializes writes, rejects observed external replacement,
and fences encrypted state to its profile namespace. Complete empty replaces the
source cache. Scope/strategy changes do not reuse an unrelated cache. Script
results remain session-only. Pausing discovery cancels acquisition without
deleting source members. Explicit authentication/account denials prevent new
submissions even when retained rows remain visible.

Responses connections use the existing Host-private native credential broker.
Management snapshots never include its secret, command or lease. Overlay blocks
are enforced at submission admission; pinning changes only ordering. A listed
model is not proof of protocol support. Compatibility, route availability and
the user's blocked preference are independent. The Host keeps the configured
provider's `wire_api` in launcher-private state: `responses` is required for the
current native submission path, `chat-completions` is explicitly unsupported,
and omission uses Codex's current `responses` default. An explicit unrecognized
protocol remains unknown in the bounded Host projection and receives no
eligibility; current Codex rejects such a value when it loads configuration. On
a Responses connection, exact native catalog or manual membership is an explicit
usable declaration. Automatic membership still requires per-model
`protocolCapabilities.responses: true`; `false` is explicitly unsupported and a
missing capability remains unknown. Management rows retain this tri-state
compatibility separately from `selectable`, route availability and the user's
blocked preference. Unknown and explicitly unsupported automatic members remain
visible for management but are not ordinary selector choices. A compatible
blocked row remains visible in blocked management and can be restored.

OpenCode Go accepts the bounded OpenAI-compatible list returned by its dedicated
Go endpoint without treating one observed model count as a limit. OpenRouter
retains every structurally valid namespaced catalog row for management. It marks
only bounded interactive rows with text input, text output, `tools` and
`tool_choice` metadata as Responses candidates; dynamic `~` aliases, batch
routes and rows missing any required metadata remain visible with an explicit
unsupported capability for this synchronous native-selector path. OpenRouter
documents `~` names as moving latest-version aliases and `:batch` models as
asynchronous batch routes; excluding them is a CordisX reproducibility and
interaction policy, not an upstream statement that they lack Responses support.
The candidate rule is service-contract evidence, not an individual runtime test
or a GPT-family allowlist. Fixture coverage, including previously observed IDs,
is not a permanent allowlist or a live upstream acceptance claim.

The [official DeepSeek Responses guide](https://api-docs.deepseek.com/guides/responses_api)
and [Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)
confirm native Responses support. The built-in adapter confirms the exact
`deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` identifiers on the official endpoint. The latter
two are retained only as accepted legacy identifiers routed by DeepSeek to the
current service; CordisX preserves the submitted ID and does not create an
execution alias or claim a separate current vision model. Other IDs remain
unknown. The base URL stays
`https://api.deepseek.com/`, not `/responses`: upstream Codex appends the operation
path. No Responses/Chat conversion layer is required or implemented.
Upstream Codex owns HTTP, semantic SSE events and full stateless conversation
history, including paired function/custom-tool results. Offline protocol fixtures
and intermediary pass-through checks are not real App or upstream HTTP acceptance.

The admitted native document channel exposes read, cursor subscription and
CAS commands, with full snapshot resynchronization. No plugin API is registered.
As elsewhere in the trusted renderer architecture, this is not an OS or arbitrary
same-document-code sandbox. Tests use injected Keychain/transport and fixture App
resources; no real App or live provider usability is established by those tests.
Native-only connections continue to use native/manual catalogs until
their actual native owner can provide an audited discovery capability. That
optional compatibility dependency does not block CordisX-owned credentials.

The internal catalog contract separates a base strategy from optional same-scope
manual supplements: auto/native `only` uses the base list, `augment` also includes
explicit exact IDs, and manual replacement bypasses discovery. Supplement-only
entries are user-declared, not server-verified. Complete empty replaces only the
base list; deleting a supplement does not remove an ID still listed by the base.
Scope changes isolate both layers. A supplement may also declare
`protocolCapabilities.responses: true` or `false` for one exact model ID in that
connection scope. This is a user compatibility declaration, not adapter evidence.
It overrides the automatic value across refreshes; omitting the field in a full
supplement replacement deletes the declaration and restores automatic or unknown
state. Changing only a label preserves the existing declaration through the
Manager editor. An unlisted manual supplement on a Responses connection remains
an explicit usable membership declaration, while a label-only supplement for an
automatically listed unknown model does not elevate it. The Manager ships manual
and supplement editors plus the separately trusted developer script controls.

The encrypted state is a single-owner store, not a cross-process transaction
service or an upstream account-attested disk cache. Real native
flow verification and user acceptance remain separate
delivery gates. No provider API request is made by enabling the local-file flag.

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

Modal background isolation (`inert`, `aria-hidden`, or a visible modal dialog)
does not retire an otherwise valid Composer seat. The replacement remains
visible in its existing position with its confirmed selection, but closes its
menu and blocks pointer, keyboard, and selection actions. Modal closure restores
interaction through DOM observation without waiting for catalog polling. Focus
stays with the modal; queued menu focus restoration also checks current isolation.
An actually removed or ambiguous Composer still retires the seat normally.

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
