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

An experimental `host=1` query on the manager entry loads the existing Host
Manager and plugin registration instead of the default preview pages. It is not
the default experience. With a service owner, it supports capability-free v1
package graphs and initial read-only access to host-owned v14 managed backends
that have no declared permissions, plugin configuration or documents. Dynamic
changes to those managed packages remain unavailable. With a Desktop owner, the
experiment currently admits only an empty profile that has no configured or
installed plugins, already has a ready Desktop renderer, and owns the profile
exclusively. Package and configuration mutations are unavailable while a
Manager renderer is attached. Configured Channel, other adapters, concurrent
permission changes and recovery after an uncertain result are not yet supported.
The isolated browser tests do not constitute real Codex App validation.

The sidecar listens only on loopback and communicates with the owner through its
private management socket. Each browser opening obtains a 60-second, single-use
bootstrap in the URL fragment; it is exchanged for a separate session token and
removed from the address bar. The default page stores its session token in that
tab's session storage. The experimental Host page keeps its session token in
memory. On a normal refresh, a tab-local handle and an HttpOnly cookie can
authorize a new session after the owner confirms retirement of the old renderer.
If a write or lifecycle transaction is in progress, retirement is uncertain, or
browser storage is unavailable, open a new manager entry and check any uncertain
operation before retrying. When its resource worker loses its in-memory binding,
an idle renderer may rebind only after the owner confirms that the same session
remains current; concurrent lifecycle work or an uncertain health check instead
retires the renderer. A session expires after eight hours of inactivity or when
the manager exits. Browser origin
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
and Marketplace search. Permission plans v2, v4 and v7 require the user to choose
each required decision and explicitly confirm; v7 may defer optional decisions
until use. The existing Host rechecks the plan and applies it. Other permission
plan versions remain unavailable. Busy,
stale or uncertain reviews are not automatically retried. Plugin-owned custom
pages, specialized credential entry, and service configuration without an
active renderer are not yet equivalent to the existing Manager; their absence is
not reported as a successful edit. Service configuration is an advanced JSON
editor limited to known fields in projected schemas; it does not support unknown
fields, secret values, or array insertions/deletions. For active managed plugin
services that expose explicit login, the user may initiate the existing Host
background login flow. That process does not expose its standard streams, so
login methods needing terminal input or a displayed terminal code are not
supported here. A synthetic service verifies the bridge; a real provider login is
not yet verified.

For a running Channel service with a verified profile owner, the sidecar's
existing credential API supports an active package or a configured archive
whose distribution, staged identity, configuration selection, and live
service still match the owner's startup selection. It offers Feishu/Lark
credential creation and rotation, tenant resolution, and connection enablement.
The user enters and confirms credentials; the Host validates and stores them
without reading them back into the page. The configured archive path has been
exercised with a real isolated Channel service and a simulator; separate
synthetic credentials exercise the write and recovery transactions. Real
Feishu/Lark credentials have not been used in validation. This API does not
admit a configured Channel into the experimental Host page. Unverified direct
entries, other adapters, connection deletion, and remaining Channel management
features are unavailable.

If the configured owner check fails before an action is dispatched, the action
is unavailable and can be retried after the exact archive, configuration and
running service match again. A failure after an action begins may have changed
state and requires reconciliation rather than an automatic retry.

In service mode, a sidecar-originated Channel configuration commit, tenant
resolution, or enablement is unavailable while any standalone Manager renderer
is open, because its drafts and pending writes cannot yet be handed off safely.
With no Manager renderer open, the owner reserves the renderer lifecycle and
blocks new admissions before the write. It refuses the operation if an attached
peer is outside the Manager registry. An uncertain result keeps coordination
closed until the owner is reconciled. This is not yet a barrier for all native
or external configuration writers.

The same draft protection applies to sidecar-originated permission reviews in
service mode. With no Manager renderer open, the owner reserves the lifecycle,
applies the review exclusively and reads back the committed activation before
admitting another renderer. An uncertain review keeps coordination closed.
Other permission writers and native or external consumers are not yet covered
by a profile-wide barrier.

Model-service changes retain the current Host's app-restart apply semantics.
The manager permits saving only when the active model-service authority reports
the explicit safe-write contract; an older owner without that capability remains
read-only even if its package version looks current. Every save rechecks the
capability against the same owner generation. A persistence result that may
have occurred after publication remains uncertain until the user reads back.
Environment variables may be read dynamically by other clients or plugins, so
removing a service retains its key variable for separate, deliberate cleanup.
Individual removal of a key while retaining its service is also not exposed by
the existing model-service contract. Rotating an existing key affects any other
consumer of that environment variable.

The caller must inspect an `unknown` outcome before retrying any change. A page
refresh does not authorize blind retries. Running status and backend data do not
prove the Codex Desktop or Claude Code client's current connection or model.
