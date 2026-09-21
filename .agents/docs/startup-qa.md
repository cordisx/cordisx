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
