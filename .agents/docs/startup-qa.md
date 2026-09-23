# CordisX startup Q&A

## How do I find out why CordisX did not start?

Run the read-only diagnostic:

```bash
npx cordisx@beta doctor
```

`ready` means CordisX found a supported Host and resolved a launch plan.
`unavailable` includes a diagnostic explaining what is missing or could not be
resolved.

## Do I need to run setup first?

No. The first normal launch creates the CordisX configuration when needed.

## Why does the command include `@beta`?

The functional prerelease is currently published on the `beta` channel. The
unqualified npm package remains a name reservation until the first stable
release.

## What if the Node.js version is unsupported?

CordisX currently requires Node.js 22.19 or newer. Update Node.js and run the
launch command again.

## What if CordisX cannot find Codex Desktop?

Install Codex Desktop first. CordisX checks the supported macOS application
locations automatically. Non-standard application locations can be selected
with the advanced launcher options in the
[complete beta guide](getting-started.md#npm-beta-installation).

## What if an upgraded install reports a legacy start lock?

First make sure every older CordisX `start`, `stop`, or `restart` command for
the selected app and profile has exited. Then run the intended mutating command
once with `--recover-startup`, for example:

```bash
npx cordisx@beta start codex default --recover-startup
```

The flag converts only the selected profile's legacy lock into the current
kernel-backed startup fence. CordisX does not infer that an empty or old lock
file is abandoned, because an older detached startup may not have published
its state yet. Do not use the flag while an older CordisX command is still
running.

## What if the launch reports a Codex profile launch lock?

Each independent Chromium profile is reserved by a launch lock directory next
to it, `<profile>.cordisx-launch-lock`, whose `owner.json` records the owning
launcher process and its start time. A normal `stop`, `restart`, or launcher
exit releases it.

When that launcher no longer exists, for example after `kill -9`, a crash, or
a reboot, the next launch reclaims a version-2 lock automatically when no Host
holder remains and the process scan is unambiguous, and writes
`reclaimed stale Codex profile launch lock` to `host.log`. That case needs no
manual cleanup. `--recover-startup` is unrelated: it converts only the legacy
`start.lock` under `~/.cordisx/run/<app>/<profile>/`.

The launch still fails closed, without deleting anything, when the message
says:

- `in use by launcher process <pid>`: that launcher is alive. Stop it first
  with `cordisx stop` for a background instance, or end the foreground
  `cordisx run`; do not remove the lock.
- `still used by process <pid>`: the launcher exited, but a Host tree launched
  with that profile is still running. Stop those processes, then launch again.
- `unrecognized launch lock` or `requires inspection`: the owner record is
  missing, belongs to another profile path, or its process identity could not
  be verified. Inspect the named lock directory and remove it only after
  confirming that nothing uses the profile.
- `Legacy v1 locks require manual cleanup`: stop all older CordisX launchers
  and Hosts using that profile before removing the named lock directory. Old
  reclaimers do not participate in the new mutex; do not migrate a v1 lock
  while they might still be running.
- `another launch or release operation`: retry after that operation completes.

Do not remove `<profile>.cordisx-launch-mutex`. Ambiguous process arguments
(including spaced paths or trailing arguments) conservatively block recovery,
even for a potentially unrelated profile; inspect before manual cleanup.

The reclaim rule is defined in the
[launcher runtime reference](launcher-runtime.md#host-profiles-cleanup-and-skill-deployment).
When a background start fails for any of these reasons, `cordisx start` and
`cordisx status` report that reason instead of a generic supervisor exit.

## Will CordisX require another sign-in?

The default launch opens an independent Codex window while retaining the
existing account, conversations, projects, and model configuration. Explicit
Host-data isolation is an advanced profile option.

## Will CordisX overwrite my existing Skills?

No. The default launch uses `shared` data mode and continues to discover the
user's personal Skills and Skills in the current repository. A CordisX version
that bundles managed Skills updates only CordisX-owned copies whose management
marker and content still match; an unmanaged or user-modified directory is
preserved and reported instead of being silently overwritten. Check the
installed version before assuming a particular bundled entry is available.

## What is the difference between `shared` and `host-isolated`?

The default `shared` mode uses an independent CordisX window and Chromium
profile while retaining the current user's Codex data and personal skills.

`host-isolated` gives that CordisX profile a separate Host home, so personal
Skills from the user's real home are not discovered. Skills in the current
repository and the compatible CordisX Skills bundled by the installed version
remain available.

Use this mode only when account, conversation, or other Host data must also be
isolated:

```bash
npx cordisx@beta codex work --data host-isolated
```

## Can I ask Codex to build a plugin immediately after launch?

Yes. Describe the feature in natural language—for example, “Make the send
button launch fullscreen confetti when it is clicked.” Start with the bundled
`cordisx` entry when it is available; it selects the plugin-development
guidance without asking you to choose a lower-level Skill. It uses the checks
appropriate to the requested behavior and does not launch a native App solely
for documentation or static changes.

## Where can I find answers about usage choices and known pitfalls?

See the [user experience Q&A](user-experience-qa.md). It records contextual,
evidence-backed answers and links to the governing documentation instead of
turning one incident into a universal product rule.

## Where are the complete launcher options?

See the [complete beta guide](getting-started.md#npm-beta-installation) for
profiles, diagnostics, global installation, external providers, and advanced
launch modes.
