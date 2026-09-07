# Host Agent task creation

The optional `ctx.agentTasks` service implements the
[Protocol agent-task/v1 contract](https://github.com/cordisx/cordisx-protocol/blob/d657899e763a524efe97a137396642fbcb167f47/.agents/docs/agent-task/README.md).
It uses the existing Entity registry, Agent admission, authenticated CLI tools
and native Session persistence. Product assignment records remain plugin-owned.

The production plugin mount binds the service to the current owner and existing
Agent permissions. The launcher validates accessible absolute directories and
reads inherited context from the same owner's native Session binding. Project
selection currently returns `project-unavailable`: no native project membership
resolver has been adopted. An explicit directory is supported without creating a
worktree or changing another Session's cwd.

Creation passes the resolved directory to native `thread/start` and verifies
`thread.cwd`. A mismatch retains the native binding and returns
`context-unavailable` with the partial SessionId; no first input is submitted.
The exact Entity setup reaches native developer instructions, then the declared
command is bound to that Session before the first admission. Tool resource
registration must finish successfully during preflight.

Operation intent and phase checkpoints use Host-protected documents in the
existing native Session owner store. Profile and stable plugin source identity
scope the record; renderer/module generations do not erase it. A compare-and-swap
intent claim prevents another renderer from repeating native creation. Equal
in-process requests share one promise. Any unknown native creation/submission
stays `reconciliation-required`; this implementation does not automatically
reconcile unknown outcomes or resubmit them. Queries are read-only and preserve
runtime-unavailable state after restart until the runtime has a live observation.

## Desktop 8109 audit

On 2026-09-08 the installed `/Applications/ChatGPT.app` reported version
`26.901.51231`, build `8109`, bundle `com.openai.codex`. A read-only archive
inspection confirmed the existing electron preload/message envelopes. The
bundled `codex app-server generate-json-schema` output confirmed optional
`ThreadStartParams.cwd`/`developerInstructions`, required response `thread.cwd`
as `AbsolutePathBuf`, and `TurnStartParams.clientUserMessageId`. Required turn
inputs remain `threadId` and `input`.

Schema SHA-256 values from that installed binary:

- ThreadStartParams: `792e2f32e37cece971bd616664ea2053741acbed4e9c92e9d1766427718f2ecd`
- ThreadStartResponse: `656f8fd0fe91f533126cbfdb9369cfab550927a229e48dd46460f6f015d2b186`
- TurnStartParams: `a3835e8c1e942e4b358e1a670939b89918b16c4d13105a579899892b7ade6dea`

This audit supports an exact transport pin, not a version range. Mocked native
transport tests and schema inspection are not real-App acceptance. The combined
Leader CLI delegation still requires isolated production runtime verification.
