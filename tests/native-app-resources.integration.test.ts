import { createPackage } from '@electron/asar'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import { readNativeSubmissionResources } from '../packages/cli/src/launcher/native-app-resources.js'
import { resources } from './fixtures/native-submission-structure.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function bundle(incompatible = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-app-'))
  roots.push(root)
  const contents = path.join(root, 'Fixture.app/Contents')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'webview/assets'), { recursive: true })
  await mkdir(path.join(contents, 'MacOS'), { recursive: true })
  await mkdir(path.join(contents, 'Resources'))
  const executable = path.join(contents, 'MacOS/Fixture')
  for (const file of [executable, path.join(contents, 'Resources/codex')]) {
    await writeFile(file, '#!/bin/sh\nexit 99\n')
    await chmod(file, 0o755)
  }
  await writeFile(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>unknown-version</string><key>CFBundleVersion</key><string>unknown-build</string></dict></plist>',
  )
  for (const resource of resources()) {
    await writeFile(
      path.join(source, 'webview/assets', path.basename(resource.url)),
      incompatible ? 'export {}' : resource.source,
    )
  }
  await createPackage(source, path.join(contents, 'Resources/app.asar'))
  return { contents, executable }
}

it('reads the actual ASAR resource layout without relying on asset hash names', async () => {
  const f = await bundle()
  expect(readNativeSubmissionResources(f.contents).map(resource => resource.url).sort())
    .toEqual(resources().map(resource => resource.url).sort())
})

it.skipIf(process.platform !== 'darwin')(
  'creates and cleans the real composition for an unknown App identity without executing its binaries',
  async () => {
    const f = await bundle()
    const prepareNativeConnection = vi.fn()
    const composition = await createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection },
      f.executable,
    )
    try {
      expect(composition.installation.transforms).toHaveLength(2)
      expect(composition.environment.CORDISX_NATIVE_REAL_CODEX_PATH).toBe(
        await realpath(path.join(f.contents, 'Resources/codex')),
      )
      expect(prepareNativeConnection).not.toHaveBeenCalled()
    } finally {
      await composition.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'rejects a truly incompatible App before starting credential or control services',
  async () => {
    const f = await bundle(true)
    const prepareNativeConnection = vi.fn()
    await expect(createNativeSubmissionComposition({ nativeProviderIds: [], prepareNativeConnection }, f.executable))
      .rejects.toThrow('Native capability submit-guard')
    expect(prepareNativeConnection).not.toHaveBeenCalled()
  },
)
