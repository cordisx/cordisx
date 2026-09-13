# Host-profile local wallet authority

The normative [HTTP v4 contract](https://github.com/cordisx/cordisx-protocol/blob/main/.agents/docs/plugin-http/v4.md)
defines fresh enrollment, independent local authentication and signed classified
work observations. V4 preserves the v1/v2/v3 methods. Consumers may accept the
v4 discriminator as the successor and use the added methods; an older Host
cannot advertise these operations.

`connectLocalAccount` opens an already enrolled profile and exact canonical
loopback origin/instance. Only `local-wallet-not-enrolled` permits a consumer to
start enrollment. Prepared or submitted enrollment returns
`local-wallet-reconciliation-required`; explicit local revocation returns
`local-wallet-revoked`. Key, transport, owner and generation failures do not
become absence. A consumer must verify its saved immutable original account
against a fresh original Native connection before requesting enrollment.

`enrollLocalWallet` accepts that consumer's fresh owned Native-pinned connection.
It rejects arbitrary bearer handles, retained sessions, another owner and retired
Native authority. The existing original-account issuer signs one domain-separated
payload containing the original Native subject, new local public key and its
hash-derived subject, nonce, expiry and complete target. The Host forwards only
the original source session bearer; Native credentials never travel to the
server. The server must resolve that same verified original account and retain
its existing balance, ledger, orders and work frontier. A signed receipt must
confirm the same immutable account ID before Host activation.

The Launcher stores one persistent Ed25519 key for each Host profile in Keychain,
using canonical one-line PKCS8 DER/base64. Its private registry is
`state/profiles/<profileId>/local-wallet.json`; it contains public key, opaque
key reference, revision and exact origin/instance delegations. Different source
names share that profile key and canonical realm. Different profiles may enroll
independent keys through fresh proof to the same existing account; a different
work scope still fails the original issuer's scope policy.

Registration uses an exclusive process lock, owner-only files and atomic rename.
Every enrollment commit checks fresh original Native authority and current
owner, trust and deadline. The submitted state is durable before the enrollment
POST. An unknown or invalid result preserves that key and pending state; ordinary
consumers cannot select an account ID, recreate authority or replay migration.
Missing private keys fail closed. Stored active receipts are verified against
the enrolled peer and original account when loading the registry. Explicit
trusted Host administration can revoke an entry through the registry transition;
this is separate from automatic first enrollment.

After enrollment, local authentication and work signatures use the enrolled
profile key. Local HTTP grants retain profile registry and owner/client fences,
including exchanged child grants. Cloud Native logout or switch does not select
a different local wallet. Local connection revoke or owner disposal closes
work continuity when no live sibling remains. Explicit delegation revoke or a
changed profile registry revision invalidates all grants using that revision.
Local handles cannot enter v2 Native-bound retained-session storage; reopening
performs a new local handshake with the persistent key.

`submitLocalWorkUsage` reads the Launcher-owned classified work-v2 ledger and
signs no caller snapshot, amount or scope. Auth and work use the same enrolled
subject and original account; work uses the independently provisioned original
work-income peer pin. Baselines, uncertain-send recovery, original history
retirement checks and server frontier deduplication remain required. A queued
operation that expires cannot clear a live sibling's observation. Every public
operation shares its original absolute deadline through credential allocation;
late allocated credentials are retired without relying on Renderer delivery.

Source implementation and automated source tests do not prove that an existing
runtime wallet has migrated. Runtime adoption and original-wallet ownership
verification must complete separately before recording actual acceptance.
