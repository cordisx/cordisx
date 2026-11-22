# Local runtime resources

These are maintenance and operator rules for local installation, previews,
and validation. They do not claim that every released Host automatically
enforces retention, deduplicates caches, or copies authentication. Follow the
installed runner's documented behavior and the user's current instructions.

## One installation root per environment

- Use the environment's existing version-installation root for installed
  runtime packages. Record it once and reuse it across tasks; do not introduce
  another installation tree for each fix. The exact path and retention limits
  are local preferences, not a public requirement for every operating system.
- Name released installations with the exact package version. Identify an
  unpublished preview with its package version and source commit, for example
  `<package-version>-preview-<short-commit>`. Record the full commit and dirty
  state; a preview directory name is not proof of publication or a clean build.
- Keep runtime packages separate from configuration, login state, service
  databases, source worktrees, and reports. Build workspaces and temporary
  dependencies can live on the selected evaluation volume; an installed
  preview entry must not silently depend on a disposable build directory.
- Use an explicit finite released-version retention policy and retire previews
  when their validation ends or a replacement is ready. Before removal, check
  live processes, entry points, symlinks, and unfinished work. Preserve an
  active version and any still-needed rollback candidate until safe to retire.

## Reuse configuration without sharing a live test instance

- Prefer the existing authorized preview during feedback. Coordinate ownership
  before another task navigates it, changes its code, or restarts it. Separate
  worktrees alone do not isolate ports, processes, or state.
- Identify which login the check needs: Codex account/configuration, Chromium
  web session, and provider/service authentication are separate. Read back the
  required state before validation; an input field or an existing auth file
  does not prove authenticated behavior.
- Use documented shared account/configuration roots where supported. An empty
  `HOME` or `host-isolated` profile is suitable for a synthetic fixture, but
  does not validate the user's configured environment. Do not ask the user to
  repeat login solely because the test setup discarded existing configuration.
- If the user authorizes a private configuration snapshot, copy a consistent
  set of the required state and credential references, verify the snapshot,
  and keep it out of public worktrees and artifacts. Never concurrently open
  the live system Chromium profile. Do not assume a copied cookie database
  works with a different OS credential store or account root.
- Disable automatic Channel reception, scheduled work, and other autonomous
  consumers in a copied test instance unless their use is explicitly part of
  the authorized test. Preserve the original instance and its configuration.

## Reuse native test dependencies

- Reuse the installed native App executable and an authorized, configured
  preview for ordinary UI checks. A new empty `HOME` or `CODEX_HOME` can cause
  the native App to expand document, browser, and computer-use dependencies
  again. Do not create a fresh full environment for every parallel task or retry.
- Keep read-only runtime dependencies separate from writable account and test
  state. Reuse only verified compatible, immutable, account-independent inputs
  through a supported runtime mechanism. Do not guess cache environment
  variables or share an entire writable home, cookie store, or account database
  by symlink. The absence of supported cache redirection is not permission to
  bypass state isolation.
- Give a reused interactive preview one owner at a time. Independent unit,
  Mock, and read-only protocol checks should not launch full Apps as a side
  effect. Account/security isolation and destructive or cold-start checks can
  require a separate environment; record that need and its resource lifecycle.
- Check existing runtimes and prepared artifacts before downloading or expanding
  large dependencies. Use the selected evaluation volume when another copy is
  necessary. After an owned run finishes, remove unused downloaded runtimes,
  browser caches, compilation output, and candidate dependencies; preserve
  authentication, configuration, transcripts, logs, evidence, and shared inputs.

## Bound rebuildable caches

- Distinguish compilation output from logs, history keys, credentials, account
  data, and databases. A parent directory named `cache` does not make every
  descendant disposable. Delete only the identified rebuildable artifact set.
- Give compilation caches both a count and byte budget. For a small local
  preview, three recent graphs and 256 MiB is a practical operator policy;
  record any different policy. These are maintenance defaults, not existing
  Host configuration fields. Finished disposable runs need no old graph cache.
- Reuse unchanged build inputs and exclude launch-specific or volatile values
  from a stable cache key when they do not affect compiled output. Preserve
  compatibility, permission, and identity checks. Avoid storing a complete
  duplicate resource graph for a small change where content-addressed reuse
  is available; do not claim such reuse before it is implemented and checked.
- Prune after a successful replacement or when an owned instance is idle.
  Protect active or leased artifacts and concurrent writes; use atomic writes,
  constrain cleanup to the owned cache root, and reject redirected paths.
  Unknown use is a reason to retain an artifact, not to stop a healthy App.
- Automate the agreed policy in the owning launcher or cleanup script when
  practical. A prompt reminder alone is not automatic retention. Report a
  skipped cleanup or error honestly; an optional maintenance failure must not
  hide the problem or prevent otherwise valid startup.

## Finish validation with cleanup

Record the owning task, source, installed candidate, configuration scope,
processes, and temporary resource paths before launch. At completion or failure,
save necessary reports and recovery information, release only owned processes,
then remove unused runtime copies and rebuildable artifacts. Preserve source,
Git data, shared dependencies, user state, and evidence still needed for work.
Report actual removed and retained resources and the reason for retention;
dispatching cleanup is not completion.

See [functional delivery](functional-delivery.md#keep-preview-launches-honest)
for preview claims and native launch boundaries,
[local candidate acceptance](../docs/local-candidate-acceptance.md) for the
runner's actual state and cleanup behavior, and
[Host testing](../docs/testing.md) for proportionate validation.

Keep private paths, identities, credentials, raw conversations, and internal
deployment examples in local records. A documentation update establishes a
maintenance rule; it is not implementation, installation, or publication.
