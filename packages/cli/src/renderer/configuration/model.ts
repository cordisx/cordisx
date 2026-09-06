import type {
  CordisXConfigApplies,
  CordisXConfigFieldPath,
  CordisXConfigFieldSnapshot,
  CordisXConfigFormActionIcons,
  CordisXJsonValue,
  CordisXPluginIdentity,
  CordisXStandardSchema,
} from '../../contracts.js'
import type { PluginGenerationEffectIdentity, PluginGenerationView } from '../generation-visibility.js'

interface SchemaNode {
  readonly type?: string
  readonly dict?: Readonly<Record<string, SchemaNode>>
  readonly list?: readonly SchemaNode[]
  readonly inner?: SchemaNode
  readonly value?: unknown
  readonly meta?: {
    readonly role?: string
    readonly extra?: {
      readonly label?: string | Readonly<Record<string, string>>
      readonly cordisxForm?: {
        readonly version?: number
        readonly fields?: readonly unknown[]
        readonly icon?: string
        readonly group?: {
          readonly id?: string
          readonly title?: string | Readonly<Record<string, string>>
          readonly description?: string | Readonly<Record<string, string>>
          readonly icon?: string
        }
        readonly actions?: { readonly save?: string; readonly reset?: string }
        readonly presenter?: {
          readonly version?: number
          readonly kind?: string
          readonly options?: {
            readonly density?: string
            readonly maxInlineItems?: number
            readonly allowReorder?: boolean
          }
        }
      }
    }
    readonly description?: string | Readonly<Record<string, string>>
    readonly hidden?: boolean
    readonly disabled?: boolean
    readonly required?: boolean
    readonly default?: unknown
    readonly min?: number
    readonly max?: number
    readonly step?: number
  }
  readonly toJSON?: () => unknown
}

interface ConfigRecord {
  readonly identity: CordisXPluginIdentity
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly namespace: string
  readonly schema?: CordisXStandardSchema & SchemaNode
  readonly applies: CordisXConfigApplies
  readonly writable: boolean
  revision: number
  activeRevision: number
  raw: unknown
  value: unknown
  candidate?: { readonly raw: unknown; readonly value: unknown }
  pendingAppRestart?: { readonly raw: unknown; readonly value: unknown }
  readonly secretPaths: readonly CordisXConfigFieldPath[]
  readonly watchers: Set<(value: unknown) => void>
}

export interface ConfigMutationOperation {
  readonly op: 'set' | 'unset'
  readonly path: CordisXConfigFieldPath
  readonly value?: CordisXJsonValue
}

export interface ManagerPluginConfigSnapshot {
  readonly namespace: string
  readonly schemaKind: 'schemastery' | 'standard' | 'none'
  readonly applies: CordisXConfigApplies
  readonly writable: boolean
  readonly revision: number
  readonly lastGoodRevision: number
  readonly value: unknown
  readonly fields: readonly CordisXConfigFieldSnapshot[]
  readonly secrets: readonly { readonly path: CordisXConfigFieldPath; readonly set: boolean }[]
  readonly actionIcons?: CordisXConfigFormActionIcons
}

export interface ConfigCandidate {
  readonly raw: unknown
  readonly value: unknown
}

export interface ConfigRendererMountHandle {
  readonly mounted: boolean
  dispose(): Promise<void>
}

export type { ConfigRecord, SchemaNode }
