# Local wallet spending in Host

This is the Host implementation reference for the experimental
[wallet-spend/v1 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/wallet-spend/v1.md).
The declarations and compatibility rules remain in Protocol. This reference
describes the implementation candidate, not a released or Native-accepted feature.

Native Host attaches `walletSpend` to each plugin owner Context. Plugins can
discover it through `ctx.get('walletSpend')`; no additional manifest scope is
required. Each operation uses the captured owner, module generation, document
lease and client lifetime. Playground returns unsupported because it has no
privileged wallet authority. There is no renderer registration of an authority,
signing key or arbitrary provider endpoint.

## Existing wallet and private provider

The launcher uses the original enrolled local wallet from
[local-wallet-auth](local-wallet-auth.md). It does not create another account or
ledger. A deployment-private `state/profiles/<profile>/wallet-spend.json` file,
owned by the current user with mode 0600, selects the existing wallet binding,
Unix socket, IPC secret file, owner-specific service pins and local stores.

The configuration has contract `cordisx.wallet-spend-config/v1` and fields
`socketPath`, `secretFile`, `walletBinding`, `services` and `stores`. A service
entry contains `{owner:{pluginId,source},source:{serviceOrigin,servicePublicKey,
serverId},status:'active'|'recovery-only'}`. A store entry contains
`{owner:{pluginId,source},storeId}`. Owner sources must match the installed owner
exactly. Provisioning this file and the independent receipt key belongs to the
deployment operator; plugin configuration cannot provision either.

The Node-only `cordisx/wallet-spend-provider/v1` entry exports
`listenWalletSpendProvider` and its session types. The canonical Store and
Economic receipt signer must run in the same trusted Node process as the
provider session. The socket directory has mode 0700, the socket has mode 0600,
and both peers read the same independently provisioned 32-byte mode-0600 IPC
secret. Neither receipt private key nor IPC secret crosses into a renderer.

The handshake authenticates both peers with HMAC. A fresh session nonce and
strict frame sequence prevent replay. Quote handles remain private objects in
the Node process; wire quote tokens have a single purpose and cannot become a
generic signing request. The provider engine is synchronous: socket closure,
deadline and session retirement fence later mutations. A commit completed
before retirement may remain committed; the caller retains its stable request
identity and looks up the result after an uncertain response.

## Source consent and transaction consent

`authorizeSource` fetches only `/v1/spend/identity` from the exact HTTPS origin,
without wallet or Codex credentials, redirects or cookies. A separate native
AppKit window displays the exact plugin, origin, key and server identity before
Host persists an owner-specific pin. Rotation retains the old key solely for
pending recovery. Reserve and account binding independently recheck active
source metadata. Deployment-provisioned existing HTTP loopback sources can also
be used, with local-device trust rather than TLS origin proof; dynamic source
onboarding remains HTTPS-only.

Transaction confirmation is an independent `/usr/bin/osascript` process with
a read-only scrollable complete document. The JXA program is static and receives
data through argv. Host checks the original wallet, owner lifetime, source pin
and operation deadline again after approval. A Game binding requires the signed
logged-in account challenge. A reservation authorizes exact principal only;
capture cannot exceed it and released principal returns to the same hold.

Local purchases use a provisioned store and the current canonical catalog
quote, with exact quantity, total and fulfillment target. Native refusal writes
an authoritative cancellation tombstone through the provider. Explicit
cancellation uses the exact original input even if the catalog price changed.
An order and its cancellation are mutually exclusive in the canonical Store.
An unavailable response or missing lookup is not cancellation evidence.
Historical grant, migration and purchase lookup returns only an existing exact
saved response; it cannot replay a write or manufacture a signed old receipt.

## Trust and verification limits

This candidate preserves the existing trusted Host renderer boundary; it does
not sandbox arbitrary same-device code. A compromised user account or device
can read local secrets. This local authority does not provide global
double-spend prevention, unforgeable model usage or remote-service finality.
Only admitted real Codex model usage can create wallet Token. Service conflicts
require dispute handling rather than an automatic second refund or mint.

Automated Host tests exercise actual authenticated Unix IPC, owner retirement,
lost responses, fixed-purpose commerce and cancellation. Those tests inject
confirmation and a fixture provider. Noninteractive Cocoa construction checks
validate the native document view separately. Neither establishes an approved
transaction in the original Native wallet; that remains an assembly acceptance
step with the real canonical Store and provisioned keys.
