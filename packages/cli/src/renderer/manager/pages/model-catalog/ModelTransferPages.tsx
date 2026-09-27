import type { SchemaFormSnapshotV1 } from '@cordisx/protocol/schema-form/v1'
import { useEffect, useRef, useState } from 'react'
import { Button } from 'tdesign-react'
import type {
  CatalogTransferEnvironmentVariable,
  CatalogTransferVariablePreparation,
} from '../../../../model-catalog-transfer.js'
import { HostSchemaFormPage, schemaFormSnapshot } from '../../../host-ui/SchemaForm.js'
import type { useModelTransfer } from './useModelTransfer.js'
import {
  modelTransferEnvironmentSchema,
  modelTransferExportVariablesSchema,
  modelTransferExportWithoutVariablesSchema,
  modelTransferImportSchema,
} from './model-transfer-schema.js'

type ModelTransfer = ReturnType<typeof useModelTransfer>

export interface ModelServicesSecondaryPage {
  readonly id: 'export' | 'import' | 'environment'
  readonly title: string
  readonly back: () => void
}

interface ExportFormValue extends Readonly<Record<string, unknown>> {
  readonly variables: readonly CatalogTransferVariablePreparation[]
  readonly includeValues?: boolean
}

interface VariablesFormValue<T> extends Readonly<Record<string, unknown>> {
  readonly variables: readonly T[]
}

type ImportFormVariable = CatalogTransferVariablePreparation & { readonly generatorScript?: string }

function duplicateVariableName(variables: readonly { readonly name: string }[]): boolean {
  return new Set(variables.map(variable => variable.name)).size !== variables.length
}

function importFormVariable(variable: CatalogTransferVariablePreparation): ImportFormVariable {
  return {
    ...variable,
    ...(variable.generator === undefined ? {} : { generatorScript: variable.generator.script }),
  }
}

function importVariablePayload(variable: ImportFormVariable): CatalogTransferVariablePreparation {
  const { generatorScript, generator: _generator, ...entry } = variable
  return {
    ...entry,
    ...(generatorScript === undefined || generatorScript === ''
      ? {}
      : { generator: { kind: 'shell', script: generatorScript } }),
  }
}

function EnvironmentGeneratorControls({ value, onChange, disabled, transfer, locale }: {
  readonly value: Readonly<Record<string, unknown>>
  readonly onChange: (value: Record<string, unknown>) => void
  readonly disabled: boolean
  readonly transfer: ModelTransfer
  readonly locale: string
}) {
  const zh = locale.startsWith('zh')
  const latest = useRef(value)
  latest.current = value
  const active = useRef<{ readonly runId: string; readonly script: string; readonly value: string } | undefined>(
    undefined,
  )
  const generation = useRef(0)
  const [state, setState] = useState<'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'>('idle')
  const script = typeof value.generatorScript === 'string' ? value.generatorScript : ''
  const preview = typeof value.value === 'string' ? value.value : ''
  const cancelActive = () => {
    generation.current++
    const run = active.current
    active.current = undefined
    if (run !== undefined) void transfer.cancelEnvironmentGeneration(run.runId)
  }
  useEffect(() => {
    const run = active.current
    if (run === undefined || run.script === script && run.value === preview) return
    cancelActive()
    setState('cancelled')
  }, [script, preview])
  useEffect(() => () => cancelActive(), [])
  return (
    <section className="cxf-section" data-environment-generator-state={state}>
      <p className="cxr-notice" role="note">
        {zh
          ? 'Shell 脚本在本机通过 /bin/sh 运行，不受沙箱保护，可能产生副作用。仅在确认后运行。'
          : 'Shell scripts run locally through /bin/sh. They are not sandboxed and may have side effects. Run only after review.'}
      </p>
      <div className="cxf-form-actions">
        <div className="cxf-status" aria-live="polite">
          {state === 'running'
            ? zh ? '正在运行…' : 'Running…'
            : state === 'succeeded'
            ? zh ? '已更新值预览。' : 'Value preview updated.'
            : state === 'failed'
            ? zh ? '脚本未生成有效值。' : 'The script did not produce a valid value.'
            : state === 'cancelled'
            ? zh ? '运行已取消。' : 'Run cancelled.'
            : ''}
        </div>
        <div className="cxf-form-action-buttons">
          {state === 'running'
            ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  cancelActive()
                  setState('cancelled')
                }}
              >
                {zh ? '取消运行' : 'Cancel run'}
              </Button>
            )
            : (
              <Button
                type="button"
                variant="outline"
                disabled={disabled || script === ''}
                onClick={() => {
                  cancelActive()
                  const runId = crypto.randomUUID()
                  const token = ++generation.current
                  active.current = { runId, script, value: preview }
                  setState('running')
                  void transfer.generateEnvironment(runId, script).then(result => {
                    if (generation.current !== token || active.current?.runId !== runId) return
                    active.current = undefined
                    if (result.status !== 'ok' || result.runId !== runId) {
                      setState(result.status === 'rejected' && result.code === 'cancelled' ? 'cancelled' : 'failed')
                      return
                    }
                    setState('succeeded')
                    onChange({ ...latest.current, value: result.value })
                  })
                }}
              >
                {zh ? '运行脚本' : 'Run script'}
              </Button>
            )}
        </div>
      </div>
    </section>
  )
}

