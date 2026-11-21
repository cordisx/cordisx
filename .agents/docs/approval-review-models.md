# Automatic approval review models

CordisX can configure which model the native Codex Guardian uses for automatic
approval review. This is a profile-owned startup setting, separate from the
chat's `user` / `auto_review` reviewer strategy. Selecting a model does not
enable automatic review, change sandbox or network permissions, or answer a
pending approval.

## Configure a profile

Prepare a complete native `model_catalog_json` file for the installed Codex
version, including both the work model and review model. Preserve the full
catalog and its model instructions, tool capabilities, and Guardian policy.
A `/v1/models` response containing only IDs is insufficient. A review model
must be API-supported and contain its original `model_messages.auto_review`
policy and policy template. CordisX changes only `auto_review_model_override`;
it does not generate model policy or infer compatibility from a model name.

Save an input JSON file, for example:

```json
{
  "providerId": "gateway",
  "catalogPath": "review-models.json",
  "models": {
    "work-model": "review-model"
  }
}
```

`catalogPath` is a local file path; relative paths resolve beside CordisX's
`config.json`. `models` maps work-model IDs to reviewer IDs. Optional
`defaultModel` sets the reviewer for all catalog models, with explicit mappings
taking precedence. Unmapped models retain their native reviewer metadata.

From the local operator's shell:

```sh
cordisx codex defaults review get --profile default
cordisx codex defaults review set --profile default --revision 0 --input-file review.json
cordisx codex defaults review reset --profile default --revision 1
```

Use the revision returned by `get`; a concurrent write returns
`REVISION_CONFLICT`. Writes report `application: saved` and
`applies: native-restart`. Restart the selected native instance normally to
apply or remove the setting. An active instance keeps its immutable launch
snapshot until it exits. The original catalog file is never rewritten.
These commands work without a running Host. They persist under
`apps.codex.profiles.<profile>.approvalReview` in CordisX's `config.json`.
Agent and Channel callers cannot change their own review routing.

## Provider and runtime boundaries

The native reviewer inherits the parent model's provider, including its
connection and credentials. For example, GPT and DeepSeek can share an Aiden
provider if that provider serves both IDs with a compatible Responses API.
Cross-provider review routing is unsupported. The configured profile is
restricted to its declared `providerId` and catalog model IDs; explicit
incompatible provider/model selections fail before submission. New chats must
specify a work model or have a configured creation default. A terminal launch
must explicitly select both service and model:

```sh
cordisx start --mode cli codex -s gateway -m work-model
```

Native `--profile` overrides and provider/model/catalog config overrides are
rejected on managed review launches. Desktop requires the native submission
route; headless services prepare the same catalog before their app-server
starts. Configuring this together with CordisX's static context-budget catalog
is currently rejected (`REVIEW_CATALOG_BUDGET_CONFLICT`); combine metadata in a
single operator catalog and leave the static catalog mechanism disabled.

Supported native versions are `0.149.1` and `0.171.0-alpha.13`. Other versions
return `REVIEW_NATIVE_VERSION_UNSUPPORTED` rather than silently ignoring the
requested reviewer. Catalog validation checks required metadata and selected
review policies; native startup still validates the complete version-specific
schema. Save success does not prove that a gateway implements the selected
model or Guardian's structured output format.

Current public native APIs load the models manager at startup. Per-chat
catalog overrides cannot replace it, so live per-chat reviewer-model selection
is unavailable (`sessionOverride: false`). The existing
[`chats reviewer` commands](codex-cli.md#session-targets-and-defaults) still
control the strategy, not the review model.

If the reviewer is unavailable, incompatible, or returns an invalid assessment,
native Guardian fails closed: the requested action is not approved. CordisX
does not fabricate approval, switch to another reviewer, or automatically
fall back to manual review. Inspect the native error before changing the
operator configuration or explicitly returning the chat to `user` review.
