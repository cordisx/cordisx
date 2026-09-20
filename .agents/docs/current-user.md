# Current user display profile implementation

`ctx.currentUser` is a read-only, owner-bound implementation of the experimental
[Protocol v1 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/current-user.md).
`renderer/current-user` owns source adaptation, safe bitmap normalization,
opaque local subject derivation and subscription lifecycle. It does not add a
login, Agent provider, account system or identity permission.

The native source adapter is separately pinned to Desktop
26.903.61454/8378/prod with `app-initial-1b87ae739476.js`, and
26.908.40834/8881/prod with `app-initial-9b95fa538c62.js`. Each exact build maps
to its separately audited exported client names; a recognized version never
allows mismatched symbols from another bundle. It checks native
`app://-/index.html` and build identity before importing the audited client.
Existing Agent transport pins are unaffected. Unknown builds, missing native
clients, source errors and unsupported launchers return unavailable. Static
source compatibility is distinct from a working native profile read.

The native account input identifies the current account inside Host only.
Managed HTTP authentication now discovers the typed account capability from
the actual native resource and checks it in the calling context, independent
of Desktop version/build. See [native submission compatibility](native-model-providers.md#desktop-compatibility).
The display-profile adapter described above remains separately pinned. On
8881, CurrentUser uses the audited
`TW.accessInputs.readAccountInfo()` reader used by that build's Native UI.
Only typed `ready` data is accepted; missing, unavailable or failed typed inputs
never fall back to the legacy POST channel or a cached display profile. Caller
abort bounds observation and discards late completion. The independently pinned
8378 adapter retains its `account-info` POST. On 8378, native GET `/me` supplies a display name fallback. On 8881,
that export is absent and the native Codex profile client supplies the display
profile directly. GET `/wham/profiles/me` supplies the Codex profile display_name/profile_picture_url.
The adapter reads account identity again before returning and rejects a result
spanning a switch. It never invokes login, token getters or a raw auth-status
payload, and never reads profile data from DOM. Fields from native responses
are explicitly projected; email/usage/plan/raw identity never reach plugins.

Allowed native profile asset requests reuse the native HTTP client. Auth control
flags apply only to audited ChatGPT estuary image paths; public avatar CDN
requests receive no such flags. Raster input is bounded to 1 MiB, decoded at
96px, drawn to an offscreen canvas and exported as a bounded PNG. SVG/external
references and decoder errors fall back normally. No arbitrary fetch function
or native credential is exposed through this capability.

The service salts account identity with a Host-profile-local persisted random
value and plugin owner key before SHA-256 hashing, returning only an opaque
subject. Storage failure returns unavailable instead of exposing raw IDs.
Concurrent reads coalesce. Subscriptions poll every five seconds while active,
refresh on focus/native account invalidation, isolate callbacks and stop on
unsubscribe/disposal. Abort/generation checks fence pending reads. Consumer
profile-to-server association remains its existing server credential flow; this
display profile is never a claim of verified OpenAI identity.

Header consumers use the existing page v4 action `visual` avatar. Keep the
standard 28px outer icon action with 8px corners/Host hover/focus, its 20px
circular image and the original personal-menu command. Guest/absent/broken
avatar uses the existing anonymous fallback. Actual native reads, updates and
account switching require native integration evidence.
