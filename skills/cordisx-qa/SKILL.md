---
name: cordisx-qa
description: Answer and, when explicitly requested, record CordisX user-experience questions with context and evidence. Use for common usage questions, known pitfalls, practical tradeoffs, observed workarounds, and questions about what is implemented, tested, released, or installed. This is Question & Answer guidance, not software quality assurance or a substitute for versioned CordisX documentation.
---

# CordisX User Experience Q&A

Answer the user's actual question with the shortest evidence-backed explanation
that resolves it. Q&A captures contextual product experience; it does not own
the standard product contract. Questions about what CordisX officially supports
or how a command works belong to Docs even when phrased as a question. The
bundled revision and owning source are recorded in
[version.json](version.json).

## Find the answer

1. Identify the relevant CordisX version, Host, operating mode, project shape,
   and action when they materially affect the answer. Reuse facts already in
   context instead of asking for them again.
2. For product commands, compatibility, configuration, architecture, security,
   or public contracts, read [cordisx-docs](../cordisx-docs/SKILL.md) first.
3. Search the owning Host user guides before inventing a new answer. Start with
   the [user experience Q&A](https://github.com/cordisx/cordisx/blob/main/.agents/docs/user-experience-qa.md)
   and use the linked
   [startup Q&A](https://github.com/cordisx/cordisx/blob/main/.agents/docs/startup-qa.md)
   for launch and setup questions.
4. Prefer evidence from the applicable version's docs, source, diagnostics,
   focused checks, or an explicitly described observation. Keep a suggestion
   labeled as a suggestion.

## Answer format

Use a natural answer for simple questions. When context or evidence matters,
make these elements clear without forcing a rigid template:

- **Answer:** the practical resolution or decision;
- **Applies when:** version, platform, mode, or project conditions;
- **Basis:** the documentation, diagnostic, test, or observation supporting it;
- **Status:** implemented, tested, merged, published, or installed, when the
  distinction matters.

Do not generalize one incident into a universal rule. If reliable evidence is
missing or conflicting, say what is known, what remains uncertain, and the
smallest read-only check that would distinguish the possibilities.

## Record experience only on request

Record a new Q&A entry when the user asks to preserve or update the experience.
Use their requested destination or an existing personal or project Q&A record.
For a contribution to shared product documentation, use the existing owner
document when one covers the topic; the Host user-experience Q&A is for
cross-topic experience that has no better owner.

If the shared source is unavailable or not writable, save a local Markdown
Q&A draft in the current authorized workspace or notes location and report its
path. Personal notes do not require access to CordisX's repositories. Do not
write user experience into an installed, launcher-managed Skill directory or
claim that a local draft has been published to the shared documentation.

Write the entry as a real question and answer. Include its applicability and
evidence, link the normative documentation, and retain meaningful limitations
or failed approaches. When repeated evidence becomes a supported product rule,
update or link the owning documentation rather than maintaining a competing
rule in Q&A.

Do not publish raw conversations, private logs, credentials, account details,
local paths, task identifiers, or internal-only data. Redact or summarize the
minimum reusable fact. Do not automatically record every interaction, and do
not claim an edit was recorded, merged, published, or installed without direct
evidence for that state.

## Boundaries

- Informational queries are read-only. They do not authorize configuration
  changes, grants, App launches, uploads, publishing, or releases.
- Q&A does not grant access or turn an unavailable capability into an available
  one. Use existing authorization and report the missing boundary honestly.
- Repository branch names, package scopes, approvals, and release processes
  apply only to their owning repository. Third-party plugins may use legal
  unscoped names or the publisher's own scope.
- For plugin implementation or debugging, use
  [cordisx-plugin-development](../cordisx-plugin-development/SKILL.md) after
  resolving the user's question.
