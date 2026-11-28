import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startPluginGenerationArtifactServer } from '../../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../../packages/cli/src/plugin-lifecycle-contracts.js'

export function managerFixtureActivation(kind: 'active' | 'candidate', moduleGeneration?: string) {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: kind,
    ...(kind === 'candidate' ? { transactionId: 'transaction' } : {}),
    profileId: 'fixture',
    revision: kind === 'candidate' ? 1 : 0,
    lastGoodRevision: 0,
    runtimeGeneration: 'generation',
    plugins: moduleGeneration === undefined ? [] : [{
      id: 'fixture',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      enabled: true,
      moduleGeneration,
      dependencies: [],
    }],
  }
}

/** Isolated immutable graph; it never uses user configuration or credentials. */
export async function managerRendererGraphFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-graph-'))
  const source = Buffer.from("export const name = 'fixture'\n")
  await writeFile(path.join(directory, 'module.js'), source)
  await writeFile(
    path.join(directory, 'artifact.json'),
    JSON.stringify({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-generation-artifact.v1.schema.json',
      contract: 'cordisx.plugin-generation-artifact/v1',
      schemaVersion: 1,
      format: 'browser-esm-graph',
      entry: './module.js',
      initialStyles: [],
      sharedImports: [],
      files: [{
        path: './module.js',
        kind: 'module',
        mediaType: 'text/javascript',
        digest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
        byteLength: source.byteLength,
        imports: [],
        dynamicImports: [],
        styles: [],
        assets: [],
      }],
    }),
  )
  const server = await startPluginGenerationArtifactServer()
  const lease = async (generation: string) =>
    await server.lease({
      packageIdentity: { pluginId: 'fixture', version: '1', integrity: `sha256:${'a'.repeat(64)}` },
      artifactDirectory: directory,
      runtimeEntry: './module.js',
    }, generation)
  return {
    lease,
    source: source.toString('utf8'),
    async close() {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
