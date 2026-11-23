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
the manager sidecar shuts down. Opening it against a replacement owner waits
briefly for the previous sidecar to exit; its browser sessions are not reused.
If that exit cannot be confirmed, opening fails rather than starting another
sidecar. A new owner must already be running.

An owner-private adapter admission primitive can reserve its attached cohort,
reject new grants and fence remaining peers after a disconnect. The reservation
does not drain adapter work or synchronize policies by itself, and it is not
connected to real Codex or Claude adapter startup.

An experimental `host=1` query on the manager entry loads the existing Host
Manager and plugin registration instead of the default preview pages. It is not
the default experience. Eligible service and Desktop owners can project initial
capability-free v1 package graphs and host-owned v14/v15 managed backends whose
only declared renderer capability is UI extension rendering. These packages
must have no durable documents or entity templates and must have a verified
browser graph. In service mode, their plugin configuration must be empty. An
eligible Desktop owner can also project nonempty installed-plugin configuration
when exactly one admitted Desktop renderer proves the same plugin generation
and a schema classifies every projected field. Only declared non-sensitive
values are copied. For a service-free, capability-free v1 package, declared
live primitive fields and bounded arrays of primitive values may also be saved
after the owner verifies the Desktop seat, durable readback, and each admitted
Manager's adoption. Secrets and other field types remain unavailable. A Desktop
seat change retires pages using this projection, and a new page requires a fresh
proof. Each Manager receives only matching existing Manager UI permissions.
Managed-service reads and subscriptions are available; the service owner can
coordinate an explicit login or logout across admitted Managers. Logout is
unavailable while affected terminal or managed-service clients hold leases.
For a compatible service source, the service owner can also read and enable or
disable an account. It reserves affected service clients, validates the exact
operation plan and account revision, confirms the result with a fresh read, and
waits for admitted Manager pages to adopt the account projection. An unconfirmed
result is not replayed. This path does not yet coordinate native adapters or
enable OAuth.
When initial service sources are still being adopted, the owner waits before
taking the Manager's profile fences; admission remains bounded and stops when
the page disconnects.
Desktop login and dynamic changes to those managed packages remain unavailable.
The service owner and an eligible Desktop owner can change an unrelated
capability-free v1 package while admitted Manager pages retain their projected
identities; the Desktop owner also coordinates its ready renderer seats. Manager
controls can enable or disable owner-verified packages with empty configuration,
or a Desktop-proved non-sensitive live configuration. Uninstall remains limited
to empty configuration. After a Desktop generation change, the owner reproves
the redacted configuration before admitting a new page or accepting another
write. Installation, upgrades and managed-package changes are not
available through these controls. The owner waits for the participating pages'
receipts and holds outstanding subscription results until service continuity is
confirmed. If a participant
disconnects or continuity cannot be confirmed, affected pages are retired and
the operation may require reconciliation. The installed managed packages remain
read-only in these Manager pages.
A Desktop owner must own the profile exclusively, have a ready Desktop renderer
and not be in attach mode. On macOS or Linux, either owner can project one
configured Channel archive when its staged browser graph has an initial
stylesheet and its live service owner matches. An existing source-specific
Manager UI permission or a separate one-tab review is required. In service mode,
an explicit user decision can persist, deny or reset the selected Channel's two
Manager UI permissions. The owner verifies the decision and waits for admitted
Manager pages to adopt it; unaccounted renderers prevent the change. Desktop
and external adapter consumers are not yet included. The exact
published Channel 0.1.7 archive is supported as a read-only legacy view: its
static stylesheet is recovered into the verified same-origin graph, but that
version cannot negotiate the configuration facade. Other legacy graphs without
an initial stylesheet are not admitted. A compatible service owner and Channel
version can also expose the existing connection form for a resolved account's display
name and reception selectors, and can rotate a Feishu/Lark credential within
that Host-owned form. The eligible Desktop owner remains read-only. Connection
creation, connection controls, Channel policies, logs and sessions are not available
through this restricted page. Other configured plugins, adapters and recovery
after an uncertain result are not yet supported. The isolated browser tests do
not constitute real Codex App validation.

