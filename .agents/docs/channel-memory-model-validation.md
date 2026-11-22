# Channel memory real-model scenarios

This is platform-independent synthetic behavior validation, not live Feishu,
production launch, Protocol publication, or a complete-memory-system claim.

## Harness boundary

### Current fix-loop evidence

Production-backed Host seams now include own-topic accepted-text resolution,
local configured administrator authority, two-account challenge confirmation,
persona native startup injection and task memory routing. Model runs below are
mock-platform evidence; no live platform permissions or remote sends are used.

Persona core continuity/control rerun passed at
`/tmp/channel-memory-model-3y9WQO/results.json`: `gpt-6.1-sol` / `aiden_local`,
four independent model contexts, seven tool calls, 2,257 returned bytes,
59,606 ms scenario elapsed time. Feishu and Telegram bot accounts were bound to
Atlas; the model initiated and confirmed the human-account challenge, then
retrieved CONTINUITY-93 through actual get. A Discord account bound to Nova
searched its separate space and found no code. All turns use actual native
startup prompt assembly over a simulated native bridge. This demonstrates
persona-space continuity without granting every human access to private memory.
The first outer-sandbox attempt (`ViqXz2`) failed runtime initialization with
zero calls; the approved rerun above is the behavioral evidence.

Independent style-delivery repeat passed both scenarios at
`/tmp/channel-memory-model-ogy5Ej/results.json`, using the same configured model
and provider. `manual-auto-style` received an actual mock-platform `sent`
receipt through production send and generated the same code in a subsequent
Chinese final response. `scoped-style-separation` answered STYLE-55 in Chinese
privately and English in the professional context. This does not establish
automatic-final outbox transport or ask/progress coverage. Focused regression
after the durable harness additions: 22 tests passed across six files; the
strengthened continuity assertion also passed its four-test focused rerun.

- Own-topic corrected run: `/tmp/channel-memory-model-9VQH6G`, passed for that
  scenario; its administrator scenario failed and was subsequently fixed.
- Cross-platform confirmation: `/tmp/channel-memory-model-uTJz3W`, passed with
  actual challenge call on Feishu, explicit confirmation on Telegram, then get.
- Latest administrator/new-member run: `/tmp/channel-memory-model-f2QdcM`,
  passed with no premature grant. Earlier schema/identity failures are retained,
  not counted as passes. Authority was explicitly preconfigured for the
  synthetic actor/source, not inferred from “administrator” message text.
- Native initialization/model style run: `/tmp/channel-memory-model-fcnS6t`.
  Atlas identity/recall passed; style answers were Chinese privately and English
  in group with unchanged STYLE-55. Initial assertion falsely matched STYLE-55
  as style data; corrected assertion evaluates that evidence successfully.
  The runner now uses actual ChannelNativeSessions.start prompt assembly, not
  an ad-hoc hand-built capsule injection. Native bridge/platform is simulated.

Core regression batch and manual outbound repeat are recorded separately when
completed. The first manual-send attempt had a mock receipt-signature bug,
reported not-found honestly; it is not a delivery pass.

Manual outbound corrected run: `/tmp/channel-memory-model-MCI9NW`, passed with
`deliveryState: sent` from actual ChannelConversationTools.send over the mock
platform outbox. Manual Chinese text and next final Chinese text retained
OUTBOUND-82. Older yfAETg/cNPBq6 runs had not-found receipts; stricter reassessed
results mark those manual scenarios failed, regardless of prior weaker labels.
Scoped style repeat in yfAETg passed: Chinese private/English group, identical
STYLE-55 and no private style data included in memory. This tests generation
and manual delivery, not auto-final outbox composition or ask/progress coverage.

Useful regression batch completed at `/tmp/channel-memory-model-1TwWeJ`.
Ten non-admin scenarios passed; its admin scenario had a premature grant under
an earlier prompt/consent implementation and is **not accepted as final proof**.
Use `/tmp/channel-memory-model-f2QdcM` instead: exact current request triggered
one grant, no grant during save, and new-member recall passed. Cross-platform
confirmation therefore has two passing runs (uTJz3W and the regression batch),
and own-topic/alias/correction/purpose/timeline/guide/large corpus have repeats.
No model run bypassed sandbox/identity checks or sent live platform messages.

