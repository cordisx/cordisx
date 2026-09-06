import type {
  PlatformProviderDefinitionV1,
  PlatformProviderModelRefV1,
  PlatformProviderModelV1,
  PlatformProviderSessionDetailV1,
  PlatformProviderSessionRefV1,
  PlatformProviderSessionV1,
} from '@cordisx/protocol/platform-provider/v1'
import type {
  CordisXModelDescriptor,
  CordisXPlatformModelRef,
  CordisXSessionProjection,
  CordisXSessionSummary,
} from '../contracts.js'
import type { PlatformProviderWorkspaceAuthority } from './platform-provider-authority.js'

export class PlatformProviderProjection {
  constructor(
    private readonly providerId: string,
    private readonly mapping: PlatformProviderDefinitionV1['mapping'],
    private readonly workspaces: PlatformProviderWorkspaceAuthority,
  ) {}

  inputSession(ref: PlatformProviderSessionRefV1): PlatformProviderSessionRefV1 {
    this.assertSession(ref)
    return ref
  }

  inputModel(ref: CordisXPlatformModelRef): PlatformProviderModelRefV1 {
    if (ref.providerId !== this.providerId || ref.modelId.trim() === '') {
      throw new Error('model provider identity drifted')
    }
    const mapped = this.mapping.models.find(item => item.modelId === ref.modelId)
    if (mapped?.enabled === false) throw new Error('model mapping is disabled')
    return { providerId: this.providerId, modelId: mapped?.sourceModelId ?? ref.modelId }
  }

  model(value: PlatformProviderModelV1): CordisXModelDescriptor | undefined {
    if (value.ref.providerId !== this.providerId || value.ref.modelId.trim() === '') {
      throw new Error('model provider identity drifted')
    }
    const mapped = this.mapping.models.find(item => item.sourceModelId === value.ref.modelId)
    if (mapped?.enabled === false) return undefined
    const modelId = mapped?.modelId ?? value.ref.modelId
    return {
      contract: 'cordisx.platform-model/v1',
      schemaVersion: 1,
      ref: { providerId: this.providerId, modelId },
      hostId: `${this.providerId}:${modelId}`,
      label: mapped?.displayName ?? value.label,
      ...(mapped?.isDefault === true || mapped === undefined && value.isDefault === true ? { isDefault: true } : {}),
      ...(value.capabilities === undefined ? {} : { features: value.capabilities }),
    }
  }

  summary(value: PlatformProviderSessionV1): CordisXSessionSummary {
    this.assertSession(value.ref)
    const model = this.outputModel(value.model)
    return {
      contract: 'cordisx.platform-session/v1',
      schemaVersion: 1,
      ref: value.ref,
      hostId: `${this.providerId}:${value.ref.remoteSessionId}`,
      model,
      cwd: this.workspaces.resolve(value.workspace),
      state: value.state,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
      ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
    }
  }

  detail(value: PlatformProviderSessionDetailV1): CordisXSessionProjection {
    return {
      ...this.summary(value),
      turns: value.turns.map(turn => ({
        id: turn.turnId,
        state: turn.state,
        items: turn.items.map(item => ({
          id: item.itemId,
          kind: item.kind,
          ...(item.text === undefined ? {} : { text: item.text }),
        })),
      })),
    }
  }

  private outputModel(ref: PlatformProviderModelRefV1): CordisXPlatformModelRef {
    if (ref.providerId !== this.providerId || ref.modelId.trim() === '') {
      throw new Error('session model identity drifted')
    }
    const mapped = this.mapping.models.find(item => item.sourceModelId === ref.modelId)
    if (mapped?.enabled === false) throw new Error('session uses a disabled model mapping')
    return { providerId: this.providerId, modelId: mapped?.modelId ?? ref.modelId }
  }

  private assertSession(ref: PlatformProviderSessionRefV1): void {
    if (ref.providerId !== this.providerId || ref.remoteSessionId.trim() === '' || ref.remoteSessionId.length > 512) {
      throw new Error('session provider identity drifted')
    }
  }
}
