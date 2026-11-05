# Run CordisX services without an App

Use a Host build that lists `service` in `cordisx --help`. Select the
`CORDISX_HOME` and profile that already contain your installed, enabled plugins
and permission decisions. With the default profile:

```sh
cordisx start --mode service
cordisx status --mode service --json
cordisx logs --mode service
cordisx restart --mode service
cordisx stop --mode service
```

Append the default App namespace and a profile to each command (for example,
`cordisx start --mode service codex work`) to select a named profile. The App
name selects a configuration namespace. Service mode starts a Node supervisor
and managed backends. It starts neither a desktop application nor a local Codex
or Claude Code Agent. A second `start` returns the existing owner. Use
`restart --mode service` to apply launch environment changes. If an App already
owns the selected scope, stop that instance explicitly before switching modes.

Use `cordisx plugin list --profile work` and the usual plugin management
commands. Existing permissions and plugin configuration still apply.
`--yes` does not approve new permissions. Browser-only plugins are shown as
unavailable in service mode; there is no native Manager, session context or
local Agent API. Compatible plugins that expose their own loopback web console
can still be configured there. For example, the fakemodel console normally
opens at `http://127.0.0.1:8397/login`; use its configured port and existing
browser session. Plugin-owned data follows the plugin's existing storage rules:
managed-service data directories are keyed by home and plugin/service identity.
Use separate homes for separate backend accounts.

The unified model API listens on `127.0.0.1:8398` by default. Set
`CORDISX_MODEL_API_PORT` before startup to change the port; `0` asks the OS for
a free port. Use the actual endpoint and access key path from
`<CORDISX_HOME>/run/model-api/<profile>/server.json`:

```sh
# Replace these example values with baseUrl and accessKeyFile from server.json.
base_url=http://127.0.0.1:8398/v1
key_file=/absolute/path/to/cordisx-home/run/model-api/default/access-key
curl -fsS "${base_url%/v1}/healthz"
curl -fsS "$base_url/models" -H "Authorization: Bearer $(cat "$key_file")"
curl -fsS "$base_url/responses" \
  -H "Authorization: Bearer $(cat "$key_file")" \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider::model","input":"Hello"}'
```

Use an exact ID from `/v1/models` and a protocol the model supports. The API can
serve compatible plugin publications, Host-managed API connections and enabled
shared model-service declarations. A healthy Host can have an empty catalog
while a plugin is starting or waiting for account configuration. Consult
`cordisx logs --mode service` for backend startup failures. The Host API key,
plugin console API keys and Host-to-backend credentials have separate scopes.
The [API reference](local-model-api.md) lists supported routes.
