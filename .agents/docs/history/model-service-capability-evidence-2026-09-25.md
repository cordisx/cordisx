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

- DeepSeek's official Codex guide configures `wire_api = "responses"`, currently
  installs `deepseek-flash` and `deepseek-v4-pro`, and states that older installs
  may contain `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`. The service
  compatibility notice treats the legacy names as accepted identifiers routed
  to the current Flash service.
- OpenRouter's official Responses overview describes a stateless Responses
  endpoint across multiple model families. Its tool-calling guide uses function
  tools and `tool_choice`, so the adapter requires both metadata fields rather
  than filtering by model family.
- The public OpenRouter model snapshot contained 458 rows: 390 advertised text
  input, text output and tools; 383 also advertised `tool_choice`; 293 remained
  after excluding dynamic `~...latest` aliases and `:batch` routes. These counts
  describe that dated snapshot, not a permanent service inventory or individual
  runtime verification.

## Candidate verification boundary

Focused policy and discovery tests cover tri-state compatibility, disabled but
compatible state, all four exact DeepSeek identifiers, unrelated unknown IDs,
the 458/293 OpenRouter fixture projection, Responses versus Chat Completions
routes, and restoration of a blocked compatible model. No native App, real
credential, provider request, installation, package, release, merge, or user
acceptance is part of this candidate.

## RouteSpecHandoff

- route: UX
- outputRef: `.agents/docs/history/model-service-capability-evidence-2026-09-25.md`
- ownedRequirements: UX-7, UX-8, UX-9
- blockers: real native and upstream runtime verification remain outside scope
- coordinatorContinuationRequired: true
- coordinatorMayComplete: false
