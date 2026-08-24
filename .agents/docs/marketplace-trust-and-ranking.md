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

Neither dimension grants plugin permissions, lowers sensitivity, bypasses the
Permission Broker, changes sandbox or lifecycle gates, or replaces install
review. Both are provenance shown by the Host. Certification means that the
exact artifact was reviewed under the named policy; it is not an absolute
safety guarantee.

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
cannot preserve an already expired badge.

## Search contract

Search uses a lexicographic contract rather than one unbounded popularity
score:

1. remove incompatible, invisible, and policy-blocked entries;
2. apply the optional `Certified only` filter;
3. assign a text tier: exact identity, exact name, primary prefix, all primary
   terms, all catalog terms, partial catalog, or unqueried browse;
4. inside that same tier add one bounded point for active Official and one
   separately reported bounded point for active Certified; and
5. break any remaining tie by canonical plugin identity.

Trust can move a result by at most two points inside one text tier. It cannot
move a description-only match ahead of an exact id/name result. The Host keeps
the text tier, text score, both individual boosts, bounded total, and stable
identity as a machine-readable explanation used by tests and diagnostics.

## Manager projection

The Manager owns both indicators, their Material icons, tooltip, accessible
name, placement, policy copy, and cleanup. The indicators sit next to the
plugin name and do not create a separate information card. Detail content
explains Official as maintainer identity and Certified as an exact-version
review under policy X, with the non-guarantee statement. Record labels and
descriptions retain `LocalizedText` keys and required fallbacks; ordinary feed
names and descriptions use Marketplace locale fallback independently.

The consumer does not change installation or activation authority. If package
installation is added to this browse-only Manager later, it may include the two
records as provenance in its review screen, but the existing Package Store,
generation fence, Permission Broker, sandbox boundary, and lifecycle gates
remain authoritative.
