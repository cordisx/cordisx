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
