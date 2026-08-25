# PublisherGrant Host integration seam

Status: implemented launcher seam; activation-registry deployment is blocked on
an owning service repository. This document is not a claim that paid-package
installation or a payment flow is live.

## Ownership and boundary

| Surface | Owner | Current state |
| --- | --- | --- |
| Statement/commerce schema and vectors | `cordisx-protocol` | formally merged at `cf78bd5` |
| Signature verification, device proof, trusted time, lifecycle gate | `cordisx` launcher | this delivery |
| UI copy and external link rendering | Host Manager after a Marketplace v4 consumer | planned |
| Issuer key registration and activation registry | dedicated service owner | blocked; no repo is assigned |
| Payment, checkout, webhook, refunds, tax, invoices, KYC | publisher | intentionally out of scope |

The launcher passes only a Host-resolved package identity/version to the gate.
It does not expose key material, grant JSON, registry credentials, or a raw
bridge to the renderer. A grant controls CordisX lifecycle and feature
projection only; it cannot stop copied code running outside CordisX.

## State machine

```text
received -> parse -> issuer-key lookup -> signature verified -> target/version/device checked
  -> time valid -> registry activation request (nonce + device proof)
  -> atomically activated / same-device idempotent -> persist max(trusted time) -> active
                                                     -> refresh due -> renew -> active
time beyond expiresAt -> offline grace -> expired
any invalid signature/key/device/target/time -> rejected
registry absent/unreachable -> unavailable (no local activation)
registry says another device -> rejected
```

`revoke` and `transfer` are verified statement types but are not executable in
the seam until registry operations are supplied by the owning service. A
transfer always needs a publisher statement; a user cannot make a new device
by copying local state. Reinstall/key loss is a new device. Separate
`CORDISX_HOME` values share an authorization only if the eventual Host key
provider returns the same device key.

## Threat model and controls

| Threat | Control | Residual boundary |
| --- | --- | --- |
| Forged or altered grant | Host-registered Ed25519 key and canonical signing input | issuer key compromise needs rotation/revoke |
| Sandbox/live confusion | registry lookup includes environment | operational key registry still required |
| Replayed statement/activation | statement id and registry idempotency tuple; nonce-bound device proof | atomic uniqueness is impossible without deployed registry |
| Copy grant to another machine | device-key hash and proof; registry rejects different active hash | same private key theft remains an endpoint compromise |
| Wall-clock rollback | persist non-decreasing registry-attested time | no trustworthy time before first registry attestation |
| Offline/network failure | bounded `expiresAt + offlineGraceSeconds` | new activation never falls back locally |
| Payment/refund inference | no payment inputs or webhooks exist | publisher must issue revoke/renew |

## Required service contract before wiring package lifecycle

The service must atomically bind `(issuer, grantId)` to one `(pluginId,
devicePublicKeyHash, activationStatus)` in its declared environment, verify the
device proof and nonce, return idempotent success only for the same binding,
and provide an authenticated server time. It must never accept or persist
amount, currency, order, payment status, payment evidence, or processor
webhooks. Until that owner and deployment exist, the Host gate is deliberately
fail-closed and package lifecycle remains on the existing explicit-local path.
