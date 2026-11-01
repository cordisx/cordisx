import { createHash, verify as verifySignature } from 'node:crypto'
import { verify as verifySigstore } from 'sigstore'

export const ADAPTER_PACKAGE = '@cordisx/codex-adapter'
export const ADAPTER_REGISTRY = 'https://registry.npmjs.org/'
export const ADAPTER_REPOSITORY = 'https://github.com/cordisx/cordisx'
export const ADAPTER_WORKFLOW = '.github/workflows/adapter-release.yml'
export const exactAdapterVersion = (value: string): boolean =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(value)
export interface AdapterRelease {
  readonly version: string
  readonly integrity: string
  readonly tarball: string
  readonly publishedAt: string
  readonly sourceCommit: string
  readonly workflowIdentity: string
}
export type RegistryFetch = (url: string, maxBytes: number) => Promise<Buffer>

/** No npm configuration, credentials, registry overrides, redirects or lifecycle scripts. */
export const registryFetch: RegistryFetch = async (url, maxBytes) => {
  const parsed = new URL(url)
  if (parsed.origin !== new URL(ADAPTER_REGISTRY).origin || parsed.username || parsed.password) {
    throw new Error('Untrusted adapter origin')
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok || !response.body) throw new Error(`Adapter registry HTTP ${response.status}`)
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = response.body.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const chunk = next.value
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error('Adapter registry response exceeds size budget')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const json = async (get: RegistryFetch, url: string): Promise<any> =>
  JSON.parse((await get(url, 8 * 1024 * 1024)).toString('utf8'))

/** Implement the npm registry's documented ECDSA envelope; Sigstore owns provenance verification. */
export async function resolveAdapterRelease(
  selector: string,
  options: { fetch?: RegistryFetch; verify?: typeof verifySigstore; highWatermark?: string } = {},
): Promise<AdapterRelease> {
  if (!['stable', 'beta'].includes(selector) && !exactAdapterVersion(selector)) {
    throw new Error('Choose stable, beta or an exact adapter version')
  }
  const get = options.fetch ?? registryFetch
  const packument = await json(get, `${ADAPTER_REGISTRY}@cordisx%2fcodex-adapter`)
  const discovered = selector === 'stable' || selector === 'beta'
  const version = discovered ? packument['dist-tags']?.[selector === 'stable' ? 'latest' : 'beta'] : selector
  if (typeof version !== 'string' || !exactAdapterVersion(version)) {
    throw new Error('Adapter channel has no exact version')
  }
  const manifest = packument.versions?.[version]
  const publishedAt = packument.time?.[version]
  if (
    manifest?.name !== ADAPTER_PACKAGE || manifest.version !== version || manifest.deprecated
    || typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))
  ) throw new Error('Adapter release unavailable or withdrawn')
  if (discovered && options.highWatermark && Date.parse(publishedAt) < Date.parse(options.highWatermark)) {
    throw new Error('Adapter channel replay/downgrade rejected; select an exact version for an intentional rollback')
  }
  const dist = manifest.dist
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(dist?.integrity ?? '')) {
    throw new Error('Adapter release requires exact SHA-512 integrity')
  }
  const tarball = `${ADAPTER_REGISTRY}@cordisx/codex-adapter/-/codex-adapter-${version}.tgz`
  if (dist.tarball !== tarball) throw new Error('Adapter tarball source is not the trusted package path')
  const keys = await json(get, `${ADAPTER_REGISTRY}-/npm/v1/keys`)
  const signed = (dist.signatures ?? []).some((signature: any) => {
    const key = keys.keys?.find((key: any) => key.keyid === signature.keyid)
    if (!key || (key.expires && Date.parse(key.expires) <= Date.parse(publishedAt))) return false
    return verifySignature(
      'sha256',
      Buffer.from(`${ADAPTER_PACKAGE}@${version}:${dist.integrity}`),
      `-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`,
      Buffer.from(signature.sig, 'base64'),
    )
  })
  if (!signed) throw new Error('Adapter npm registry signature missing or invalid')
  const attestationUrl = dist.attestations?.url
  if (
    typeof attestationUrl !== 'string' || new URL(attestationUrl).origin !== new URL(ADAPTER_REGISTRY).origin
    || !new URL(attestationUrl).pathname.startsWith('/-/npm/v1/attestations/')
  ) throw new Error('Adapter provenance unavailable')
  const attestations = await json(get, attestationUrl)
  const workflowIdentity = `${ADAPTER_REPOSITORY}/${ADAPTER_WORKFLOW}@refs/tags/codex-adapter-v${version}`
  for (const record of attestations.attestations ?? []) {
    if (record.predicateType !== 'https://slsa.dev/provenance/v1') continue
    const bundle = record.bundle
    // Verifies certificate identity/issuer, signature, transparency log and trusted roots.
    await (options.verify ?? verifySigstore)(bundle, {
      certificateIdentityURI: workflowIdentity,
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    })
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
    const digest = Buffer.from(dist.integrity.slice(7), 'base64').toString('hex')
    if (
      statement.subject?.length !== 1 || statement.subject[0].name !== `pkg:npm/%40cordisx/codex-adapter@${version}`
      || statement.subject[0].digest?.sha512 !== digest
    ) throw new Error('Adapter provenance subject differs from pinned package')
    const definition = statement.predicate?.buildDefinition
    const source = definition?.externalParameters?.workflow
    const dependency = definition?.resolvedDependencies?.find((d: any) =>
      d.uri?.startsWith(`git+${ADAPTER_REPOSITORY}@`)
    )
    if (
      source?.repository !== ADAPTER_REPOSITORY || source.path !== ADAPTER_WORKFLOW
      || source.ref !== `refs/tags/codex-adapter-v${version}`
      || !/^[a-f0-9]{40}$/u.test(dependency?.digest?.gitCommit ?? '')
    ) {
      throw new Error('Adapter provenance source/workflow mismatch')
    }
    return {
      version,
      integrity: dist.integrity,
      tarball,
      publishedAt,
      sourceCommit: dependency.digest.gitCommit,
      workflowIdentity,
    }
  }
  throw new Error('Adapter has no verified release-workflow provenance')
}

export function verifyAdapterArchive(bytes: Buffer, integrity: string): string {
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error('Adapter archive integrity mismatch')
  }
  return createHash('sha256').update(bytes).digest('hex')
}
