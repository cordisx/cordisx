import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V10 } from '../extension-point-interaction-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V13,
} from '../runtime-exact-request-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V11 } from '../usage-permissions.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V14 } from './latest-runtime-manifest.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V10,
  PLUGIN_PACKAGE_SCHEMA_V11,
  PLUGIN_PACKAGE_SCHEMA_V12,
  PLUGIN_PACKAGE_SCHEMA_V13,
  PLUGIN_PACKAGE_SCHEMA_V14,
  PLUGIN_PACKAGE_SCHEMA_V7,
  PLUGIN_PACKAGE_SCHEMA_V8,
  PLUGIN_PACKAGE_SCHEMA_V9,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V9,
} from './packages/manifest.js'

const DIGEST = /^sha256:[a-f0-9]{64}$/u
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/u

export function declaredRuntimeManifestSchema(manifest: Record<string, unknown>): string | undefined {
  const declaration = manifest.runtimeManifest
  const declaredSchema = declaration !== null && typeof declaration === 'object' && !Array.isArray(declaration)
    ? (declaration as Record<string, unknown>).schema
    : undefined
  return manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V7 && manifest.schemaVersion === 7
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V8 && manifest.schemaVersion === 8
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V9 && manifest.schemaVersion === 9
    ? declaredSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8
      ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8
      : PLUGIN_RUNTIME_MANIFEST_SCHEMA_V9
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V10 && manifest.schemaVersion === 10
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V10
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V11 && manifest.schemaVersion === 11
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V11
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V12 && manifest.schemaVersion === 12
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V12
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V13 && manifest.schemaVersion === 13
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V13
    : manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V14 && manifest.schemaVersion === 14
    ? PLUGIN_RUNTIME_MANIFEST_SCHEMA_V14
    : undefined
}

export async function localDevelopmentManifestIdentity(root: string): Promise<string | undefined> {
  try {
    const packageManifest = JSON.parse(await readFile(path.join(root, 'cordisx-package.json'), 'utf8')) as unknown
    if (packageManifest === null || typeof packageManifest !== 'object' || Array.isArray(packageManifest)) {
      return undefined
    }
    const manifest = packageManifest as Record<string, unknown>
    const id = manifest.id
    const runtimeSchema = declaredRuntimeManifestSchema(manifest)
    if (typeof id !== 'string' || !PLUGIN_ID.test(id) || runtimeSchema === undefined) return undefined

    const runtimeReference = manifest.runtimeManifest
    if (runtimeReference === null || typeof runtimeReference !== 'object' || Array.isArray(runtimeReference)) {
      return undefined
    }
    const declaration = runtimeReference as Record<string, unknown>
    if (
      typeof declaration.path !== 'string'
      || !/^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json$/u.test(declaration.path)
      || declaration.schema !== runtimeSchema
      || typeof declaration.digest !== 'string'
      || !DIGEST.test(declaration.digest)
    ) return undefined

    const runtimeManifestFile = path.resolve(root, declaration.path.slice(2))
    if (!runtimeManifestFile.startsWith(`${path.resolve(root)}${path.sep}`)) return undefined
    const runtimeText = await readFile(runtimeManifestFile, 'utf8')
    const actualDigest = `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`
    if (actualDigest !== declaration.digest) return undefined
    const runtimeManifest = JSON.parse(runtimeText) as unknown
    if (runtimeManifest === null || typeof runtimeManifest !== 'object' || Array.isArray(runtimeManifest)) {
      return undefined
    }
    const runtime = runtimeManifest as Record<string, unknown>
    return runtime.$schema === runtimeSchema && runtime.id === id ? id : undefined
  } catch {
    return undefined
  }
}
