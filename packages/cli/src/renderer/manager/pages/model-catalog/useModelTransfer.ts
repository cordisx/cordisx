import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
import { useEffect, useRef, useState } from 'react'
import { CATALOG_TRANSFER_MAX_REQUEST_BYTES, CATALOG_TRANSFER_MAX_TEXT } from '../../../../model-catalog-transfer.js'
import type {
  CatalogTransferEnvironmentVariable,
  CatalogTransferSelection,
  CatalogTransferVariablePreparation,
} from '../../../../model-catalog-transfer.js'
import type { ModelCatalogClient } from '../../../model-catalog-client.js'
import { notificationCenterForDocument } from '../../../notifications/host.js'

export interface ModelTransferExportDraft {
  readonly selections: readonly CatalogTransferSelection[]
  readonly bulk: boolean
  readonly variables: readonly CatalogTransferVariablePreparation[]
}

export interface ModelTransferImportDraft {
  readonly text: string
  readonly variables: readonly CatalogTransferVariablePreparation[]
  readonly connections: readonly { readonly transferId: string; readonly title: string }[]
}

function exceedsNativeRequestLimit(
  operation: 'catalogManagementPrepareExport' | 'catalogManagementExport',
  request: Record<string, unknown>,
): boolean {
  const payload = JSON.stringify({
    requestId: '0'.repeat(36),
    operation,
    input: { generation: '0'.repeat(36), request },
  })
  return new TextEncoder().encode(payload).byteLength > CATALOG_TRANSFER_MAX_REQUEST_BYTES
}

