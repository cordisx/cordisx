# Documentation maintenance

This rule defines the Host repository's document layout. Organization-wide
ownership belongs to CordisXMono; public plugin contracts belong to
`cordisx-protocol`. Do not copy either source here.

## Entry points and document roles

- Root `README` files introduce the product and link to the public documentation
  index. `CONTRIBUTING.md` covers contribution terms and routes maintainers to
  `AGENTS.md`; `AGENTS.md` is a short instruction entry point.
- `.agents/rules` contains durable maintenance and delivery instructions.
- `.agents/docs/README.md` is the complete, grouped public document index.
  Guides explain a task; references own current implementation boundaries;
  historical records preserve dated decisions or evidence with explicit status.
  Keep product documentation under this root rather than creating a second
  `docs/` tree.
- Package, example, template, and fixture READMEs stay beside their artifacts.
  Their quick starts and bounded summaries are useful at those entry points;
  link to the full reference instead of copying its specification.
- `skills/cordisx`, `skills/cordisx-qa`, and
  `skills/cordisx-plugin-development` are maintained Host product artifacts.
  Each directory is a self-contained packaged Skill with its own metadata and
  provenance. Keep relative links to compatible sibling Skills valid after the
  complete bundle is installed. The separately owned `skills/cordisx-docs`
  snapshot provides documentation navigation; none of these Skill artifacts is
  another source of normative product or plugin contracts.
- Put reusable user experience in the owning `.agents/docs` guide as Q&A with
  applicability and evidence. Do not publish raw conversations or private logs,
  and do not record every interaction automatically. When experience becomes a
  supported product rule, update or link the owning reference instead of keeping
  a competing rule in a Skill.

## Authority and updates

Keep architecture.md as an ownership and composition overview. Update the
owning topic reference when implementation details change; update the overview
only when a plane, dependency, or boundary changes. Public API definitions and
version compatibility remain in Protocol; Host references explain their
implementation and link to the relevant authority.

Keep live owner assignments, temporary file locks, PR queues, and restart
instructions in the current task handoff. A useful dated record may retain
those facts as history, but must not instruct future work to obey an old lock.
Mark historical plans and delivery ledgers as dated records, identify their
current-reference successors, and preserve their original evidence states.
A documentation move does not establish implementation, live verification,
formal merge, publication, or user acceptance.

When splitting a document, move unique material once, preserve old linked
headings as navigation where needed, and update the public index with clickable
links. Avoid copying whole sections into a second authority. Retain distinct
version, lifecycle, failure, and verification boundaries during the move.

## Documentation validation

For documentation-only changes, check the diff, changed local links and
heading anchors, index coverage, and preserved content after a move. Do not
launch an App or run product tests solely for prose or navigation changes.
Behavior changes retain the normal owning-repository validation requirements;
a document edit cannot waive those gates.
