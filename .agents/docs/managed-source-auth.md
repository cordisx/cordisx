# Managed source identity and work submission

The normative [HTTP v3 and managed source v1 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/plugin-http/v3.md)
owns wire and compatibility semantics. This Host implementation uses the actual
calling native account adapter, two pinned Ed25519 peers and the existing
owner-document principal lease. Native credentials are never requested or
forwarded. CurrentUser remains presentation only; its subject differs from the
stable native authentication subject.

`cordisx source-trust provision <request.json>` explicitly creates a managed
trust grant. The request contains profileId, binding, owner `{pluginId,source}`
and an absolute new serverDirectory. The Host key goes to macOS keychain as
single-line canonical PKCS8 DER/base64, decoded strictly as Ed25519 before signing;
the profile registry stores only peer public key, binding, owner and key reference.
The new private server file contains binding, hostPublicKey and serverPrivateKey.
The command prints paths only. The service owner loads that private file through
its normal startup configuration. Provisioning must correspond to the actual
managed service instance; the Host does not discover or trust arbitrary loopback
listeners. Use independent entries for wallet source-account/work-income and
each Game source-account binding. A wallet's immutable account is derived by its
server from native subject and economy instance, starting at zero.

`cordisx source-trust register-owner <request.json>` explicitly grants another
owner access to an existing exact binding. Its request contains profileId,
binding, existingOwner and owner; it reuses the already provisioned server pin
and Host signer without creating or replacing server keys. For example, Game
may register its own Economy source-account access using wallet as existingOwner,
then obtain a Game-owned opaque connection and verify GET me against the public
canonical wallet account. The wallet's connection is never shared. This grant
cannot change source, instance, origin or audience. Registry mutations use an
exclusive process lock; concurrent changes fail busy instead of losing grants.
`cordisx source-trust revoke <request.json>` removes the specified exact owner
registration. Its signer is deleted only after no remaining registration refers
to it. Provisioning failures remove only keys and server files created by that
attempt.

Registry loading rejects symlinks, writable-by-other files, foreign owners,
oversized records and non-Ed25519 keys. Automatic identity and issuer operations
fail closed without an exact owner/profile/source/audience pin. Renderer client
usage authorization remains bound to the current generation. The additional
issuer provisioning grant authorizes the Launcher-owned read directly from
the same AgentHistoryHost work-v2 ledger used by public readWork; page input
never supplies usage or an amount.

Provision the resolved runtime owner source, not merely a development entry
file URI: config-driven development derives a synthetic owner source before
launch. An otherwise valid managed request without its exact owner trust returns
`connection-unavailable` before reading Native input or contacting the source.
Unavailable Native account input returns `credential-unavailable`.
Malformed request input remains `invalid-request`; no diagnostic includes a
Native identifier or credential. The exact 8881 adapter shares CurrentUser's
audited typed account input and accepts only `ready` data.

Managed methods share a Renderer-generated absolute deadline of at most
15 seconds through policy checks, bridge/authority queueing, initial trust/native
reads, signing and final account/credential checks. The Launcher does not reset
it at receipt. Timeout returns unavailable, retires continuity and fences late
continuations. Late cleanup checks the captured epoch and exact installed lease;
a late Native read cannot observe into a newer operation. Unexposed late
credentials retire. Host-unavailable remains unknown completion and cannot
prove an issuer owner died; acknowledged Host results or the shared expired
deadline end signing authority, with uncertain financial effects still requiring
baseline reconciliation. They also retire on account or principal loss.
A synchronous final registry read fences revocation across held Native reads.
Results must be signed by the pinned server and match request
nonce/subject/binding. Active derived grants check the actual account and retain
its private tag in secure storage, including child exchange and resume.
Source logout retires pending authentication epochs. Caller-visible handles
never reveal a bearer. Work continuity uses owner/account leases; first, failed,
explicit reset or >15-second gap observation is baseline. The source owns final
rate/frontier/receipt enforcement and must not reward historical baseline usage.

This is a local trusted Host capability, not an OpenAI cloud credential or
cryptographic isolation from malicious local Host code. Native execution,
formal provisioning, original Pet retirement evidence and real future usage
remain separate acceptance evidence; source tests do not establish those states.

The successor [Host-profile local wallet authority](local-wallet-auth.md) implements
HTTP v4 fresh enrollment and independent local authentication. Original v3
Native authority remains unchanged.
