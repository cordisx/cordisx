# Independent manager

Status: implementation candidate. Publication, real Desktop validation and user
acceptance are separate gates. The existing injected Manager remains unchanged.
The candidate supports macOS and Linux; it cannot yet start on Windows because
user-private entry-file ACLs have not been implemented or verified there.

The independent manager is a local browser client of one existing profile owner.
It uses the same management RPC for plugin/source operations and shared model
service configuration, with revision checks and write-only model credentials.
When exactly one admitted App renderer is available, plugin configuration and
service configuration use its existing schema validation and transactional
apply/rollback path. A renderer that cannot be identified is unavailable.

```bash
cordisx manager                         # start or reuse the manager; open the browser
cordisx manager open --profile default
cordisx manager start --profile default  # start without opening a page
cordisx manager status --profile default
cordisx manager stop --profile default   # stop the manager, not the profile owner
```

`manager` is a reserved top-level command. An adapter with that name must use the
explicit `cordisx start manager` form rather than bare `cordisx manager`.

The profile owner must already be running. The manager does not silently start
or replace an App or service owner. Current App and service modes still acquire
exclusive profile ownership; this page does not claim concurrent App attachment
or infer that an adapter is connected. If the owner disappears or is replaced,
the manager sidecar shuts down. Starting it again requires the new owner.

The sidecar listens only on loopback and communicates with the owner through its
private management socket. Each browser opening obtains a 60-second, single-use
bootstrap in the URL fragment; it is exchanged for a separate session token,
removed from the address bar, and stored in that tab's session storage. A session
expires after eight hours of inactivity or when the manager exits. Browser origin
checks and Host header checks fence management requests; no API key is placed in
the URL. The command asks the OS to open the default browser without logging the
URL. On macOS and Linux the opener receives a temporary HTML file path, not the
token URL; the sidecar maintains a mode-0700 directory and mode-0600 file until
exchange, expiration or shutdown. This protects against other OS users, not
malicious processes running as the same user. A successful opener command does
not prove the file was opened in a browser or redeemed. On a trusted local
terminal without a graphical launcher, an operator may run
`cordisx manager open --print-url`; that URL is a temporary credential and must
not be shared. Closing the tab clears its browser storage but does not itself stop
the sidecar; use `manager stop` to stop it.

The preview offers shared model-service editing, plugin/source lifecycle actions,
and Marketplace search. Permission plans v2 and v4 require the user to choose
each requested decision and explicitly confirm; the existing Host rechecks the
plan and applies it. Other permission plan versions remain unavailable. Busy,
stale or uncertain reviews are not automatically retried. Plugin-owned custom
pages, specialized credential entry, and service configuration without an
active renderer are not yet equivalent to the existing Manager; their absence is
not reported as a successful edit. Service configuration is an advanced JSON
editor limited to known fields in projected schemas; it does not support unknown
fields, secret values, or array insertions/deletions. For active managed plugin
services that expose explicit login, the user may initiate the existing Host
background login flow. That process does not expose its standard streams, so
login methods needing terminal input or a displayed terminal code are not
supported here. A synthetic service verifies the bridge; a real Aiden login is
not yet verified.

The Feishu/Lark controls are currently **unavailable in real installations**:
the active packaged Channel and the current configuration store have a known
composition mismatch. Isolated fixtures exercise credential creation and
rotation, tenant resolution, and connection enablement, but do not establish a
working production route. Other adapters, connection deletion, and the remaining
Channel management features are also unavailable. Real Feishu/Lark credentials
have not been used in validation.

Model-service changes retain the current Host's app-restart apply semantics.
Environment variables may be read dynamically by other clients or plugins, so
removing a service retains its key variable for separate, deliberate cleanup.
Individual removal of a key while retaining its service is also not exposed by
the existing model-service contract. Rotating an existing key affects any other
consumer of that environment variable.

The caller must inspect an `unknown` outcome before retrying any change. A page
refresh does not authorize blind retries. Running status and backend data do not
prove the Codex Desktop or Claude Code client's current connection or model.