Current remaining verification gaps are formal Protocol publication, complete
installed dependencies/package-wide typecheck/lint, actual automatic-final
outbox native composition, ask/progress style coverage and expanded context
profile layering. They do not negate the corrected core memory scenario runs,
but must remain separate from claims of complete PR/native release readiness.

Latest focused deterministic run: 21 tests passed across six files (memory,
persona registry, actual native bootstrap, model/platform boundary, model
assertions, existing conversation tools). Strict new-storage-module typecheck
passed; scenario scripts pass syntax/available Mono lint and changed files were
formatted with pinned TypeScript formatter configuration. Package-wide checks
remain dependency-blocked (`@cordisx/protocol`, `@cordisx/channel-runtime`, Cordis
and Lark SDK declarations); no incompatible Aiden package was forced.

Future runs filter reasoning items out of persisted model event logs; validation
uses only visible answers, command events and tool/storage evidence. Earlier
local temporary runs predate this filter and are not private-reasoning tests.
Do not publish those raw temporary logs. User-visible auto/manual/send/ask/
ask/progress-specific style coverage remains staged; the corrected manual send
and scoped-style runs above supersede earlier blocked manual/final evidence.
Memory-only runs cannot establish all delivery surfaces.

`packages/cli/scripts/channel-memory-model-scenarios.mjs` launches a fresh
`codex exec --ephemeral --sandbox workspace-write --skip-git-repo-check --json`
process for each natural-language incoming request. It preserves the existing
configured model/provider and authentication. It does not copy credentials,
change global configuration, or use approval-bypass flags. When the installed
Codex runtime needs writes outside the outer sandbox, the caller must authorize
the run separately; the model execution still uses its workspace-write sandbox.

The only mock is the platform boundary and thin local `cordisx.mjs` client.
Simulated incoming events go through the real `ChannelAgentAccess` resolver,
`channelMemoryCommand` and `ChannelMemoryStore`. The thin client invokes
`channel memory <action>` over local loopback to that handler. It does **not**
prove the packaged `cordisx` CLI/configured management-RPC composition or a live
adapter. No synthetic administrator or disclosure authority is injected.

Each turn receives only tool syntax and its current user request, not memory
records, previous answers, chosen IDs or preselected actions. The model chooses
search terms, loads records and performs saves/corrections. Memory files are
outside its turn working directory. Loopback tool requests/responses, model
execution events, answers, invocations and actual committed record revisions are
captured separately. These files contain synthetic content only and stay under
the local temporary output directory.

Assertions check actual saves, final-turn get results, answer facts, correction
revision and absence of obsolete facts. A plausible answer without successful
tool evidence cannot pass. Known missing production capabilities are blocked,
never counted as passed even if an answer accidentally contains expected text.

## Reproduce

### Durable methodology and scenario matrix

The Host project owns the runner, assertions and synthetic platform fixture:
`packages/cli/scripts/channel-memory-model-scenarios.mjs`,
`packages/cli/scripts/channel-memory-model-assertions.mjs`,
`tests/fixtures/channel-memory-model-boundary.ts` and
`tests/channel-memory-model-assertions.test.ts`. Temporary evidence is not a
dependency: these source artifacts build a fresh store and model contexts.

- **PERSONA CORE:** `persona-blank-bootstrap` tests actual native startup;
  `persona-account-continuity-control` tests Feishu/Telegram accounts bound to
  Atlas, explicitly confirmed human identity, progressive recall and a separate
  Discord/Nova space with no inherited memory. Registry/bootstrap unit tests
  separately test pinning, rebind and capsule revision behavior.
- **PERSONA STYLE DELIVERY:** `scoped-style-separation` tests configured private
  Chinese versus professional-group English with identical facts;
  `manual-auto-style` tests real manual send receipt and final-response
  generation. Automatic-final outbox composition and ask/progress delivery
  remain unverified: final text generation alone is not transport evidence.
- **MEMORY BEHAVIORS:** save/reset, own-topic group, administrator/new member,
  aliases, timeline, correction, purpose, human linking, guided writing,
  bounded large corpus and one other-person negative control.
