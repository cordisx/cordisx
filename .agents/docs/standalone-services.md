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
and managed backends. It does not start a desktop application. When Channel is
enabled for a Codex profile, the service also starts Channel and an independent
Codex CLI app-server; the CLI must be available on `PATH`. A second `start`
returns the existing owner. Use
`restart --mode service` to apply launch environment changes. If an App already
owns the selected scope, stop that instance explicitly before switching modes.

Use `cordisx plugin list --profile work` and the usual plugin management
commands. Existing permissions and plugin configuration still apply.
The [supplemental Codex CLI](codex-cli.md) also exposes shared model services and
creation defaults in service mode. Session operations require its existing
headless Codex backend; unsupported capabilities remain explicitly unavailable.
`--yes` does not approve new permissions. Browser-only plugins are shown as
unavailable in service mode; there is no native Manager or Desktop session context.
For Channel, use `cordisx channel connections --profile work` to inspect connection
state and `cordisx channel help` for listening, binding and explicit sends. A
started service does not guarantee an account is connected. The profile owns
Channel configuration and permissions; stop service mode before changing Channel
plugin activation, then start it again. Automatic final-response forwarding is
off by default; local commentary and final answers are not sent unless configured. Compatible plugins that expose their own loopback web console
can still be configured there. For example, the fakemodel console normally
opens at `http://127.0.0.1:8397/login`; use its configured port and existing
browser session. Plugin-owned data follows the plugin's existing storage rules:
managed-service data directories are keyed by home and plugin/service identity.
Use separate homes for separate backend accounts.

## Linux deployment and Channel credentials

Service mode does not require a desktop application or macOS Keychain. Install
Node.js 22.19 or newer, `ps` (procps), `flock` (util-linux) and Codex CLI.
Authenticate Codex under the service user,
and keep the configured Channel plugin enabled in that user's CordisX profile.
For unattended Feishu/Lark deployments, use an environment reference in the existing
Host-owned service configuration:

```json
{ "secretRef": "host-secret:env/CORDISX_FEISHU_APP_SECRET" }
```

Supply that variable to the launcher from your deployment secret manager or a
private systemd `EnvironmentFile` (mode `600`, outside the repository). The
file contains `CORDISX_FEISHU_APP_SECRET=<existing app secret>`; do not put its
value in CordisX JSON or command-line arguments. `keychain:` references copied
from macOS cannot resolve on Linux: replace the reference and provision the
same application's credential through the environment. The App ID and tenant
remain the connection's non-secret configuration.

For example, a systemd startup wrapper can use these service directives; adapt
the user, paths and profile to the existing installation:

```ini
[Service]
Type=oneshot
RemainAfterExit=yes
User=cordisx
Environment=CORDISX_HOME=/var/lib/cordisx
Environment=CODEX_HOME=/home/cordisx/.codex
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/cordisx/channel.env
ExecStart=/usr/local/bin/cordisx start --mode service codex work
ExecStop=/usr/local/bin/cordisx stop --mode service codex work
```

This wrapper starts CordisX's detached supervisor; it is not a foreground
process or a systemd automatic-restart policy. After changing the environment
file, restart the wrapper or run `cordisx restart --mode service codex work`
with the updated environment. Inspect `status` and `channel connections` for
both supervisor and account readiness. The launcher resolves environment
credentials for the Channel transport and removes their referenced variables
from the managed Codex backend's environment.

The Host credential-entry UI also saves, replaces and removes credentials on
Linux. It stores an opaque `host-secret:channel/<profile>/<connection>` reference
in configuration and AES-256-GCM encrypted credentials under
`<CORDISX_HOME>/credentials/channel`. Directories use mode `700`; the encrypted
records and `master-key` use mode `600` and belong to the service user. The same
home must be used by the Manager and headless launcher. Restarted services read
the persisted credential without another prompt. macOS keeps using Keychain.

This file backend protects credentials at rest from other OS users; its master
key resides with the ciphertext and is not an OS Keychain equivalent. Back up
both together in private storage. Copying only `config.json` does not transfer
the credential. Symlinked, shared-permission, damaged or missing-key storage is
reported as unavailable rather than using an unsafe fallback. Environment
provisioning remains suitable for servers with an external secret manager.

## Local model API

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