The experimental Host page in service mode and the eligible Desktop mode can
read and save shared model-service declarations through the
existing Manager form when the owner advertises the safe-write contract. The
Desktop path depends on its native settings authority being ready. Edits use the
owner's revision and credential protection; they retain the app-restart apply
semantics described below. An edit started against an older revision is rejected
if another client changes the declarations first. Other independent Manager
pages refresh these declarations while idle; an open edit retains its draft.

While an experimental Host page is attached, installed-package plugin and
service configuration writers use the same profile fence as Manager admission.
Pending configuration candidates prevent admission; a confirmed change outside
that fence retires the affected page. The managed-service startup configuration
for the selected app and profile must also match the value used when the owner
started. Changes to that startup input are fenced while a Manager is attached;
when the value already differs, the owner must be restarted or the previous value
restored before a new page can attach. These checks do not project private
startup values into the browser. Installed-package configuration writes remain
unavailable while the fence is held, except for the coordinated Desktop subset
described above. The separate, explicitly coordinated configured-Channel
service update retains its existing owner and receipt checks.

The sidecar listens only on loopback and communicates with the owner through its
private management socket. Each browser opening obtains a 60-second bootstrap
in the URL fragment; it is exchanged for a separate session token and removed
from the address bar. If that exchange is interrupted, the same tab may retry
its temporary attempt until the session first makes an authenticated request;
the previous session must retire before a replacement is issued. The default
page stores its session token in that tab's session storage. The experimental
Host page keeps its session token in
memory. On refresh, a tab-local handle and an HttpOnly cookie can
authorize a new session after the owner confirms retirement of the old renderer.
If the browser loses the unload request, the authenticated replacement requests
that retirement itself. A duplicated tab carrying the same recovery handle
replaces the previous session; open a new manager entry for an independent tab.
This includes a hard reload, where the fixed resource worker reclaims the page
before the new authenticated session binds. Requests still queued before owner
admission are cancelled rather than treated as dispatched writes.
The Host page also restores supported navigation destinations within that tab.
Route parameters and unsaved form inputs are not stored; a transient edit page
returns to a main section after refresh. Changed shared model-service and Channel
connection forms ask the browser to warn before the page is refreshed or closed.
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

The independent Host renderer evaluates public Marketplace trust records only.
Other trust authorities remain unavailable there until the owner can project
their verified results without exposing private source identities. Existing
owner-approved plugin permissions are not changed by this restriction.

For a running Channel service with a verified profile owner, the sidecar's
existing credential API supports an active package or a configured archive
whose distribution, staged identity, configuration selection, and live
service still match the owner's startup selection. It offers Feishu/Lark
credential creation and rotation, tenant resolution, and connection enablement.
The user enters and confirms credentials; the Host validates and stores them
without reading them back into the page. The configured archive path has been
exercised with a real isolated Channel service and a simulator; separate
synthetic credentials exercise the write and recovery transactions. Real
Feishu/Lark credentials have not been used in validation. This API is separate
from the restricted Channel page, which offers only the existing-account
credential rotation described below.
Unverified direct entries, other adapters, connection deletion, and remaining
Channel management features are unavailable.

The experimental service-owner composition projects an exact configured
Channel archive and its already-running service into renderer sessions. It
forwards only matching existing Manager UI policies. The connection form may
save ordinary settings and rotate a credential for a resolved Feishu/Lark
account through owner-bound bridges. Credential values and private references
are not returned to the plugin-facing facade or stored in browser storage.
When the owner explicitly advertises coordinated connection control, a
compatible Channel page also uses its existing header action to enable or
disable a resolved connection. Reconnect remains unavailable on this path.
The owner retires private drafts with the renderer; an unconfirmed cleanup or
write keeps subsequent mutation coordination closed. A two-page test exercises the
compiled service owner, actual isolated Codex app-server, authenticated sidecar,
refresh, profile write fences and owner restart with an isolated simulator.
An additional browser test exercises the credential form and owner handoff with
a synthetic validator and an in-memory credential store. These do not validate
real Channel credentials, the current user's profile,
the native Desktop renderer or another adapter. The exact published Channel
0.1.7 archive remains read-only; its connection form and credential rotation are
unavailable until a compatible Channel version is installed. Other archives
without an initial Channel stylesheet are unavailable, and permissions from
another source are not reused.