- **PROJECT CI/Protocol RELEASE:** dependency installation, package-wide
  typecheck/lint, compatibility/public contracts and release checks. These are
  delivery gates, not persona behavior failures.

Use the owning repository's compatible installed development dependencies
(Node, esbuild, Vitest, TypeScript) and an already configured/authenticated
`codex` executable. No new key, credential copying, global configuration edit
or Darwin-only Aiden package is needed. `MEMORY_SCENARIO_TOOLCHAIN` may point at
any compatible existing node_modules directory; `/tmp` is not required.

For durable local evidence, choose a fresh private output directory outside the
Git checkout and set `MEMORY_SCENARIO_OUTPUT` explicitly. Each run records model
and provider, executable/arguments, assertions, storage/tool events, returned
bytes, tool-call counts, bootstrap time and scenario elapsed time. Bootstrap
cost is separate from retrieval. Repeat selected IDs in another fresh directory
to evaluate repeatability; do not infer semantic recall from alias matching.
Model reasoning events are filtered. Do not commit runtime logs, raw model
outputs, credentials, private transcripts or the temporary loopback token.
Runtime writes outside the enclosing sandbox require explicit approval; an
initialization error with zero tools is a runtime blocker, not persona failure.

```sh
node packages/cli/scripts/channel-memory-model-scenarios.mjs persona-blank-bootstrap persona-account-continuity-control
node packages/cli/scripts/channel-memory-model-scenarios.mjs scoped-style-separation manual-auto-style
npx --no-install vitest run tests/channel-memory-model-assertions.test.ts tests/channel-memory-model-boundary.test.ts tests/channel-memory-native-bootstrap.test.ts tests/channel-memory-personas.test.ts --project core
```

With repository dependencies available:

```sh
node packages/cli/scripts/channel-memory-model-scenarios.mjs
```

With the pre-existing temporary toolchain used for this work:

```sh
MEMORY_SCENARIO_TOOLCHAIN=/tmp/channel-media-tools/node_modules \
  node packages/cli/scripts/channel-memory-model-scenarios.mjs save-reset-recall
```

Optional positional scenario IDs select a smaller batch. Set
`MEMORY_SCENARIO_OUTPUT` to a fresh private output directory to retain results;
otherwise the runner allocates a directory under the OS temporary directory.
Do not point it at a previous output directory. `results.json` records the
configured model/provider, per-scenario checks and status. Each turn's
`invocation.json` records the exact launch arguments. Ordinary failed scenarios
give a nonzero process exit; known capability gaps appear as `blocked`.

## Scenario coverage

Persona blank-context prototype passed at `/tmp/channel-memory-model-fhCiHG`
using the configured real model. Registry-derived capsule was automatically
attached before each independent turn; no manual persona get was required.
The final turn recognized Atlas and called search/get to retrieve CAPSULE-62.
This tests the bounded builder plus mock initialization delivery only, not
production consumer/native preparation routing, resumed-session deduplication,
safe-turn updates or persona-scoped command dispatch. Those remain blockers.

### Historical initial evidence (2026-11-22 local date)

This section preserves the initial failures and staged architecture, not current
implementation status. The corrected runs in **Current fix-loop evidence**
supersede its own-topic, administrator, identity-confirmation, native bootstrap
and scoped-style blockers. The original `fcnS6t/results.json` style entry remains
failed; use the independent `yfAETg/results.json` scoped-style pass, not an
informal reassessment, as the successful rerun. Likewise use `MCI9NW/results.json`
for actual manual delivery and `f2QdcM/results.json` for strict grant consent.

The configured model is `gpt-6.1-sol`, provider `aiden_local`; this label is read
from the existing configuration, not a claim about server-side model identity.
No credentials are included in this document or evidence fixtures.

- Save/reset/recall passed twice independently. First evidence directory:
  `/tmp/channel-memory-model-VjdLcZ`; repeat:
  `/tmp/channel-memory-model-nnFR8d`. Both model turns called real tools, and the
  recall turn performed `search` then `get` before answering MARIGOLD-73/Tuesday.
