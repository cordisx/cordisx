# Managed-service web entry implementation

Status: experimental Host implementation. The public declaration, proof and
renderer contracts belong to the Protocol
[web entry v1 reference](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/managed-service/web-entry-v1.md).
Package publication and native navigation evidence are separate delivery stages.

## Composition and authority

`adoptedManagedServiceSource` reads the optional declaration only after a Node
service component adopts. `ManagedServiceRuntime.bindWebEntry` resolves that
module's exact owner and registration, then creates the dedicated reader. The
reader does not use the generic consumer invocation channel or modify its safe
value restrictions and grants.

The reader snapshots its admitted declaration and checks the current record,
registration, service generation, process identity and reserved primary endpoint.
Host-owned processes must still have the same live child. Borrowed endpoints
retain their existing authenticated discovery authority and reservation. The
read rechecks authority after asynchronous work and cancels when its source or
service becomes invalid.

The primary exchange uses the registered operation's existing authorization.
Only after validating its closed response and canonical origin does the reader
perform the declared secondary proof exchange. HTTP handling owns redirect
rejection, credential omission, response size limits and stream cancellation.
The complete read shares the operation's deadline; no verified origin is cached.

## Renderer binding and cleanup

The existing production managed-service fleet supplies the source and reader to
its owner-bound UI RPC handler. That handler issues a separate web-entry binding
for the current service generation. The parent managed-service binding and its
snapshot, authentication and subscription behavior remain unchanged. A fresh
`get` is required after generation change; changing the generation in an old
request cannot retarget its issued binding.

The renderer creates an immutable handle from the Host descriptor. Its dedicated
read and cancellation messages reuse the existing owner token and closed request
parser. Source replacement, owner revocation, transport disposal and caller
cancellation invalidate pending work. The result contains only the public
allowlisted projection; Node proof data never crosses the bridge.

The Host supplies discovery only. Plugins retain ownership of their page body,
iframe, open action and lifecycle-driven target clearing. Reading an entry does
not navigate or start a service.

## Authenticated browser console

A service that implements the [Protocol browser ticket contract](https://github.com/cordisx/cordisx-protocol/blob/v0.1.0-beta.12/.agents/docs/managed-service/browser-console-v1.md)
can open an authenticated console in its active Manager page. The browser path
is available on the verified arm64 signed macOS App build 25679, with an ordinary
CordisX-owned independent Chromium profile. Other App builds, system profiles,
attached Apps, and launches with custom Host arguments can continue to use the
manual web entry or a supported native mount.

The Host reserves one browser console service per App launch. Its private
browser hostname is scoped to that service, including on reopen. Another
service receives `unsupported` and can use its ordinary manual web entry.
Closing the page, replacing its renderer or changing the service generation
retires the active route and stops forwarding its old session.

The gateway also relays authorization cookies issued by the verified service
after console authentication. These cookies must be HttpOnly, Secure,
SameSite=None, partitioned, host-only and scoped to `/`, with an explicit
expiry. Only exact service-issued values are forwarded alongside the bound
console session. The route retains digests, caps supporting cookies at 16 and
the forwarded header at 8 KiB, and clears the bindings on logout or disposal.
Ordinary browser cookies and credentials from other origins are not relayed.

## Verification boundaries

The focused web-entry suites cover endpoint proof, source admission, canonical
origins, stale captures, forged requests, cancellation and late completions.
The integration suite uses real admitted Node modules and independent temporary
listeners, the production candidate/fleet and token routing, and the built
renderer's managed-service injection. Its transport is an in-process serialized
bridge; it is not a native App or browser-policy test.

For broader delivery requirements, follow [Host testing](testing.md). An
experimental Protocol package in a private validation directory is not a formal
minimum dependency or a published Host package.
