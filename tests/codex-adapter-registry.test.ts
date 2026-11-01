import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ADAPTER_PACKAGE,
  ADAPTER_REGISTRY,
  ADAPTER_REPOSITORY,
  ADAPTER_WORKFLOW,
  resolveAdapterRelease,
  verifyAdapterArchive,
} from '../packages/cli/src/launcher/codex-adapter/registry.js'
const version = '0.1.0-beta.1'
const bytes = Buffer.from('synthetic package archive')
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
function fixture() {
  const tarball = `${ADAPTER_REGISTRY}@cordisx/codex-adapter/-/codex-adapter-${version}.tgz`
  const statement = {
    subject: [{
      name: `pkg:npm/%40cordisx/codex-adapter@${version}`,
      digest: { sha512: createHash('sha512').update(bytes).digest('hex') },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: ADAPTER_REPOSITORY,
            path: ADAPTER_WORKFLOW,
            ref: `refs/tags/codex-adapter-v${version}`,
          },
        },
        resolvedDependencies: [{
          uri: `git+${ADAPTER_REPOSITORY}@refs/tags/codex-adapter-v${version}`,
          digest: { gitCommit: 'a'.repeat(40) },
        }],
      },
    },
  }
  const manifest = {
    name: ADAPTER_PACKAGE,
    version,
    deprecated: '',
    dist: {
      integrity,
      tarball,
      signatures: [{
        keyid: 'test',
        sig: sign('sha256', Buffer.from(`${ADAPTER_PACKAGE}@${version}:${integrity}`), keys.privateKey).toString(
          'base64',
        ),
      }],
      attestations: { url: `${ADAPTER_REGISTRY}-/npm/v1/attestations/test` },
    },
  }
  const packument = {
    'dist-tags': { beta: version, latest: version },
    versions: { [version]: manifest },
    time: { [version]: '2026-11-01T00:00:00Z' },
  }
  const verify = vi.fn(async () => {})
  const get = vi.fn(async (url: string) => {
    if (url.endsWith('/keys')) {
      return Buffer.from(
        JSON.stringify({
          keys: [{ keyid: 'test', key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }],
        }),
      )
    }
    if (url.includes('/attestations/')) {
      return Buffer.from(
        JSON.stringify({
          attestations: [{
            predicateType: 'https://slsa.dev/provenance/v1',
            bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } },
          }],
        }),
      )
    }
    return Buffer.from(JSON.stringify(packument))
  })
  return { statement, manifest, packument, verify, get }
}
describe('adapter registry trust policy', () => {
  it('pins the exact version/source/integrity and verifies npm ECDSA plus the release workflow identity', async () => {
    const f = fixture()
    const release = await resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify })
    expect(release).toMatchObject({ version, integrity, sourceCommit: 'a'.repeat(40) })
    expect(f.verify).toHaveBeenCalledWith(expect.anything(), {
      certificateIdentityURI: `${ADAPTER_REPOSITORY}/${ADAPTER_WORKFLOW}@refs/tags/codex-adapter-v${version}`,
      certificateIssuer: 'https://token.actions.githubusercontent.com',
    })
    expect(verifyAdapterArchive(bytes, integrity)).toHaveLength(64)
    expect(() => verifyAdapterArchive(Buffer.from('tampered'), integrity)).toThrow('integrity')
  })
  it('rejects a bad registry signature even when a claimed hash matches', async () => {
    const f = fixture()
    f.manifest.dist.signatures[0]!.sig = Buffer.alloc(64).toString('base64')
    await expect(resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify })).rejects.toThrow('signature')
    expect(f.verify).not.toHaveBeenCalled()
  })
  it('requires cryptographically verified provenance, not a metadata repository claim', async () => {
    const f = fixture()
    f.verify.mockRejectedValue(new Error('untrusted certificate'))
    await expect(resolveAdapterRelease(version, { fetch: f.get, verify: f.verify })).rejects.toThrow(
      'untrusted certificate',
    )
  })
  it.each(['source', 'subject', 'workflow'])(
    'rejects a mismatched provenance %s after signature verification',
    async kind => {
      const f = fixture()
      if (kind === 'source') {
        f.statement.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/other/repo'
      }
      if (kind === 'subject') f.statement.subject[0]!.digest.sha512 = '0'.repeat(128)
      if (kind === 'workflow') f.statement.predicate.buildDefinition.externalParameters.workflow.path = 'other.yml'
      await expect(resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify })).rejects.toThrow(
        /mismatch|differs/u,
      )
    },
  )
  it('rejects source redirects and withdrawn versions', async () => {
    const f = fixture()
    f.manifest.dist.tarball = 'https://untrusted.example/a.tgz'
    await expect(resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify })).rejects.toThrow('source')
    f.manifest.deprecated = 'withdrawn'
    await expect(resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify })).rejects.toThrow('withdrawn')
  })
  it('rejects channel rollback/replay but permits an explicit exact rollback', async () => {
    const f = fixture()
    await expect(
      resolveAdapterRelease('beta', { fetch: f.get, verify: f.verify, highWatermark: '2026-11-02T00:00:00Z' }),
    ).rejects.toThrow('replay')
    await expect(
      resolveAdapterRelease(version, { fetch: f.get, verify: f.verify, highWatermark: '2026-11-02T00:00:00Z' }),
    ).resolves.toMatchObject({ version })
  })
  it.each(['latest', '^1.0.0', '../malicious', 'https://example.com/x.tgz'])(
    'rejects arbitrary selector %s',
    async selector => {
      const f = fixture()
      await expect(resolveAdapterRelease(selector, { fetch: f.get, verify: f.verify })).rejects.toThrow('Choose')
      expect(f.get).not.toHaveBeenCalled()
    },
  )
})
