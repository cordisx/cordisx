export type TestTDesignSelect = HTMLElement & {
  disabled: boolean
  options: readonly { readonly value: string; readonly label: string }[]
  setSelectedValue(value: string | undefined, notify?: boolean): void
}

export interface RuntimeSnapshot {
  plugins: readonly {
    id: string
    source: string
    status: string
    readme?: string
    description?: string
    configuration: {
      schemaKind: string
      applies: string
      fields: readonly {
        path: readonly string[]
        label?: string
        description?: string
        value?: unknown
        min?: number
        max?: number
      }[]
    }
  }[]
  registrations: readonly {
    owner: string
    surface: string
    valid: boolean
    authorized: boolean
    rendered: boolean
    item: unknown
  }[]
  commands: readonly { owner: string; qualifiedId: string }[]
  navigation: {
    routes: readonly {
      owner: string
      qualifiedId: string
      valid: boolean
      authorized: boolean
      productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
    }[]
    pages: readonly {
      owner: string
      qualifiedId: string
      productMetadata: { title?: string; description?: string; diagnostics: readonly unknown[] }
    }[]
    outlets: readonly {
      id: string
      available: boolean
      error?: string
      contextKey?: string
      activeRoute?: string
      mounted: boolean
      presentation: 'inactive' | 'presented' | 'suspended'
      suspendedBy?: string
    }[]
  }
  localization: { locale: string; direction: string; version: number }
  localeCatalogs: readonly { owner: string; namespace: string; locale: string }[]
  localizationDiagnostics: readonly unknown[]
  platform: {
    mode: string
    secondConnectionCreated: boolean
    rawBridgeExposed: boolean
    diagnostics: readonly { code: string }[]
  }
  permissions: readonly { capability: string; policy: string; reasonText: string; required: boolean }[]
  extensionPoints: {
    points: readonly {
      id: string
      kind: string
      titleProjection: { text: string }
      usingPluginCount: number
      activePluginCount: number
    }[]
    policies: readonly { identity: { source: string; pluginId: string; pointId: string }; policy: string }[]
    descriptorDiagnostics: readonly unknown[]
    accessDiagnostics: readonly {
      request: {
        generation: string
        operation: string
        identity: { source: string; pluginId: string; pointId: string }
      }
      authorized: boolean
    }[]
  }
}

export interface RuntimeHandle {
  readonly version: string
  snapshot(): RuntimeSnapshot
  setPluginBlocked(id: string, blocked: boolean): Promise<void>
  execute(owner: string, reference: { id: string }): Promise<unknown>
  navigate(owner: string, reference: { id: string; params?: Record<string, string> }): Promise<void>
  setExtensionPointPolicy(
    source: string,
    pluginId: string,
    pointId: string,
    policy: 'inherit' | 'allow' | 'deny',
  ): Promise<void>
  dispose(): Promise<void>
}

export async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
