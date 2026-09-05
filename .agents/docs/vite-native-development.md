# Native Vite development

Status: implemented and verified by focused transport, CDP, runtime, Manager,
and isolated native `app://` runs. Both targeted Manager-channel reload and
automatic source replacement reached ready in the native application.

## Requirement ledger

| Requirement                                                                                   | State       | Evidence                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One `cordisx dev` process serves Host and every enabled config plugin through one Vite server | verified    | the multi-entry test loads two entries in one session, scopes independent files, and replaces both owners when one plugin entry is imported by another                                                                       |
| Plugin source loads directly from the shared Vite ESM graph                                   | verified    | HTTP tests inspect the virtual wrapper, direct `/@fs/` source module, and Vite update payload                                                                                                                                |
| Refresh-compatible React component modules use React Fast Refresh                             | verified    | the transformed component contains Refresh registration and self-acceptance, and its edit produces a component HMR update without `full-reload`                                                                              |
| Entry, manifest, `apply`, and non-refresh-safe updates retain Cordis lifecycle cleanup        | verified    | focused tests prove owner mapping; the native mixed-export edit advanced the owning plugin revision and changed its digest/module generation while the runtime stayed ready                                                  |
| `cordisx-package.json` keeps renderer-only validation and entity templates                    | verified    | Vite startup rejects formal dependencies, tracks exact package/entity files, stages entity declarations before plugin `apply`, and restores last-good declarations when either Host or renderer staging fails                |
| Automatic file detection and Manager **Reload plugin** are separate update triggers           | verified    | focused tests exercise both triggers; isolated native runs completed an automatic source replacement and the Manager development-reload channel independently                                                                |
| Vite's WebSocket owns update delivery                                                         | verified    | real Vite HMR WebSocket tests receive update and custom reload-result payloads; CDP carries no replacement source                                                                                                            |
| Server `full-reload` becomes a CordisX Host restart in the current document                   | implemented | the server replaces outbound `full-reload` with `cordisx:restart-host`; the boot boundary accepts that event                                                                                                                 |
| Source maps stay outside the startup code                                                     | verified    | the bootstrap is under 1 KiB and the HTTP test fetches a separately linked map                                                                                                                                               |
| Dependency optimization is reusable across launches                                           | verified    | the cache key binds the CLI/workspace roots plus CLI, Vite, React plugin, React, and React DOM versions; a second native launch reused the first launch's cache without dependency-optimization or optimizer-reload messages |
| Native loopback/CSP policy and launcher session resources are restored                        | verified    | CDP integration ignores non-`app://-` pages, covers exact permission/CSP restore across multiple windows and target disconnect, and installs a Vite-client disposer for its socket, timer, and injected CSS                  |
| Isolated native `app://` bootstrap and both update triggers                                   | verified    | the current CLI reached `app://-/index.html` with CordisX, Chatroom, Vite client, and shared React ready; targeted reload and source edit each advanced activation revision and changed digest/module generation             |

## Module and update flow

Both `cordisx dev <entry>` and config-driven `cordisx dev` start a
launcher-owned loopback Vite server. CDP installs a small stable bootstrap into
the native renderer. That bootstrap imports the React preamble and CordisX
entry over HTTP; later modules and notifications use Vite HTTP and Vite's own
HMR WebSocket. There is no second update socket and no CDP transfer of module
source.

```text
Host source + enabled plugin entries -> one Vite ESM graph -> native app:// renderer
                                              |                       |
                                              +-- Vite HMR WebSocket -+

component-only edit ---------------------> React Fast Refresh boundary
entry/apply/manifest or unsafe boundary -> owning plugin generation replacement
Manager Reload plugin ------------------> targeted invalidation and replacement
Host full-reload ------------------------> CordisX restart in current document
```

The shared virtual modules resolve `cordisx/react`, its JSX runtimes,
`cordisx/ui`, and compatible React peers to the Host singleton. Component-only
modules accepted by the React plugin can retain component state. The generated
plugin keeps its named React page component separate from its manifest and
`apply` entry so normal UI edits use that boundary.

A plugin entry always invalidates the owning plugin wrapper. If Vite's React
runtime invalidates another mixed-export boundary, the server maps that module
back to its plugin owner and sends the same targeted replacement. The client
imports the new artifact. Host-owned entity declarations and templates are
staged before the renderer
transaction, so plugin `apply` sees the candidate declarations. The client then
executes the existing stage/publish/complete/finalize transaction. Success
commits the Host declaration snapshot; failure rolls the renderer back first
and restores the last-good Host declarations. The old fiber and contributions
are disposed. Activation failure retains or rolls back to last-good; a failed
rollback pauses later updates rather than crossing an unresolved transaction.
Independent renderer windows apply their own updates, so this development path
does not claim atomic publication across windows.

The Manager's development reload sends `cordisx:reload-plugin` through Vite's
existing socket. The server invalidates the selected plugin entry and wrapper,
returns a timestamp, and the client imports and applies that version. This
action exists only for an active local-development plugin. Package enable,
disable, uninstall, and other lifecycle actions remain controlled by the
package lifecycle bridge.

