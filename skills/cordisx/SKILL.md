---
name: cordisx
description: Route and complete CordisX user requests from one goal-oriented entry point. Use for installation, startup, configuration, Marketplace sources, installing or managing plugins, current CordisX documentation, experience-based Q&A, and creating, updating, debugging, or verifying a CordisX plugin. Select the relevant bundled guidance without asking the user to choose a lower-level Skill.
---

# CordisX

Start from the user's goal. Route to the smallest relevant bundled Skill, then
complete the work in the current task. Do not expose Skill selection as a
prerequisite or create another task merely to invoke a specialist.

The bundled revision and owning source for this entry are recorded in
[version.json](version.json).

## Choose guidance

- For installation, startup, configuration, Marketplace sources, installed
  plugin management, current or version-specific behavior, commands,
  compatibility, architecture, or public contracts, read
  [cordisx-docs](../cordisx-docs/SKILL.md).
- For practical experience, known pitfalls, contextual tradeoffs, and
  evidence-backed workarounds, read
  [cordisx-qa](../cordisx-qa/SKILL.md).
- For plugin feasibility, creation, implementation, debugging, packaging, or
  verification, read
  [cordisx-plugin-development](../cordisx-plugin-development/SKILL.md).
- For a mixed request, use each relevant guide in dependency order. Resolve
  product facts before applying experience or changing plugin code.

If a referenced bundled Skill is unavailable, say which guidance is missing
and use the owning public documentation when it is accessible. Do not pretend
that every third-party Skill picker hides or automatically selects these
entries; this routing behavior applies when the `cordisx` entry is invoked.
Keep the sibling Skills normally discoverable and do not disable implicit Skill
selection.

## Preserve source roles

- Treat versioned documentation and public contracts as authority for product
  behavior. Do not turn a workaround or one user's observation into a product
  guarantee.
- Treat Q&A as contextual experience. State its applicability and evidence,
  and link the governing documentation when a rule has become normative.
- Keep repository contribution conventions separate from plugin admission.
  A third-party plugin may use a legal unscoped package name or the publisher's
  own scope; CordisX repository branches, scopes, approvals, and release steps
  apply only when that repository actually owns the work.
- Treat the user's requested goal as authorization for its normal necessary
  steps within the active tool, repository, and Host boundaries; do not ask for
  confirmation again at every reversible step. Do not infer unrelated grants
  or extend the request to an App launch, upload, publication, or release.

## Answer and act

For an informational request, remain read-only unless the user asks for a
change. For an installation, startup, configuration, source, or plugin-management
request, follow the version-compatible Docs instructions and perform the normal
steps covered by the request. Reuse available context and authorization instead
of asking the user to repeat setup details or approve each routine step.

For implementation, make the smallest supported change and select evidence
that matches the claim. Do not launch a native App merely because CordisX is
involved; native evidence is needed only for behavior that depends on the real
native Host path and when launching it is authorized.

Report state precisely. Keep these terms distinct:

- **implemented**: the source change exists;
- **tested**: named checks passed for the stated scope;
- **merged**: the owning repository accepted the change;
- **published**: a release artifact is available from its distribution source;
- **installed**: the relevant environment contains that artifact.

Do not imply a later state from an earlier one.
