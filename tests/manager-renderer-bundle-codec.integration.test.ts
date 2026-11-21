import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  decodeManagerRendererBundle,
  encodeManagerRendererBundle,
  MANAGER_BUNDLE_RPC_LIMIT,
} from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'

it('fits the actual standalone Host bundle in the current private management RPC frame', async () => {
  const config: CordisXConfig = {
    version: 1,
    rootDir: process.cwd(),
    codex: { debugPort: 0 },
    providers: [],
    plugins: [],
  }
  // This builds the real Host bundle with the currently supported isolated
  // standalone presentation; it does not claim a production attachment.
  const source = await buildRendererBundle(config, {
    playground: true,
    managerPresentationMode: 'standalone',
    profileId: 'playground',
  })
  const bytes = Buffer.from(source)
  const encoded = await encodeManagerRendererBundle(bytes)
  const frame = `${
    JSON.stringify({
      requestId: 'x'.repeat(128),
      ok: true,
      value: { status: 'ok', value: encoded },
    })
  }\n`
  expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MANAGER_BUNDLE_RPC_LIMIT)
  const decoded = await decodeManagerRendererBundle(encoded)
  expect(decoded.byteLength).toBe(bytes.byteLength)
  expect(createHash('sha256').update(decoded).digest('hex'))
    .toBe(createHash('sha256').update(bytes).digest('hex'))
}, 30_000)