- Large corpus: `/tmp/channel-memory-model-aA1i6e`, 240 distractors plus one
  target, preloaded through the real command independently of model prompting.
  Bootstrap took 2,486.6 ms. The model chose `search-page` (701 response bytes)
  then `get` (813 bytes), totaling two calls and 1,514 returned bytes, and
  answered ORCHID-204 correctly. This is successful project-alias keyword
  routing for a paraphrased question, **not** general semantic search evidence.
  Bootstrap cost is excluded from the measured retrieval call/byte counts.
- The initial unapproved attempt could not initialize Codex runtime writes and
  produced zero tool events. Only the separately approved executions establish
  real-model evidence; that failed startup is not counted as a recall attempt.
- First batch evidence: `/tmp/channel-memory-model-KleifK`. Project alias,
  collaboration timeline, latest corrected decision and conversation purpose
  passed using save/search/get (correction used update revision 2). The minimal
  other-person negative control passed. Own private topic in a group,
  natural-language A→B administrator grant/new-member recall and cross-platform
  linking were blocked with absent authority/identity workflows, not counted as
  successful useful behaviors. Together with save/reset, the initial nine
  scenarios produced six passes and three blocked scenarios.
- Guide discovery and messy-note organization passed:
  `/tmp/channel-memory-model-oTyJ8W`. The model invoked guide topics and searched
  before writing; exactly one record retained `project-northstar`, date,
  reliability-test reason and SYN-417 source. Chatter was excluded; the next
  model process read and answered all facts. There were six tool calls for the
  save turn and four for recall. This tests instruction discovery/organization,
  not transactional reorganization or supersedes support.
- Style-context scenario: `/tmp/channel-memory-model-CQP9Sv`, blocked. The
  model saved style text as an ordinary preference and incorrectly described it
  as configured; private recall answered in English instead of the requested
  casual Chinese, and group recall could not access the fact. This is observed
  failure, not profile support. Guidance now explicitly distinguishes saved
  preferences from active editable context profiles; that clarification has
  not been revalidated with a model rerun. Separate profile storage/merge/unset
  and boot-capsule behavior remain design-only.

Latest architecture supersedes the earlier single-global-persona restriction:
multiple spaces each retain a continuous assistant identity across their bound
bot accounts, with contextual adaptation. The style scenario predates this
revision and does not establish persona routing or profile integration. Human
entity scopes remain distinct. A new deterministic registry test covers two
fake adapters sharing one space and a separate-persona control, but no real-model
persona continuity run has been performed: production routing and authenticated
human cross-account recall eligibility are not integrated. Prior evidence is
unchanged and must not be relabeled as persona end-to-end validation.

Distilled experience promotion is staged as a selectable, known-blocked scenario
`distilled-experience-promotion`, not run or passed. It mixes local trivia,
recurrent cross-context lessons and explicit promotion acceptance. Actual global
lesson storage, separately authorized provenance and the proposed 2,048-byte
root capsule are missing; guide assertions only establish that tools describe
these limits honestly, not that promotion or budgeting works.

Focused deterministic validation after these additions: 18 tests pass across
memory, model-boundary, assertion and existing conversation-tool tests. Strict
storage/policy/files/guide typecheck passes. No full suite or live adapter run.

Temporary evidence is local and may be cleaned by the OS. The committed harness
is the reproducible artifact; no raw private conversations are checked in.

- Explicit save and recall after independent model-context reset.
- Alice's own private topic requested in a group (initially blocked; corrected
  runs passed, see current evidence).
- Natural-language A→B full-source grant and new member recall (initially
  blocked; strict corrected run passed, see current evidence).
- Project alias with different recall keyword.
- Collaboration timeline and dated participants.
- Correction of an existing decision and latest-value recall.
- Conversation-purpose recall.
- Cross-platform identity linking (initially blocked; dual-account confirmation
  corrected runs passed, see current evidence).
- One minimal negative control: Bob cannot retrieve Alice's private code.

The remaining public contracts and integration gates are recorded in the
[implementation ledger](channel-memory-design.md#required-owner-changes-and-remaining-gates).
The harness deliberately does not fabricate them to make the scenarios green.
