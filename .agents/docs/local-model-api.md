# Local model and Agent API

CordisX starts an authenticated loopback API in [standalone service mode](standalone-services.md)
and alongside compatible Codex launches that initialize the native model composition. The default port is 8398; a launch
`CORDISX_MODEL_API_PORT` selects another port (0 requests a free port).

Read `<CORDISX_HOME>/run/model-api/<profile>/server.json` for the actual
`baseUrl` and `accessKeyFile`. App mode also publishes `agentUrl`. The access key persists as a private
0600 file. Send `Authorization: Bearer <key>` or `x-api-key: <key>`.
`GET /healthz` needs no key. Cross-origin browser requests are rejected.

`GET /v1/models` returns provider-qualified IDs such as `provider::model`,
plus `invocation`. An `agent` entry uses the App account through the Agent
routes; a Desktop OpenAI login does not establish a raw inference API key.

The model routes forward to the current Host-owned provider connection:

- `POST /v1/responses`, `/v1/chat/completions`, `/v1/messages`,
  `/v1/messages/count_tokens` and `/v1/responses/compact`.
- Responses SSE and WebSocket (`GET /v1/responses`, first text frame
  `{"type":"response.create","model":"provider::model",...}`). Open a new
  socket to change models.
- Response listing/read/delete/cancel and queue status. Resource routes require
  `?model=provider::model` to scope the account and model explicitly.

Declared providers enforce their advertised protocol list. Managed gateways
supply their own response for additional protocol routes. Model presence does
not promise all modalities or protocols; upstream errors retain their status.
Function/tool and image payloads pass through to the selected service.

The Agent routes use the existing Codex/Claude bridge in App mode.
In service mode, authenticated Agent requests return `503 agent-unavailable`.

- `GET/POST /agents/sessions`; POST accepts `app`, `prompt`, `cwd`, optional
  `providerId`, `model`, `title`, and bridge context fields.
- `GET /agents/sessions/:id` reads bounded transcripts and paging metadata.
- `POST /agents/sessions/:id/messages` accepts a `prompt`.
- `POST /agents/sessions/:id/interrupt` accepts a Codex `turnId`.
- `GET /agents/operations/:id` or `.../events` reports operation status.
- `GET /agents/sessions/:id/events` streams changed transcript snapshots.
- `POST /agents/rpc` accepts the existing allowlisted bridge operations.

Use `?app=claude` for Claude sessions. Claude availability follows its existing
bridge and login lifecycle. Text, plans, command output and readable tool
records are included in Codex transcripts. These are bounded snapshots, not
native token events. Agent tools and approvals remain under the selected App's
existing authority; the API does not silently approve tool actions. Remote
Agent-backed providers execute their own tools in their upstream environment.

The server closes with the owning launcher, aborts model requests and releases
connection leases. Its metadata contains no upstream keys. This reference
covers the local candidate source; it does not establish publication or live
upstream verification.