The originating Manager reserves the owner lifecycle and all admitted Manager
sessions before a connection settings, enable/disable, or credential write. The owner drains
their old reads, verifies the new service generation and sends a redacted view
to the other Managers. It reports success only after they confirm adoption.
Those pages retain unsaved form values and require review when their underlying
revision changes. An unadmitted Manager or an unaccounted adapter still makes
the write unavailable; a lost receipt after dispatch requires reconciliation.
The originating page adopts the confirmed connection state before reporting
success and does not automatically retry an uncertain action.
This handoff covers the restricted Channel page, not other clients or general
permission and configuration synchronization.
The owner compares a form save with its current redacted configuration and
accepts changes to the display name and reception selectors of at most one
resolved connection. Other configuration fields remain unchanged; credential
rotation uses the separate private transaction. A stale revision is rejected.

When the owner-selected Channel has no matching UI allow, its Manager entry can
lead to a Host permission review. The user may allow the navigation entry and
page body separately. Each dialog identifies the verified archive version and
digest and defaults to denial. A one-time decision is limited to that tab and
requires a new review after refresh, renderer retirement or owner loss. An
eligible service owner can also coordinate a persistent decision across its
admitted Managers. An existing denial is not overridden without a new review.

If the configured owner check fails before an action is dispatched, the action
is unavailable and can be retried after the exact archive, configuration and
running service match again. A failure after an action begins may have changed
state and requires reconciliation rather than an automatic retry.

In service mode, the older sidecar credential API's Channel commit, tenant
resolution, or enablement is unavailable while any standalone Manager renderer
is open, because its drafts and pending writes cannot yet be handed off safely.
The Host-owned form uses the separate originating-Manager handoff above.
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

The service owner can borrow its held permission fence for one exact Channel
Manager UI policy change while keeping other profile and Home changes excluded.
It verifies the signed user decision, resolves the renderer-scoped identity to
the owner source and reads back the policy before each admitted Manager adopts
it. The reservation rejects an unaccounted renderer; the service owner has no
non-renderer consumer of these two UI policies. A missing or stale receipt, or
an unconfirmed release, fences the handoff and can require reconciliation. The
Host permission detail can reset a persistent allow or denial to `ask` under
the same barrier. Desktop and external adapters do not yet participate in
this persistent-policy handoff.

On macOS and Linux, an experimental service-mode renderer or an eligible
Desktop renderer holds profile-scoped fences while its
startup snapshot is in use. Current Home
configuration writers reject changes to that profile's persisted permissions
and selected configured-plugin or service configuration until its Manager
renderers retire. A change that affects only another profile remains available.
A rejected write has not been published and can be retried after closing the
Manager. Older or non-cooperating writers, Windows, package-owned configuration,
external archive changes and other consumers are not synchronized by these
fences.

Renderer revocation waits for any pending bootstrap, configuration and policy
checks, owner graph leases, dispatched writes and profile fences to finish
retiring before it acknowledges the close. Dispatched reads also finish
before their renderer's profile fences are released. A write still in flight when its renderer disconnects
has an uncertain outcome; its profile fences stay held until that write settles.
New admissions and coordinated sidecar writes remain unavailable during that
cleanup; an unconfirmed result keeps them closed.
If initial bootstrap fails while assembling the owner graph, its renderer is
revoked; a new session can join only after the old session has finished cleanup.
A dispatched Manager write whose result is lost also fences the other Manager
sessions until the owner is reconciled.

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
