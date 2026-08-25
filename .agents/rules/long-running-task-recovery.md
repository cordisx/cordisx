# Long-running task recovery

Use this rule when a coordinated CordisX task is interrupted, a task client
shows incomplete history, or a restart leaves several worktrees unloaded. Its
purpose is to preserve already-completed work and resume safely; it is not a
release shortcut.

## Establish a trustworthy record first

- Do not infer that visible-history loss means that work or messages were
  deleted. Preserve the original task: do not delete, archive, reset, or
  overwrite it while its state is being diagnosed.
- Treat a task-list preview, a paginated history response, and a compaction
  projection as views of task data, not interchangeable sources of truth. If
  they disagree, state the discrepancy explicitly and use independently
  verifiable durable evidence before making delivery claims.
- Do not put raw user conversations, account information, credentials, local
  paths, screenshots containing private content, or task identifiers into a
  repository document or a broad handoff. Extract only reusable engineering
  facts.
- A history fork is not a repair mechanism. It can only inherit the history
  that the source service can read. When that view is incomplete, create a
  clean continuation only with a short, verified, sanitized handoff.

## Audit before resuming a worktree

For every affected owning task, check these facts in this order:

1. The worktree status, branch, untracked files, conflict state, and any
   recoverable local changes. Never discard or reset another task's changes to
   make a restart look clean.
2. Fetch the owning repository's remote first, then record the resulting
   `origin/main` SHA before treating its mainline, relevant protocol baseline,
   open PRs, CI result, or any formal merge as current. A locally stale
   tracking ref is not recovery evidence.
3. Whether the original scope is already merged, still locally in progress,
   blocked by an upstream merge, or obsolete. Resume only work that remains
   necessary.
4. Repository-local `AGENTS.md` and maintenance rules before editing the
   owning repository. The mono repository coordinates exact gitlinks; it does
   not absorb product-code or documentation changes.

Report those states separately as **implemented**, **verified**,
**experimental**, **blocked**, and **planned**. A local checkpoint, a feature
head, or a passing focused test is not a formal merge.

## Reconstruct a requirement ledger, not only a commit ledger

Before resuming implementation, rewrite the user-visible requirements as one
bounded ledger. Mark every item `unimplemented`, `implemented`, `verified`, or
`formally merged`, and attach the evidence that justifies the state. Include
late feedback and screenshot annotations; a newer PR does not erase an older
unresolved requirement.

The ledger is closed by observable behavior, not by activity. A passing unit
test, a clean checkpoint, a PR, or one corrected screenshot may advance an
item, but none of them closes adjacent items automatically. When an owner turn
repeatedly returns an incomplete status without new durable evidence, stop the
turn, preserve its worktree, split the next action into a smaller bounded
checkpoint, and assign an active owner. Never let an `in progress` label stand
in for actual tool or file progress.

## Build a restart handoff that prevents duplicate work

Each resumed task receives one concise handoff containing:

- its owning repository and exclusive files or surfaces;
- the user-visible decision that is already settled;
- the last usable protocol and Host *formal* commits, not speculative heads;
- its dependency order and the exact event that unblocks UI integration;
- required validation, PR, CI, head-fenced merge, and mono-pointer boundary;
- a reminder to preserve interrupted worktree changes and to re-audit remote
  state before continuing.

Do not give every task the same broad implementation scope. Keep a single
owner for shared Manager DOM, live-smoke scripts, authorization UI, and any
other high-conflict surface. Parallel tasks may build isolated schema, store,
primitive, documentation, or test work, but must consume upstream work only
after its formal merge commit exists.

## Respect CordisX dependency order during recovery

1. Land public protocol or schema changes first when they are externally
   observable.
2. Land the Host primitive or platform implementation next, including its
   full owning-repository validation.
3. Rebase consumers on that formal merge before they change shared Manager
   rendering or real-renderer smoke coverage.
4. Run final cross-feature validation only after the compatible owner commits
   exist.
5. Update CordisXMono in a separate final commit that pins exact compatible
   commits. Keep `roadmap` as `update = none` unless separately authorized.

For a user-visible claim, require the scoped tests plus a real isolated
`app://` renderer check when the change affects Manager DOM, a launcher, a
native-surface adapter, or a lifecycle boundary. Do not substitute JSDOM,
stale screenshots, or a previous feature branch for current formal evidence.

## Close the incident without hiding uncertainty

- A resumed task that reaches an old final answer is not automatically current:
  re-read its remote merge, CI, and gitlink state.
- Keep unavailable integrations honest. A schema, simulator, or Host-safe
  descriptor does not prove a live credential broker, external platform
  adapter, installer, or connection.
- If the task client still cannot show the historical messages after a normal
  reload, preserve evidence and use the product's support and data-retention
  path. Continue delivery in a clean task with the verified handoff rather
  than repeatedly forking the damaged source.