Server-originated Vite `full-reload` payloads become a
`cordisx:restart-host` event, which recreates CordisX without replacing the
native document. Vite's upstream client still owns reconnect, circular-import,
and initial-error recovery; those exceptional recovery paths may reload the
document. Project config, dependency installation, and Node-side launcher or
bridge changes require restarting `cordisx dev`.

## Native policy and cleanup

The installed native page blocks loopback module and WebSocket access by
default. Before its development reload, CDP grants `loopback-network` to the
exact target origin and embedded origin. Chromium versions using the earlier
name fall back to `local-network-access`. CDP then enables
`Page.setBypassCSP`, installs the bootstrap, reloads the page once, and waits for
the Vite client acknowledgement before reporting ready.

Failure and disposal remove the installed bootstrap, dispose the Vite client,
wait for any in-flight Vite connection before disconnecting HMR, remove
Vite-injected CSS, disable CSP bypass, and restore
the granted permission to `prompt`. If the page target has already disconnected,
the launcher retries the browser-scoped permission reset through CDP's browser
endpoint. Vite development selects only the native `app://-` origin; matching
web pages are never granted permission, bypassed, or reloaded. CordisX
does not change the official application files. Vite binds to `127.0.0.1` under
a random launch-specific base path, uses its HMR token, and serves source maps
as separate resources. The server clears its in-memory source-map table,
generation state, file hashes, WebSocket session, and CDP installation state on
close. Dependency optimizer data remains under the user-private
`CORDISX_HOME/cache/native-vite` tree; CordisX rejects a symlinked or
foreign-owned cache leaf before Vite can read or write it. Its stable key covers
the CLI/workspace roots and the CLI, Vite, React plugin, React, and React DOM
versions, so a later compatible launch of the same workspace can reuse that
dependency work. A normal native launch waits for Vite to crawl the Host and
plugin entries and commit dependency metadata before opening Electron, which
avoids serial dependency discovery in the renderer after a cold cache.

## Current automated evidence

The focused command below passes 31 tests:

```bash
npx vitest run tests/native-vite-development.test.ts \
  tests/bundle-readme.test.ts \
  tests/manager-plugin-actions.test.ts \
  --maxWorkers=1 --no-file-parallelism \
  --testTimeout=30000 --hookTimeout=30000
```

The eighteen native Vite transport tests cover direct ESM delivery, separate maps,
automatic HMR, React Refresh transformation, manual targeted reload,
overlapping multi-plugin ownership, embedded-README scoping, server close with
private cache retention, completed startup prebundling and reuse, symlink
rejection, renderer-only dependency rejection, entity-template generation
staging and rollback, installation-bound bootstrap acknowledgement, slow bootstrap, and
bounded, non-error cancellation and cleanup during add-script, reload, or
bootstrap polling,
non-native target exclusion, browser-scoped loopback permission across multiple
native windows and a disconnected target, CSP restoration, Vite client cleanup,
and one-shot failure cleanup. Four README
composition tests cover nearest-package resolution, embedded plugin ownership,
external Host contracts, and Host-DOM worker handling. The nine Manager tests
include the local-development reload gate and prove that it does not enable
package operations.

The isolated native verification used:

```bash
CORDISX_HOME=/tmp/cordisx-native-vite-proof-20260904-0514 \
  ./node_modules/.bin/tsx packages/cli/src/cli.ts dev \
  ../plugin-chatroom/src/chatroom.ts \
  --executable /Applications/ChatGPT.app/Contents/MacOS/ChatGPT \
  --debug-port 19341
```

It logged the Vite server, ready CDP renderer, and injected target. Direct CDP
inspection confirmed `app://-/index.html`, `cordisxReady=true`, active plugin id
`chatroom`, and installed Vite client/shared React runtime. Calling the same
development reload channel used by Manager advanced activation revision from 0
to 1 and changed the plugin digest and module generation. The focused CDP tests
verify that disposal restores the granted permission to `prompt` and disables
CSP bypass.

A second isolated verification on debug port 19342 covered automatic replacement with
the corrected invalidation handling. Its initial activation revision was 0.
Editing a Chatroom React component produced a Vite HMR update and React
mixed-export invalidation; CDP then observed activation revision 1 with a new
digest and module generation while both runtime and Vite client remained ready.
The fixture file was restored after the observation.

The final native cache check used the same Chatroom workspace and
`CORDISX_HOME` on debug ports 19347 and 19351. The cold launch returned only
after its private cache contained the committed `deps/_metadata.json`; an
independent source-level launch measured 78 optimized dependencies. CDP then
reported `app://-/index.html`, `ready=true`, Chatroom, the Vite client, its HMR
disposer, and the shared React runtime. Invoking the Manager development reload
channel advanced activation revision from 0 to 1. Ctrl-C returned exit code 0
and closed both the cold launch's CDP and Vite ports while retaining the cache.
The final launch reused that cache, emitted no dependency-optimization or
optimizer-reload messages, and reached the same native ready state with a
fresh installation nonce. Native startup now waits for that installation's
actual Vite bootstrap acknowledgement instead of depending on
`Page.loadEventFired`, which Electron did not emit consistently across
immediate launches.

For a release claim, also run the owner repository's full gates.
