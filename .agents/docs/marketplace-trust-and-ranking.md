# Marketplace trust and ranking

Status: implemented Host consumer contract for the public Marketplace v3 trust
records owned by `cordisx-protocol` and the protected catalog owned by
`cordisx/marketplace`.

## Two independent dimensions

`Official` and `CordisX Certified` are deliberately not aliases.

- **Official** describes publisher and maintainer identity. An active record
  binds the plugin id, canonical CordisX source repository, `npm:@cordisx`
  publisher identity, `@cordisx` namespace, and exact package name. It may
  continue across versions while all those identity fields remain unchanged.
  A source, publisher, namespace, or package-name migration requires a new
  protected verification record.
- **CordisX Certified** describes the review state of one immutable artifact.
  An active record binds plugin id, semantic version, canonical source, and
  `sha256` integrity together with the review policy version, review time,
  expiry, reviewer authority, and evidence reference. A new version or digest
  has no certification until it receives its own record. Third-party artifacts
  can be Certified; an Official artifact is not Certified automatically.

Official never changes plugin permissions. Certification means that the exact
artifact was reviewed under the named policy and its code conforms to that
policy version; it is not an absolute safety guarantee. A separate Host-owned
`MarketplaceCertifiedPermissionProjectionV1` exposes the verified exact
artifact as a read-only PermissionBroker eligibility input. Only DOM/render
capabilities explicitly marked `certifiedImplicitApproval` in the permission
catalog may omit explicit confirmation. The PermissionBroker still owns and
audits the resulting grant/lease, fences it by scope, profile, generation, and
certification fingerprint, and revokes it when the projection disappears or
changes. All other capabilities follow the normal confirmation path. Neither
dimension changes sandbox, lifecycle, or installation review.

## Trust root and revocation

The Host accepts discovery metadata from configured HTTPS feeds, but projects
Official or Certified state only when all of these conditions hold:

1. the fetched URL is in the Host's configured trust-root set;
2. `trust.root` is exactly the fetched canonical URL;
3. the authority is `cordisx.marketplace.codeowners/v1`;
4. the grant model is `protected-merge-chain-v1`; and
5. the feed states honestly that cryptographic attestation is unsupported.

Version 1 therefore trusts the Marketplace repository's protected
CODEOWNERS/required-CI merge chain. It does not claim package signatures or a
cryptographic attestation that does not exist. Unknown authorities, a trust
root mismatch, missing digest, identity mismatch, duplicate or unstable
records, future review times, and invalid active/revoked/expired intervals make
the feed invalid. Plugin manifest fields named `official`, `certified`, or
similar remain unknown manifest fields and cannot establish trust.

Each reload evaluates a fresh feed snapshot. Revoked and expired records are
validated but not projected. An updated feed can therefore remove the
Certified marker without changing an independent Official marker. The Host
also compares active certification expiry with local time so a stale feed
cannot preserve an already expired badge. `feed.generatedAt` is the projection
revision: a replacement older than the last-good trusted feed is rejected, so
an older active record cannot replay over a later revocation.

## Search contract

Search uses a lexicographic contract rather than one unbounded popularity
score:

1. remove incompatible, invisible, and policy-blocked entries;
2. apply the optional `Certified only` filter;
3. assign a text tier: exact identity, exact name, primary prefix, all primary
   terms, all catalog terms, partial catalog, or unqueried browse;
4. inside that same tier add one bounded product-priority point for active
   Official; Certified never changes ordering; and
5. break any remaining tie by canonical plugin identity.

Official can move a result by at most one point inside one text tier. It cannot
move a description-only match ahead of an exact id/name result. The Host keeps
the text tier, text score, Official priority, and stable identity as a
machine-readable explanation used by tests and diagnostics. Certified remains
an independent display dimension and `Certified only` filter.

## Manager projection

The Manager owns both indicators, their Material icons, tooltip, accessible
name, placement, policy copy, and cleanup. The indicators sit next to the
plugin name and do not create a separate information card. Detail content
explains Official as maintainer identity and Certified as an exact-version
review under policy X, with the non-guarantee statement. Record labels and
descriptions retain `LocalizedText` keys and required fallbacks; ordinary feed
names and descriptions use Marketplace locale fallback independently.

The browse toolbar exposes one Host-owned `仅看已认证` pressed-state filter.
Each rendered result retains the text tier, Official priority, and a
human-readable explanation that explicitly says Certified does not rank, in
structured Host data attributes. The standard plugin card accessible name includes the two active
dimensions independently. The detail projection links the protected evidence
reference and states the exact policy/version, reviewed version, digest,
timestamps, protected-merge trust root, and absence of cryptographic
attestation. A `ManagerModel.marketplaceEligibility` projection is evaluated
before search scoring so compatibility, visibility, and policy authority stay
Host-owned instead of becoming feed-controlled ranking inputs.

The Marketplace consumer does not contain a permission allowlist and never
creates a grant. It publishes only the exact, immutable Certified projection;
the permission catalog and PermissionBroker remain the sole policy and grant
authorities. Package Store, generation fences, sandbox, lifecycle, and install
review remain authoritative.

The real-renderer smoke may project
`tests/fixtures/marketplace-trust-v3.json` into the existing Marketplace
receiver by using `--manager-marketplace-fixture`. This isolated test-only
response seam requires an explicit HTTPS source, fixes request identity only
during the synchronous test form submission, and lets the ordinary pending
request fence ignore the launcher's later network response. It does not replace
the Host binding, add a production trust root, or claim the fixture artifact
exists. Light and dark screenshots plus the machine report must show both
independent badge/icon/accessible labels or the two independent detail sections
and boundary copy.
