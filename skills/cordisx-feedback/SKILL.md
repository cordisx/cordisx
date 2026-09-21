---
name: cordisx-feedback
description: Collect a private, bounded CordisX diagnostic bundle when the user wants to report, package, or investigate a CordisX problem, startup failure, injection issue, cleanup warning, or suspicious log sequence. Use this Skill when the user asks to prepare feedback or logs for maintainers, including when they only describe a screenshot. It creates local diagnostics for review; it never uploads or sends them without separate explicit authorization.
---

# CordisX Feedback

Use `cordisx feedback` to prepare a local diagnostic bundle without collecting
conversation content, credentials, complete configuration, or unrelated files.

Reuse supplied context and ask only for a short user description, approximate
time, or app/profile when the CLI cannot resolve them. A screenshot
transcription is a `user_report`, never a product log.

## Collect

Check that the installed CLI supports `cordisx feedback`, then normally run:

```bash
cordisx feedback collect --recent --json
```

Add a bounded app/profile, time, or `--description-file` only when needed. Do
not run `cordisx config`, scan HOME or a project, or use unbounded `cordisx
logs`; the CLI owns selection, redaction, validation, and limits.

## Preview

Read the manifest summary and explain included and excluded categories, missing
or truncated sources, selected time window and correlation confidence,
redactions, final size, and local staging directory. A transient target-list
fetch failure followed by ready and injected is not an injection failure;
describe later cleanup degradation separately.

## Export

Only after the user asks for an archive, run:

```bash
cordisx feedback export <bundle-directory> --json
```

Show the local archive and verification result. Do not upload, message, create
an issue, or contact a maintainer without separately explicit authorization.

On failure, report the CLI's safe error. Do not substitute raw file collection,
delete locks, restart CordisX, change config, or request broader access.
