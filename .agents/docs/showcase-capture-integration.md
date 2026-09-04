# Showcase and capture integration

This document owns the boundary between normal CordisX product behavior,
optional demo composition, and the real Codex Desktop capture workflow used by
the homepage repository.

## Decision table

| Change | Product policy | Control |
| --- | --- | --- |
| Manager navigation, breadcrumb, search, and empty-state localization | Product correctness; merge normally | No feature flag. Add `en` and `zh-CN` copy through `renderer/ui-copy.ts` and resolve it from the active locale. |
| Slot Showcase branded welcome destination | Reusable demo capability that changes the example plugin's navigation | `slot-showcase` configuration field `welcomePage`; default `false`. Capture and purpose-built demos opt in. |
| Longer CDP renderer injection timeout | Development/capture accommodation for unusually large bundles | `CORDISX_CDP_INJECTION_TIMEOUT_MS`; default `60000`, valid range `5000..600000`. Never increase the product default for a capture. |
| Screenshots, videos, cursor artwork, isolated profile setup, and scene timing | Homepage-owned generated presentation | Keep in `cordisx/cordisx.github.io`; do not duplicate generated media here. |
| Root README AI-first plugin demo GIFs, MP4/WebM sources, evidence, and recorder | Homepage-owned generated presentation referenced by this repository | Regenerate and verify in `cordisx/cordisx.github.io`; update pinned media URLs here only after the website commit is pushed. Do not copy the recorder or media here. |

The optional welcome route and page still satisfy the normal route-v2/page-v3
metadata and localization gates. Turning the option off means they are not
registered and the existing `main.analytics` navigation behavior remains
unchanged.

## Agent routing

Before changing Manager language or copy, read
[`ui-copy-principles.md`](ui-copy-principles.md) and
[`ui-copy-catalog.md`](ui-copy-catalog.md), then inspect
`packages/cli/src/renderer/ui-copy.ts` and the owning Manager page. Do not add a
page-local hard-coded translation when Host copy already owns the string.

Before changing launcher injection, renderer bootstrap timing, or CDP retry
behavior, read [`distribution-and-cli.md`](distribution-and-cli.md) and
[`architecture.md`](architecture.md), then inspect
`packages/cli/src/launcher/cdp.ts` and `tests/cdp.test.ts`. Capture-specific
tuning must use a validated explicit override and preserve the product default.

Before changing the real homepage showcase, read this document and the capture
workflow in the `cordisx/cordisx.github.io` repository at
`.agents/docs/showcase-capture.md`. Product code belongs here; the isolated
profile, declarative scene, cursor, screenshots, and videos belong to the
homepage repository.

Before changing the root README AI-first plugin demo or its media references,
read the dedicated
[AI-first plugin demo capture workflow](https://github.com/cordisx/cordisx.github.io/blob/main/.agents/docs/ai-plugin-demo-capture.md).
Regenerate and verify the media in `cordisx/cordisx.github.io`, then update the
pinned URLs here only after those assets are committed and pushed. Do not copy
the recorder, fixtures, evidence, or generated media into this repository.

## Capture composition

The homepage capture launcher must opt in explicitly:

```json
{
  "id": "slot-showcase",
  "config": { "welcomePage": true }
}
```

It may set `CORDISX_CDP_INJECTION_TIMEOUT_MS=300000` for the large development
bundle. The environment variable is process-local and must not be persisted in
ordinary CordisX user configuration.

## Verification

- Run focused tests for `tests/cdp.test.ts`,
  `tests/ui-demo-config-schema.test.ts`, and
  `tests/route-page-metadata-gate.test.ts`.
- Run the normal `npm run check` gate after rebasing onto the current main.
- For capture changes, regenerate the locale/theme matrix from the homepage
  repository and review identical timeline frames before publishing.
- Keep authentication files, temporary Home directories, and Chromium profiles
  outside both repositories.
