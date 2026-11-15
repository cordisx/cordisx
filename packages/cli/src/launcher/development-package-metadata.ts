import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V16 } from '../channel-exact-request-permissions.js'
import type { PluginRuntimeManifestV16 } from '@cordisx/protocol/plugin-manifest/v16'
import type { PluginRuntimeManifestV15 } from '@cordisx/protocol/plugin-manifest/v15'
import type { PluginRuntimeManifestV14 } from '@cordisx/protocol/plugin-manifest/v14'
import type { CordisXPluginManifestV10 } from '../extension-point-interaction-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../extension-point-interaction-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V11 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V11,
  type CordisXPluginManifestV11,
  normalizeUsageManifestV11,
} from '../usage-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V12,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V13,
  type CordisXPluginManifestV12,
  type CordisXPluginManifestV13,
  normalizePluginManifestV12,
  normalizePluginManifestV13,
} from '../runtime-exact-request-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V14,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V15 as PLUGIN_RUNTIME_MANIFEST_SCHEMA_V15,
  normalizePluginManifestV14,
  normalizePluginManifestV15,
  normalizePluginManifestV16,
} from './latest-runtime-manifest.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V10,
  PLUGIN_PACKAGE_SCHEMA_V11,
  PLUGIN_PACKAGE_SCHEMA_V12,
  PLUGIN_PACKAGE_SCHEMA_V13,
  PLUGIN_PACKAGE_SCHEMA_V14,
  PLUGIN_PACKAGE_SCHEMA_V15,
  PLUGIN_PACKAGE_SCHEMA_V16,
  PLUGIN_PACKAGE_SCHEMA_V5,
  PLUGIN_PACKAGE_SCHEMA_V6,
  PLUGIN_PACKAGE_SCHEMA_V7,
  PLUGIN_PACKAGE_SCHEMA_V8,
  PLUGIN_PACKAGE_SCHEMA_V9,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V9,
} from './packages/manifest.js'
import type {
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginManifestV9,
} from '../permission-contracts.js'
import {
  normalizePluginManifestV7,
  normalizePluginManifestV8,
  normalizePluginManifestV9,
} from '../permission-model-v4.js'
import { CapabilityRiskCatalog } from '../capability-risk-catalog.js'
import { declaredRuntimeManifestSchema } from './development-manifest-identity.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type EntityTemplatePayload, readEntityTemplatePayload } from './entity-directory.js'

const ENTITY_FILE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/entity-file.v1.schema.json'
const LOCAL_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const ENTITY_TEMPLATE_PATH = /^\.\/entities\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/entity\.json$/u
const ENTITY_DIGEST = /^sha256:[a-f0-9]{64}$/u