function PageActions({ invalid, submitting, cancel, confirm, confirmLabel, locale }: {
  readonly invalid: boolean
  readonly submitting: boolean
  readonly cancel: () => void
  readonly confirm: () => Promise<void>
  readonly confirmLabel: string
  readonly locale: string
}) {
  const zh = locale.startsWith('zh')
  return (
    <div className="cxf-form-actions">
      <div className="cxf-status" data-state={invalid ? 'invalid' : 'draft'}>
        {invalid ? (zh ? '请修正无效字段。' : 'Fix the invalid fields.') : ''}
      </div>
      <div className="cxf-form-action-buttons">
        <Button type="button" variant="outline" disabled={submitting} onClick={cancel}>
          {zh ? '取消' : 'Cancel'}
        </Button>
        <Button
          type="button"
          theme="primary"
          loading={submitting}
          disabled={submitting || invalid}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

function ExportPage({ transfer, locale }: { readonly transfer: ModelTransfer; readonly locale: string }) {
  const draft = transfer.exportDraft!
  const initial: ExportFormValue = {
    variables: structuredClone(draft.variables),
    includeValues: false,
  }
  const schema = initial.variables.length === 0
    ? modelTransferExportWithoutVariablesSchema
    : modelTransferExportVariablesSchema
  const [snapshot, setSnapshot] = useState<SchemaFormSnapshotV1>(() =>
    initial.variables.length === 0
      ? { value: initial, valid: true, issues: [] }
      : schemaFormSnapshot(schema, initial, locale)
  )
  const [submitting, setSubmitting] = useState(false)
  const value = snapshot.value as unknown as ExportFormValue
  const invalid = !snapshot.valid || duplicateVariableName(value.variables)
    || value.includeValues === true && value.variables.some(variable => variable.value === '')
  const zh = locale.startsWith('zh')
  return (
    <section className="cxr-page cxms-transfer-page" data-model-transfer-page="export">
      <HostSchemaFormPage
        form={{
          identity: 'model-transfer-export',
          schema,
          value: snapshot.value,
          locale,
          disabled: submitting,
          onChange: setSnapshot,
          onValidationChange: next => {
            if (next.value === snapshot.value) setSnapshot(next)
          },
        }}
        footer={
          <PageActions
            invalid={invalid}
            submitting={submitting}
            cancel={transfer.closeExportDraft}
            confirmLabel={zh ? '复制配置' : 'Copy configuration'}
            locale={locale}
            confirm={async () => {
              setSubmitting(true)
              await transfer.confirmExport(value.variables, value.includeValues === true)
              setSubmitting(false)
            }}
          />
        }
      >
        <div className="cxms-transfer-page-body">
          <p>
            {zh ? '仅导出所选服务引用的变量。' : 'Only variables referenced by the selected services are exported.'}
          </p>
          {initial.variables.length === 0
            ? <p>{zh ? '所选服务不需要环境变量。' : 'The selected services require no environment variables.'}</p>
            : null}
        </div>
      </HostSchemaFormPage>
    </section>
  )
}

function ImportPage({ transfer, locale }: { readonly transfer: ModelTransfer; readonly locale: string }) {
  const draft = transfer.importDraft!
  const initial: VariablesFormValue<ImportFormVariable> = {
    variables: structuredClone(draft.variables.map(importFormVariable)),
  }
  const [snapshot, setSnapshot] = useState<SchemaFormSnapshotV1>(() =>
    schemaFormSnapshot(modelTransferImportSchema, initial, locale)
  )
  const [submitting, setSubmitting] = useState(false)
  const value = snapshot.value as unknown as VariablesFormValue<ImportFormVariable>
  const invalid = !snapshot.valid || duplicateVariableName(value.variables)
  const zh = locale.startsWith('zh')
  return (
    <section className="cxr-page cxms-transfer-page" data-model-transfer-page="import">
      <HostSchemaFormPage
        form={{
          identity: 'model-transfer-import',
          schema: modelTransferImportSchema,
          value: snapshot.value,
          locale,
          disabled: submitting,
          renderArrayItemSupplement: props => (
            <EnvironmentGeneratorControls {...props} transfer={transfer} locale={locale} />
          ),
          onChange: setSnapshot,
          onValidationChange: next => {
            if (next.value === snapshot.value) setSnapshot(next)
          },
        }}
        footer={
          <PageActions
            invalid={invalid}
            submitting={submitting}
            cancel={transfer.closeImportDraft}
            confirmLabel={zh ? '导入' : 'Import'}
            locale={locale}
            confirm={async () => {
              setSubmitting(true)
              await transfer.confirmImport(value.variables.map(importVariablePayload))
              setSubmitting(false)
            }}
          />
        }
      >
        <div className="cxms-transfer-page-body">
          <p>
            {zh
              ? '确认后会同时保存变量和模型服务。'
              : 'Variables and model services are saved together after confirmation.'}
          </p>
          <ul>{draft.connections.map(connection => <li key={connection.transferId}>{connection.title}</li>)}</ul>
          {initial.variables.length === 0
            ? <p>{zh ? '此配置不包含环境变量。' : 'This configuration contains no environment variables.'}</p>
            : null}
        </div>
      </HostSchemaFormPage>
    </section>
  )
}

function EnvironmentPage({ transfer, locale }: { readonly transfer: ModelTransfer; readonly locale: string }) {
  const initial: VariablesFormValue<CatalogTransferEnvironmentVariable> = {
    variables: structuredClone(transfer.environmentDraft!),
  }
  const [snapshot, setSnapshot] = useState<SchemaFormSnapshotV1>(() =>
    schemaFormSnapshot(modelTransferEnvironmentSchema, initial, locale)
  )
  const [submitting, setSubmitting] = useState(false)
  const value = snapshot.value as unknown as VariablesFormValue<CatalogTransferEnvironmentVariable>
  const invalid = !snapshot.valid || duplicateVariableName(value.variables)
  const zh = locale.startsWith('zh')
  return (
    <section className="cxr-page cxms-transfer-page" data-model-transfer-page="environment">
      <HostSchemaFormPage
        form={{
          identity: 'model-transfer-environment',
          schema: modelTransferEnvironmentSchema,
          value: snapshot.value,
          locale,
          disabled: submitting,
          onChange: setSnapshot,
          onValidationChange: next => {
            if (next.value === snapshot.value) setSnapshot(next)
          },
        }}
        footer={
          <PageActions
            invalid={invalid}
            submitting={submitting}
            cancel={transfer.closeEnvironment}
            confirmLabel={zh ? '保存' : 'Save'}
            locale={locale}
            confirm={async () => {
              setSubmitting(true)
              await transfer.saveEnvironment(value.variables)
              setSubmitting(false)
            }}
          />
        }
      />
    </section>
  )
}

export function modelServicesSecondaryPage(
  transfer: ModelTransfer,
  locale: string,
): ModelServicesSecondaryPage | undefined {
  const zh = locale.startsWith('zh')
  if (transfer.exportDraft !== undefined) {
    return {
      id: 'export',
      title: zh ? '确认导出模型配置' : 'Confirm model configuration export',
      back: transfer.closeExportDraft,
    }
  }
  if (transfer.importDraft !== undefined) {
    return {
      id: 'import',
      title: zh ? '确认导入模型配置' : 'Confirm model configuration import',
      back: transfer.closeImportDraft,
    }
  }
  if (transfer.environmentDraft !== undefined) {
    return { id: 'environment', title: zh ? '环境变量' : 'Environment variables', back: transfer.closeEnvironment }
  }
  return undefined
}

export function ModelTransferPage({ transfer, locale }: {
  readonly transfer: ModelTransfer
  readonly locale: string
}) {
  if (transfer.exportDraft !== undefined) return <ExportPage transfer={transfer} locale={locale} />
  if (transfer.importDraft !== undefined) return <ImportPage transfer={transfer} locale={locale} />
  if (transfer.environmentDraft !== undefined) return <EnvironmentPage transfer={transfer} locale={locale} />
  return null
}
