# Native Model Providers

Experimental Host implementation. This is distinct from Provider Fleet's
separate conversation surface. The public renderer contract is
[Model Providers V1](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/model-providers-v1.md).

## Ownership

Managed Node plugins register their own service and publish an accepted native
provider catalog. No particular gateway plugin is required. The launcher writes
each ready provider's endpoint and authentication into the private managed
configuration, then exposes only model IDs, aliases and plugin ownership to the
renderer. Bearer credentials stay outside renderer descriptors. Unauthenticated
managed endpoints are restricted to loopback.

The Host owns the Model services settings destination, provider rows, grouped
model menu, and native selection adapter. Plugins decorate their own published
IDs and can insert supplemental action rows through `ctx.modelProviders`.
An action may open authentication, API-key setup or plugin settings; the Host
does not prescribe a login flow. Plugins remove the supplemental row when it is
no longer needed. Branding does not register an endpoint or establish readiness.

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
