import type {
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
  CordisXPluginManifestV9,
  CordisXPluginServiceDeclarationV9,
} from '../permission-contracts.js'
import type { CordisXPluginManifestV1 } from '../platform-contracts.js'
import type { CordisXPluginPackageManifestV1 } from '../plugin-lifecycle-contracts.js'
import type { EntityTemplatePayload } from './entity-directory.js'
import type { BuiltPluginGenerationArtifact } from './production-plugin-build.js'

export interface StagedPluginPackage {
  readonly manifest: Omit<CordisXPluginPackageManifestV1, 'runtimeManifest'> & {
    readonly runtimeManifest:
      | CordisXPluginManifestV1
      | CordisXPluginManifestV4
      | CordisXPluginManifestV5
      | CordisXPluginManifestV6
      | CordisXPluginManifestV7
      | CordisXPluginManifestV8
      | CordisXPluginManifestV9
  }
  readonly digest: `sha256:${string}`
  readonly moduleSource: string
  readonly artifactSource: string
  readonly browserArtifact?: BuiltPluginGenerationArtifact
  readonly serviceModules: readonly StagedPluginServiceModule[]
  readonly entityTemplates: readonly EntityTemplatePayload[]
  readonly readme?: string
  readonly identitySource: string
}

export interface StagedPluginServiceModule {
  readonly declaration: CordisXPluginServiceDeclarationV9
  readonly moduleSource: string
}
