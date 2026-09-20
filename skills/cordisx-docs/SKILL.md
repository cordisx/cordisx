---
name: cordisx-docs
description: Find standard CordisX documentation for usage, configuration, supported capabilities, and versioned plugin contracts. Use when a CordisX answer or action needs an authoritative reference; practical experience belongs to cordisx-qa.
---

# CordisX Documentation

Read the [task index](https://raw.githubusercontent.com/cordisx/docs/main/skills/index.md)
and follow only the route relevant to the user's request. Fetch the linked owner
document rather than answering product commands from memory or downloading the
whole documentation set.

- For adoption, follow the Host entry and preserve existing setup. Do not run
  installation merely because the user asks a question.
- For an existing plugin, use the Marketplace and the user's selected source.
  Read that plugin's own guide for service configuration and login.
- For practical questions, workarounds, or lessons from earlier use, consult
  `cordisx-qa` when available. Use the owner documentation to check any product
  claims; a reported experience does not redefine the contract.
- For plugin implementation, use `cordisx-plugin-development` when available;
  this Skill supplies references, not a duplicate development workflow.
- If the user provides a private entry, read it only in the authorized context.
  Keep private URLs, source metadata, and credentials out of public files.

Read product guides, not repository maintenance rules, for end-user tasks.
Distinguish required compatibility and runtime constraints from optional advice
and first-party conventions. Do not require third-party developers to adopt
CordisX's organization scope, repository layout, approval process, or release
workflow. Consult contribution rules only when the user is contributing to that
specific repository. If a companion Skill is unavailable, follow the relevant
owner guide directly; do not make installing another Skill a prerequisite.

Resolve relative links against the containing document's URL. A prerequisite
already completed need not be performed again. An inaccessible link is a missing
reference, not permission to guess endpoints or commands. Documentation on `main`
may be newer than the installed CLI; check help and the installed release tag
before applying version-sensitive instructions.

Distinguish installation, running Host, plugin activation, permission state, and
provider-account login. Documentation discovery does not authorize additional
effects. Cite the source used and report what was actually verified.
