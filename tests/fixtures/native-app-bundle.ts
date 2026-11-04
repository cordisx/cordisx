import { createPackage } from '@electron/asar'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resources } from './native-submission-structure.js'
import { createDefaultHomeConfig } from '../../packages/cli/src/config/home-config.js'

export async function bundle(roots: string[], incompatible = false, scripts = resources(), entryHtml?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-app-'))
  roots.push(root)
  const contents = path.join(root, 'Fixture.app/Contents')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'webview/assets'), { recursive: true })
  await mkdir(path.join(contents, 'MacOS'), { recursive: true })
  await mkdir(path.join(contents, 'Resources'))
  const executable = path.join(contents, 'MacOS/Fixture')
  await mkdir(path.join(contents, 'Resources/cua_node/bin'), { recursive: true })
  for (
    const file of [
      executable,
      path.join(contents, 'Resources/codex'),
      path.join(contents, 'Resources/cua_node/bin/node'),
    ]
  ) {
    await writeFile(file, '#!/bin/sh\nexit 99\n')
    await chmod(file, 0o755)
  }
  await writeFile(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>unknown-version</string><key>CFBundleVersion</key><string>unknown-build</string></dict></plist>',
  )
  for (const resource of scripts) {
    const file = path.join(source, 'webview', new URL(resource.url).pathname)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      incompatible ? 'export {}' : resource.source,
    )
  }
  if (entryHtml !== undefined) await writeFile(path.join(source, 'webview/index.html'), entryHtml)
  await createPackage(source, path.join(contents, 'Resources/app.asar'))
  return { contents, executable }
}

export async function writeManagedProfile(homeDir: string, profileId: string): Promise<void> {
  await chmod(homeDir, 0o700)
  const config = createDefaultHomeConfig()
  await writeFile(
    path.join(homeDir, 'config.json'),
    JSON.stringify({
      ...config,
      apps: {
        codex: {
          defaultProfile: profileId,
          profiles: { [profileId]: { displayName: 'Fixture', dataMode: 'shared' } },
        },
      },
    }),
    { mode: 0o600 },
  )
}

export function pluginActivation(providers: Readonly<Record<string, { pluginId: string; modelId: string }>>) {
  return {
    nativeProviderIds: Object.keys(providers),
    prepareNativeConnection(providerId: string) {
      const provider = providers[providerId]
      if (provider === undefined) throw new Error('unknown fixture provider')
      return {
        value: {
          service: { pluginId: provider.pluginId, serviceId: 'gateway', generation: 'fixture-generation' },
          endpoint: {
            origin: `https://${providerId}.example.test`,
            apiPath: '/v1' as const,
            auth: { scheme: 'none' as const },
          },
          models: {
            generation: 'fixture-models',
            defaultAlias: provider.modelId,
            aliases: [{ alias: provider.modelId, gatewayModelId: provider.modelId }],
          },
          cleanup: { authorityId: 'fixture-generation' },
        },
        dispose() {},
      }
    },
    subscribeNativeProviders() {
      return () => {}
    },
  }
}
