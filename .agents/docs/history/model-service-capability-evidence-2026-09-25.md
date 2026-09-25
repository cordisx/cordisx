# Model service capability evidence - 2026-09-25

Status: implementation candidate on branch `codex/model-services-caps-ux7-9`,
based on experimental Host revision
`2a9fccd2209966780f68807867476566d2fc706b`. This is a dated evidence record,
not permanent maintenance instruction, formal delivery, or live provider
acceptance. The current behavior reference is
[Native Model Providers](../native-model-providers.md).

## Scope

- UX-7: resolve Responses compatibility as `supported`, `unsupported`, or
  `unknown`, independently from route availability and the user's blocked
  preference. Configured/manual exact membership is usable only on an actual
  Responses route; automatic membership requires positive capability evidence.
- UX-8: retain DeepSeek's exact current and accepted legacy identifiers without
  rewriting the submitted model ID or presenting the legacy vision name as a
  separate current service capability.
- UX-9: retain OpenRouter's structurally valid catalog for management while
  marking only bounded interactive text/tool candidates as Responses-compatible.

## External evidence

Evidence was reviewed on 2026-09-25 without reading real user configuration,
credentials, or making a model request.

- Codex's current configuration schema at upstream commit
  `3d6428510fee6f52d8993ebacf4818bb42ba0cde` defines
  `ModelProviderInfo.wire_api` with default `responses`. The exact source was
  `https://raw.githubusercontent.com/openai/codex/3d6428510fee6f52d8993ebacf4818bb42ba0cde/codex-rs/core/config.schema.json`,
  SHA-256 `cea3b0abaeca864385151b5f41ae91dac95bb10fe350f9aa67fd9545cc32eb4d`.
  The corresponding source at
  `https://raw.githubusercontent.com/openai/codex/3d6428510fee6f52d8993ebacf4818bb42ba0cde/codex-rs/model-provider-info/src/lib.rs`
  defines Responses as the only current enum member and rejects unrecognized
  explicit values; its SHA-256 was
  `25cdc7cb7341e31eee261d1d313a45c231e1c5cb00e46baff168b45a4c9e2727`.
  CordisX therefore defaults an omitted field to Responses, while an explicit
  value outside the recognized projection enum remains unknown and ineligible.
  This is the current schema contract; older Codex behavior before the default
  changed is not generalized.
- DeepSeek's official Codex guide at
  `https://api-docs.deepseek.com/quick_start/agent_integrations/codex` configures
  `wire_api = "responses"`, currently installs `deepseek-flash` and
  `deepseek-v4-pro`, and notes that rerunning the installer removes the two older
  catalog entries. Retrieved HTML SHA-256:
  `70ab3b2e3eea18895729246c71631850159ba0a6af559ad1c8ba26ed2b66049d`.
- The independent compatibility statement is in DeepSeek's official pricing
  reference, `https://api-docs.deepseek.com/quick_start/pricing`: the legacy
  names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted,
  their retired models are served by DeepSeek-V4.1-Flash, and Flash pricing
  applies. Retrieved HTML SHA-256:
  `210f102275ccf1a6542f08a3bc9e4b4c7c83278cb74b35217bffa112df6363b2`.
- OpenRouter's official Responses overview,
  `https://openrouter.ai/docs/api_reference/responses/overview.md`, describes a
  stateless Responses endpoint spanning multiple model families. Its tool guide,
  `https://openrouter.ai/docs/api_reference/responses/tool-calling.md`, uses
  function tools and `tool_choice`. Retrieved Markdown SHA-256 values were
  `accd5ae77505048ac75318b1c8f6a2b0906e3d8a58bb0caa34d14310801b9538`
  and `b3c7607c15feed7cfca87c741b2874b63060ebe0072429cd082f6667e8323d9d`.
- The public snapshot `https://openrouter.ai/api/v1/models`, retrieved on
  2026-09-25, had SHA-256
  `34e60ccc96b83d09ce1e705d64ac2f030a25ec8f0a2626212d773f588cd99a18`.
  It contained 458 rows: 390 advertised text input, text output and tools; 383
  also advertised `tool_choice`; 293 remained after the CordisX policy excluded
  dynamic `~` aliases and `:batch` routes. OpenRouter separately documents those
  forms at `https://openrouter.ai/docs/guides/routing/routers/latest-resolution.md`
  and `https://openrouter.ai/docs/batch-quickstart.md`: the former is a moving
  alias and the latter is an asynchronous batch endpoint. Their retrieved
  Markdown SHA-256 values were
  `b3ff29c5c4ed7d1ab699e0a46317993b045115bbbbb953b746d71d61a4d60856`
  and `24bd524e72a8371d6c41e84f7c034261c1a7a89ead905d9ee962a5d0a8f8dddc`.
  The counts are a reproducible metadata snapshot, not a permanent inventory or
  proof that all 293 candidates completed a real Responses request.

## Candidate verification boundary

Focused policy and discovery tests cover tri-state compatibility, disabled but
compatible state, all four exact DeepSeek identifiers, unrelated unknown IDs,
the 458/293 OpenRouter fixture projection, Responses versus Chat Completions
routes, omitted-protocol defaulting versus an explicit invalid protocol, row-level
compatibility projection, and restoration of a blocked compatible model. The
generated 458/293 fixture reproduces the dated aggregate matrix but is not the
external snapshot itself. No native App, real credential, provider request,
installation, package, release, merge, or user acceptance is part of this
candidate.

## RouteSpecHandoff

- route: UX
- outputRef: `.agents/docs/history/model-service-capability-evidence-2026-09-25.md`
- ownedRequirements: UX-7, UX-8, UX-9
- blockers: real native and upstream runtime verification remain outside scope
- coordinatorContinuationRequired: true
- coordinatorMayComplete: false