export async function readRendererOnlyPackage(root: string): Promise<{
  readonly files: readonly string[]
  readonly entityTemplates: readonly EntityTemplatePayload[]
  readonly manifest?:
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
    | CordisXPluginManifestV11
    | CordisXPluginManifestV12
    | CordisXPluginManifestV13
    | PluginRuntimeManifestV16
    | PluginRuntimeManifestV14
    | PluginRuntimeManifestV15
}> {
  const manifestPath = path.join(root, 'cordisx-package.json')
  const text = await readFile(manifestPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (text === undefined) return { files: [], entityTemplates: [] }
  const manifest = JSON.parse(text) as Record<string, unknown>
  if (manifest.dependencies !== undefined && !Array.isArray(manifest.dependencies)) {
    throw new Error('local development package dependencies must be an array')
  }
  if (Array.isArray(manifest.dependencies) && manifest.dependencies.length > 0) {
    throw new Error('local development phase 1 is renderer-only; package dependencies are unavailable')
  }
  let runtimeManifest:
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
    | CordisXPluginManifestV9
    | CordisXPluginManifestV10
    | CordisXPluginManifestV11
    | CordisXPluginManifestV12
    | CordisXPluginManifestV13
    | PluginRuntimeManifestV16
    | PluginRuntimeManifestV14
    | PluginRuntimeManifestV15
    | undefined
  let runtimeManifestFile: string | undefined
  const runtimeManifestSchema = declaredRuntimeManifestSchema(manifest)
  const declaresVersionedManifest = manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V7 || manifest.schemaVersion === 7
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V8 || manifest.schemaVersion === 8
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V9 || manifest.schemaVersion === 9
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V10 || manifest.schemaVersion === 10
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V11 || manifest.schemaVersion === 11
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V12 || manifest.schemaVersion === 12
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V13 || manifest.schemaVersion === 13
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V14 || manifest.schemaVersion === 14
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V15 || manifest.schemaVersion === 15
    || manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V16 || manifest.schemaVersion === 16
  if (manifest.runtimeManifest !== undefined && runtimeManifestSchema !== undefined) {
    if (
      manifest.runtimeManifest === null || typeof manifest.runtimeManifest !== 'object'
      || Array.isArray(manifest.runtimeManifest)
    ) {
      throw new Error('local development runtimeManifest must be an object')
    }
    const declaration = manifest.runtimeManifest as Record<string, unknown>
    if (
      Object.keys(declaration).some(key => !['path', 'schema', 'digest'].includes(key))
      || typeof declaration.path !== 'string'
      || !/^\.\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json$/u.test(declaration.path)
      || declaration.schema !== runtimeManifestSchema
      || typeof declaration.digest !== 'string' || !ENTITY_DIGEST.test(declaration.digest)
    ) {
      throw new Error('local development runtimeManifest declaration is invalid')
    }
    runtimeManifestFile = path.resolve(root, declaration.path.slice(2))
    if (!runtimeManifestFile.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error('local development runtimeManifest escapes package root')
    }
    const runtimeText = await readFile(runtimeManifestFile, 'utf8')
    const actualDigest = `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`
    if (actualDigest !== declaration.digest) throw new Error('local development runtimeManifest digest mismatch')
    const packageId = manifest.id
    if (typeof packageId !== 'string') throw new Error('local development package id is required')
    runtimeManifest = runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V16
      ? normalizePluginManifestV16(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V15
      ? normalizePluginManifestV15(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V14
      ? normalizePluginManifestV14(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V13
      ? normalizePluginManifestV13(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V12
      ? normalizePluginManifestV12(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V11
      ? normalizeUsageManifestV11(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V10
      ? normalizeVisualManifestV10(JSON.parse(runtimeText) as unknown, packageId)
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V9
      ? normalizePluginManifestV9(JSON.parse(runtimeText) as unknown, packageId, new CapabilityRiskCatalog())
      : runtimeManifestSchema === PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8
      ? normalizePluginManifestV8(JSON.parse(runtimeText) as unknown, packageId, new CapabilityRiskCatalog())
      : normalizePluginManifestV7(JSON.parse(runtimeText) as unknown, packageId, new CapabilityRiskCatalog())
  } else if (manifest.runtimeManifest !== undefined && declaresVersionedManifest) {
    throw new Error(
      'local development runtimeManifest requires a supported exact plugin-package schema',
    )
  }
  if (manifest.entityTemplates === undefined) {
    return {
      files: [manifestPath, ...(runtimeManifestFile === undefined ? [] : [runtimeManifestFile])],
      entityTemplates: [],
      ...(runtimeManifest === undefined ? {} : { manifest: runtimeManifest }),
    }
  }
  if (
    !((manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V5 && manifest.schemaVersion === 5)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V6 && manifest.schemaVersion === 6)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V7 && manifest.schemaVersion === 7)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V8 && manifest.schemaVersion === 8)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V9 && manifest.schemaVersion === 9)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V10 && manifest.schemaVersion === 10)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V11 && manifest.schemaVersion === 11)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V12 && manifest.schemaVersion === 12)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V13 && manifest.schemaVersion === 13
        || manifest.schemaVersion === 16)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V14 && manifest.schemaVersion === 14)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V15 && manifest.schemaVersion === 15)
      || (manifest.$schema === PLUGIN_PACKAGE_SCHEMA_V16 && manifest.schemaVersion === 16))
  ) {
    throw new Error(
      'local development entityTemplates require plugin-package.v5 through plugin-package.v14 or plugin-package.v15',
    )
  }
  const compatibility = manifest.compatibility
  if (
    compatibility === null || typeof compatibility !== 'object' || Array.isArray(compatibility)
    || !Array.isArray((compatibility as Record<string, unknown>).protocolSchemas)
    || !(compatibility as { readonly protocolSchemas: readonly unknown[] }).protocolSchemas.includes(
      ENTITY_FILE_SCHEMA_V1,
    )
  ) {
    throw new Error('local development entityTemplates require entity-file.v1 compatibility')
  }
  if (!Array.isArray(manifest.entityTemplates) || manifest.entityTemplates.length > 64) {
    throw new Error('local development entityTemplates must be an array of at most 64 declarations')
  }
  const seen = new Set<string>()
  const declarations = manifest.entityTemplates.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`local development entityTemplates[${index}] must be an object`)
    }
    const item = candidate as Record<string, unknown>
    const agentId = item.agentId
    const entityPath = item.entityPath
    const digest = item.digest
    if (
      Object.keys(item).some(key => !['agentId', 'entityPath', 'digest'].includes(key))
      || typeof agentId !== 'string' || !LOCAL_ENTITY_ID.test(agentId) || seen.has(agentId)
      || typeof entityPath !== 'string' || !ENTITY_TEMPLATE_PATH.test(entityPath)
      || entityPath !== `./entities/${agentId}/entity.json`
      || typeof digest !== 'string' || !ENTITY_DIGEST.test(digest)
    ) {
      throw new Error(`local development entityTemplates[${index}] is invalid or duplicated`)
    }
    seen.add(agentId)
    return {
      agentId,
      entityPath: entityPath as `./entities/${string}/entity.json`,
      digest: digest as `sha256:${string}`,
    }
  })
  const entityTemplates = await Promise.all(
    declarations.map(async declaration => await readEntityTemplatePayload(root, declaration)),
  )
  const entityFiles = entityTemplates.flatMap(template => {
    const entityFile = path.resolve(root, template.declaration.entityPath.slice(2))
    const entityDirectory = path.dirname(entityFile)
    return [entityFile, ...template.promptFiles.map(file => path.resolve(entityDirectory, file.path.slice(2)))]
  })
  return {
    files: [manifestPath, ...(runtimeManifestFile === undefined ? [] : [runtimeManifestFile]), ...entityFiles],
    entityTemplates,
    ...(runtimeManifest === undefined ? {} : { manifest: runtimeManifest }),
  }
}
