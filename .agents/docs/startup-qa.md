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

## Will CordisX require another sign-in?

The default launch opens an independent Codex window while retaining the
existing account, conversations, projects, and model configuration. Explicit
Host-data isolation is an advanced profile option.

## Will CordisX overwrite my existing skills?

No. The default launch uses `shared` data mode and continues to discover the
user's personal skills and skills in the current repository. CordisX manages
only its bundled plugin-development skill; it does not replace or remove the
user's existing content.

## What is the difference between `shared` and `host-isolated`?

The default `shared` mode uses an independent CordisX window and Chromium
profile while retaining the current user's Codex data and personal skills.

`host-isolated` gives that CordisX profile a separate Host home, so personal
skills from the user's real home are not discovered. Skills in the current
repository and CordisX's bundled plugin-development skill remain available.
Use this mode only when account, conversation, or other Host data must also be
isolated:

```bash
npx cordisx@beta codex work --data host-isolated
```

## Can I ask Codex to build a plugin immediately after launch?

Yes. Describe the feature in natural language—for example, “Make the send
button launch fullscreen confetti when it is clicked.” The bundled
plugin-development skill handles project preparation, implementation,
Playground launch, and verification.

## Where are the complete launcher options?

See the [complete beta guide](getting-started.md#npm-beta-installation) for
profiles, diagnostics, global installation, external providers, and advanced
launch modes.
