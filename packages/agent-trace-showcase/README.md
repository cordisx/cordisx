# CordisX Agent Trace Showcase

Agent Trace Showcase is a development and validation plugin for inspecting how
a CordisX Agent session evolves. It opens a session-scoped Timeline from the
current Codex conversation header without replacing the conversation, changing
the app URL, or taking ownership of Codex UI nodes.

## Timeline

The Timeline groups records by turn and step and projects four lanes:

- **Input** for observed user input;
- **Model** for model lifecycle and output records;
- **Tools** for tool and command activity;
- **Injection / Prompt** for plugin delivery and prompt contributions.

Sequence and time views, search, source/type/phase filters, record details, and
an explicit 500-row rendering boundary make larger sessions inspectable. The
page distinguishes observed, CordisX-authored, and inferred facts and displays
the current adapter capability and data completeness. A projected or forwarded
record is never described as model-consumed unless the public event contract
provides proof.

## Fixture and live modes

Fixture mode uses one centralized deterministic provider. It can demonstrate
the complete Timeline interaction and permission states without reading or
modifying a real conversation. Fixture rows are visibly labeled and cannot be
mistaken for live Agent events.

Live mode reads only the public, session-scoped Agent event ledger. It can show
partial history when the Host has a public ledger but the current Codex
connection cannot forward Agent messages. It never falls back to a raw bridge,
private adapter store, DOM selector, or parallel trace ledger.

The plugin is development-only and opt-in. CordisX setup continues to create an
empty `plugins: []` configuration.

## Explicit Agent demonstrations

Nothing is injected when the plugin loads, the page opens, or the session
changes. Each operation requires a visible user click:

- **Followup** queues a waking message for the next turn;
- **Steer** queues a waking message for the next step;
- **Inject** queues a non-waking message for the next step;
- **Pre-step append** registers a one-shot, source-attributed append handler;
- **Prompt section** registers a named system-prompt section;
- **Prompt context** registers session-scoped system-prompt context.

Queued deliveries use owner- and generation-fenced public handles for cancel
and `clearPending`. Pre-step and prompt contributions are removed through their
public disposables. Page close, plugin block, generation replacement, and fiber
disposal clean up the entry, route, subscriptions, and pending contributions.

## Permissions and honest availability

Live mode declares four optional capabilities, all enforced by the Host
Permission Broker:

- `agent.events.read`;
- `agent.messages.append`;
- `agent.prompt.section`;
- `agent.prompt.context`.

Allow, ask, and deny remain Host decisions; the plugin does not persist grants
or implement a private permission prompt. If ledger access is denied or fails,
the live controls are disabled because their result could not be audited.

When the Host reports `current-connection-client-unavailable`, the page remains
honestly partial. A user-triggered delivery may be recorded as requested,
permission-checked, queued, and then failed. That validates the public control
and ledger path, not successful Codex forwarding and not model consumption.

Architecture, contract mapping, lifecycle, and validation boundaries are
documented in the
[Agent Trace Showcase design](https://github.com/cordisx/cordisx/blob/main/.agents/docs/agent-trace-showcase.md).
