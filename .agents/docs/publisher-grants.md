# PublisherGrant Host integration seam

Status: direct-device-bound launcher authority implemented. Registry activation
is an optional enhancement, not a prerequisite for this mode. This document is
not a claim that paid-package installation or a payment flow is live.

## Ownership and boundary

| Surface | Owner | Current state |
| --- | --- | --- |
| Statement/commerce schema and vectors | `cordisx-protocol` | formally merged at `8391922` |
| Signature verification, device proof, trusted time, lifecycle gate | `cordisx` launcher | formally merged at `be523daf` |
| Marketplace v4 parsing and Manager authorization controls | `cordisx` Host | this delivery candidate |
| Issuer key registration | `config.publisherGrantIssuers` in Host-private home configuration | this delivery candidate |
| Optional activation registry | dedicated service owner | planned enhancement |
| Payment, checkout, webhook, refunds, tax, invoices, KYC | publisher | intentionally out of scope |

The Manager can request only a public device challenge, import a statement, or
read a scoped authorization projection through a narrow launcher binding. It
does not expose key material, registry credentials, or a raw bridge to the
renderer. Issuer keys are explicit base64url SPKI registrations in the private
home configuration, keyed by `(environment, issuer id, key id)`; Marketplace
metadata never registers a signer. A grant controls CordisX lifecycle and feature
projection only; it cannot stop copied code running outside CordisX.

## State machine

```text
received -> parse -> issuer-key lookup -> signature verified -> target/version/device checked
  -> direct-device-bound -> persist non-decreasing trusted time -> active
                        -> refresh due -> renew -> active
  -> optional registry-enhanced -> registry request (nonce + device proof) -> active
time beyond expiresAt -> offline grace -> expired
any invalid signature/key/device/target/time -> rejected
registry absent/unreachable -> direct mode remains usable
registry says another device -> rejected
```

`revoke` imports locally and applies to the matching stored grant. `renew`
replaces that publisher declaration. `transfer` is intentionally not executed
locally: the publisher must issue a new direct-bound grant for the new device.
A user cannot make a new device by copying local state. Reinstall/key loss is a new device. Separate
`CORDISX_HOME` values share an authorization only if the eventual Host key
provider returns the same device key.

The signed-statement store is always rooted at
`${CORDISX_HOME || ~/.cordisx}/state/publisher-grants`, including `cordisx dev`
with a direct plugin entry or a project configuration. The development project
root remains responsible only for resolving source, configuration-relative
paths, and project-scoped launch defaults; it is never the Host persistence
root. Running a development command from a repository therefore does not write
PublisherGrant state into that repository.

## Threat model and controls

| Threat | Control | Residual boundary |
| --- | --- | --- |
| Forged or altered grant | Host-registered Ed25519 key and canonical signing input | issuer key compromise needs rotation/revoke |
| Sandbox/live confusion | issuer key lookup includes environment | production issuer registration is required |
| Replayed statement | statement id is byte-fingerprinted | direct grants are pre-bound, not generic redemption codes |
| Copy grant to another machine | device-key hash and local proof of possession | same private key theft remains an endpoint compromise |
| Wall-clock rollback | persist non-decreasing accepted statement time | no global clock oracle in a fully offline flow |
| Offline/network failure | bounded `expiresAt + offlineGraceSeconds` | new activation never falls back locally |
| Payment/refund inference | no payment inputs or webhooks exist | publisher must issue revoke/renew |

## Optional registry enhancement

The service must atomically bind `(issuer, grantId)` to one `(pluginId,
devicePublicKeyHash, activationStatus)` in its declared environment, verify the
device proof and nonce, return idempotent success only for the same binding,
and provide an authenticated server time. It must never accept or persist
amount, currency, order, payment status, payment evidence, or processor
webhooks. Its absence does not block direct-device-bound grants. The current
package lifecycle remains explicit-local until a paid-package manifest/offer
consumer is delivered; the gate's authority remains Host-only.

## Launcher integration

This implementation detail is linked from the
[architecture overview](architecture.md#publishergrant-authorization-seam);
it does not redefine the Protocol grant format.

`launcher/publisher-grants.ts` is a launcher-only seam for the normative
`publisher-grant.v1` protocol. It verifies a Host-registered Ed25519 issuer
key, creates or retrieves one macOS Keychain machine identity outside
`CORDISX_HOME`, and keeps signed-grant/import state inside each selected home.
This persistence boundary also applies to direct-entry and config-based
development launches: project/config roots resolve project inputs, while the
PublisherGrant store remains under `CORDISX_HOME/state/publisher-grants`.
Their default project-scoped Chromium profile likewise remains below the
selected `CORDISX_HOME/projects`; only an explicit `--profile-dir` relocates
that profile. Non-dry development applies the canonical CordisX Home ownership,
real-directory, and `0700` policy before either write, and creates new default
or explicit profile directories as `0700`. Dry-run development performs
neither write.
The default `direct-device-bound` path accepts a publisher grant only when its
public-key digest matches that machine identity; no CordisX registry is needed.
It persists a non-decreasing accepted-statement time for expiry/offline grace.
An optional registry-enhanced request may add first-claim semantics but cannot
block the direct path when absent. Marketplace v4 may expose external purchase,
manage, and recovery URLs; the Host adds the device challenge only at navigation
time. A narrow launcher binding offers the Manager challenge, scoped status,
and statement import but no private key, payment data, registry credential, or
raw bridge. There is no local-file private-key fallback.

The Host gates CordisX package/feature projection only; it does not claim to
stop source or a modified Host outside CordisX. It never receives payment,
order, price, currency, refund, tax, invoice, chargeback, settlement, or KYC
data, and no payment webhook exists in this architecture.