export function useModelTransfer(client: ModelCatalogClient | undefined, locale: string, onImported: () => void) {
  const [exporting, setExporting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [exportDraft, setExportDraft] = useState<ModelTransferExportDraft>()
  const [importDraft, setImportDraft] = useState<ModelTransferImportDraft>()
  const [environmentDraft, setEnvironmentDraft] = useState<readonly CatalogTransferEnvironmentVariable[]>()
  const notifications = useRef<NotificationsV1 | undefined>(undefined)
  const zh = locale.startsWith('zh')
  useEffect(() => {
    const owner = notificationCenterForDocument(document)?.bind({
      key: 'host/model-catalog-transfer',
      pluginId: 'cordisx',
      active: () => true,
      presentation: () => ({ name: 'CordisX' }),
    })
    notifications.current = owner?.api
    return () => {
      notifications.current = undefined
      owner?.dispose()
    }
  }, [])
  const notify = (
    kind:
      | 'export.succeeded'
      | 'export.failed'
      | 'import.succeeded'
      | 'import.failed'
      | 'environment.saved'
      | 'environment.failed',
    type: 'success' | 'error',
    message: string,
    description?: string,
  ) => {
    notifications.current?.show({
      kind: `model.catalog.${kind}`,
      type,
      message,
      ...(description ? { description } : {}),
    })
  }
  const prepareExport = async (selections: readonly CatalogTransferSelection[], bulk: boolean) => {
    if (!client || busy || selections.length === 0) return
    if (exceedsNativeRequestLimit('catalogManagementPrepareExport', { selections })) {
      notify(
        'export.failed',
        'error',
        zh ? '模型配置过大' : 'Model configuration is too large',
        zh ? '请减少所选模型服务或模型数量后重试。' : 'Select fewer model services or models and try again.',
      )
      return
    }
    setBusy(true)
    try {
      const result = await client.prepareExport({ selections })
      if (result.status !== 'ok') {
        const tooLarge = result.code === 'too-large'
        notify(
          'export.failed',
          'error',
          tooLarge
            ? zh ? '模型配置过大' : 'Model configuration is too large'
            : zh
            ? '无法准备模型配置'
            : 'Could not prepare model configuration',
          tooLarge
            ? zh ? '请减少所选模型服务或模型数量后重试。' : 'Select fewer model services or models and try again.'
            : zh
            ? '请检查连接状态后重试。'
            : 'Check the connection state and try again.',
        )
        return
      }
      setExportDraft({ selections, bulk, variables: result.variables })
    } catch {
      notify(
        'export.failed',
        'error',
        zh ? '无法准备模型配置' : 'Could not prepare model configuration',
        zh ? '请检查连接状态后重试。' : 'Check the connection state and try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  return {
    exporting,
    selected,
    selectedCount: selected.size,
    busy,
    exportDraft,
    importDraft,
    environmentDraft,
    begin() {
      setSelected(new Set())
      setExporting(true)
    },
    cancel() {
      setSelected(new Set())
      setExporting(false)
    },
    toggleProvider(ref: string) {
      setSelected(current => {
        const next = new Set(current)
        if (next.has(ref)) next.delete(ref)
        else next.add(ref)
        return next
      })
    },
    setProviders(refs: readonly string[], value: boolean) {
      setSelected(current => {
        const next = new Set(current)
        for (const ref of refs) {
          if (value) next.add(ref)
          else next.delete(ref)
        }
        return next
      })
    },
    shareModel(ref: string, id: string): Promise<void> {
      return prepareExport([{ bindingRef: ref, modelIds: [id] }], false)
    },
    shareProvider(ref: string, modelIds: readonly string[]): Promise<void> {
      return prepareExport([{ bindingRef: ref, modelIds }], false)
    },
    finish(selections: readonly CatalogTransferSelection[]): Promise<void> {
      return prepareExport(selections, true)
    },
    closeExportDraft() {
      setExportDraft(undefined)
    },
    async confirmExport(
      variables: ModelTransferExportDraft['variables'],
      includeValues: boolean,
    ): Promise<boolean> {
      if (!client || busy || !exportDraft) return false
      setBusy(true)
      try {
        const request = {
          selections: exportDraft.selections,
          includeValues,
          variables: variables.map(variable => ({
            sourceName: variable.sourceName,
            name: variable.name,
            value: variable.value,
            ...(variable.description === undefined ? {} : { description: variable.description }),
            ...(variable.generator === undefined ? {} : { generator: variable.generator }),
          })),
        }
        if (exceedsNativeRequestLimit('catalogManagementExport', request)) throw new Error('transfer-too-large')
        const result = await client.export(request)
        if (result.status === 'rejected') {
          if (result.code === 'too-large') throw new Error('transfer-too-large')
          throw new Error('transfer-unavailable')
        }
        if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
        await navigator.clipboard.writeText(result.text)
        setExportDraft(undefined)
        if (exportDraft.bulk) {
          setExporting(false)
          setSelected(new Set())
        }
        notify(
          'export.succeeded',
          'success',
          zh ? '模型配置已复制' : 'Model configuration copied',
          includeValues
            ? zh
              ? '配置和值已写入剪贴板；文本未加密。'
              : 'Configuration and values were copied; the text is not encrypted.'
            : zh
            ? '配置已写入剪贴板，未包含变量值。'
            : 'Configuration was copied without variable values.',
        )
        return true
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'transfer-too-large'
        notify(
          'export.failed',
          'error',
          tooLarge
            ? zh ? '模型配置过大' : 'Model configuration is too large'
            : zh
            ? '无法复制模型配置'
            : 'Could not copy model configuration',
          tooLarge
            ? zh ? '请减少所选模型服务或模型数量后重试。' : 'Select fewer model services or models and try again.'
            : zh
            ? '请检查连接和剪贴板权限。'
            : 'Check the connection and clipboard permission.',
        )
        return false
      } finally {
        setBusy(false)
      }
    },
    async importClipboard() {
      if (!client || busy) return
      setBusy(true)
      try {
        if (!navigator.clipboard?.readText) throw new Error('clipboard-unavailable')
        const text = await navigator.clipboard.readText()
        if (text.length > CATALOG_TRANSFER_MAX_TEXT) throw new Error('too-large')
        const result = await client.prepareImport(text)
        if (result.status !== 'ok') throw new Error(result.code)
        setImportDraft({ text, variables: result.variables, connections: result.connections })
      } catch {
        notify(
          'import.failed',
          'error',
          zh ? '模型配置导入失败' : 'Could not import model configuration',
          zh ? '请检查剪贴板内容和连接权限。' : 'Check the clipboard data and connection access.',
        )
      } finally {
        setBusy(false)
      }
    },
    closeImportDraft() {
      setImportDraft(undefined)
    },
    generateEnvironment(runId: string, script: string) {
      return client?.environmentGenerate({ runId, script })
        ?? Promise.resolve({ status: 'rejected' as const, runId, code: 'unavailable' as const })
    },
    cancelEnvironmentGeneration(runId: string) {
      return client?.environmentGenerateCancel(runId)
        ?? Promise.resolve({ status: 'rejected' as const, runId, code: 'unavailable' as const })
    },
    async confirmImport(variables: ModelTransferImportDraft['variables']): Promise<boolean> {
      if (!client || busy || !importDraft) return false
      setBusy(true)
      try {
        const result = await client.import({ text: importDraft.text, variables })
        if (result.status !== 'applied') throw new Error(result.code)
        setImportDraft(undefined)
        onImported()
        notify(
          'import.succeeded',
          'success',
          zh ? '模型配置已导入' : 'Model configuration imported',
          zh
            ? `已导入 ${result.imported} 个连接，跳过 ${result.skipped} 个重复连接。`
            : `Imported ${result.imported} connections and skipped ${result.skipped} duplicates.`,
        )
        return true
      } catch {
        notify(
          'import.failed',
          'error',
          zh ? '模型配置导入失败' : 'Could not import model configuration',
          zh ? '配置已保持不变，请检查字段后重试。' : 'Configuration was unchanged. Check the fields and try again.',
        )
        return false
      } finally {
        setBusy(false)
      }
    },
    async openEnvironment() {
      if (!client || busy) return
      setBusy(true)
      try {
        const result = await client.environmentRead()
        if (result.status !== 'ok') throw new Error(result.code)
        setEnvironmentDraft(result.entries)
      } catch {
        notify(
          'environment.failed',
          'error',
          zh ? '无法读取环境变量' : 'Could not read environment variables',
        )
      } finally {
        setBusy(false)
      }
    },
    closeEnvironment() {
      setEnvironmentDraft(undefined)
    },
    async saveEnvironment(entries: readonly CatalogTransferEnvironmentVariable[]): Promise<boolean> {
      if (!client || busy || environmentDraft === undefined) return false
      setBusy(true)
      try {
        const result = await client.environmentSave(entries)
        if (result.status !== 'applied') throw new Error(result.code)
        setEnvironmentDraft(undefined)
        notify(
          'environment.saved',
          'success',
          zh ? '环境变量已保存' : 'Environment variables saved',
          zh ? '重新启动 CordisX App 后生效。' : 'Restart the CordisX App to apply the changes.',
        )
        return true
      } catch {
        notify(
          'environment.failed',
          'error',
          zh ? '无法保存环境变量' : 'Could not save environment variables',
          zh ? '配置已保持不变。' : 'Configuration was unchanged.',
        )
        return false
      } finally {
        setBusy(false)
      }
    },
  }
}
