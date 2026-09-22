import { useState } from 'react'
import { Button, InputNumber, Switch } from 'tdesign-react'
import type { ScriptSourceConfig } from '../../../../launcher/model-catalog/script-types.js'
import type { CatalogManagementResult, CatalogManagementView } from '../../../../model-catalog-management.js'
import { IconButton } from '../../../host-ui/IconButton.js'
import { SelectField } from '../../../host-ui/SelectField.js'
import { managerCopy } from '../../../ui-copy.js'
import { CatalogInput } from './CatalogInput.js'

interface EnvironmentField {
  key: number
  name: string
  source: 'ref' | 'value'
  value: string
}
const envName = (value: string) => /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(value)

export function ScriptEditor({ view, locale, save, close }: {
  readonly view: CatalogManagementView
  readonly locale: string
  readonly save: (
    config: ScriptSourceConfig,
    mode: 'replace' | 'supplement',
    revision: string,
  ) => Promise<CatalogManagementResult>
  readonly close: () => void
}) {
  const t = (key: Parameters<typeof managerCopy>[1]) => managerCopy(locale, key)
  const [kind, setKind] = useState<'exec' | 'shell'>('exec')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState<{ key: number; value: string }[]>([])
  const [cwd, setCwd] = useState('')
  const [inherit, setInherit] = useState(false)
  const [environment, setEnvironment] = useState<EnvironmentField[]>([])
  const [nextKey, setNextKey] = useState(0)
  const [mode, setMode] = useState<'replace' | 'supplement'>(view.mode === 'supplement' ? 'supplement' : 'replace')
  const [timeout, setTimeoutValue] = useState(10)
  const [revision, setRevision] = useState(view.revision)
  const [scope] = useState(view.scopeRevision)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const changed = view.revision !== revision
  const scopeChanged = view.scopeRevision !== scope
  const valid = command.trim().length > 0 && !command.includes('\0')
    && command.length <= (kind === 'exec' ? 4096 : 65_536)
    && (/^\//u.test(cwd) || /^[A-Za-z]:[\\/]/u.test(cwd)) && cwd.length <= 4096 && !cwd.includes('\0')
    && args.every(arg => !arg.value.includes('\0') && arg.value.length <= 4096)
    && new Set(environment.map(item => item.name)).size === environment.length
    && environment.every(item =>
      envName(item.name)
      && (item.source === 'ref' ? envName(item.value) : !item.value.includes('\0') && item.value.length <= 4096)
    )
    && Number.isInteger(timeout) && timeout >= 1 && timeout <= 60
  const updateEnv = (key: number, patch: Partial<EnvironmentField>) =>
    setEnvironment(environment.map(item => item.key === key ? { ...item, ...patch } : item))
  const submit = async () => {
    if (!valid || busy || changed || scopeChanged) return
    setBusy(true)
    setFailed(false)
    const config: ScriptSourceConfig = {
      schemaVersion: 1,
      command: kind === 'exec' ? { kind, executable: command, args: args.map(arg => arg.value) } : { kind, command },
      cwd,
      environment: {
        inherit,
        refs: Object.fromEntries(
          environment.filter(item => item.source === 'ref').map(item => [item.name, item.value]),
        ),
        values: Object.fromEntries(
          environment.filter(item => item.source === 'value').map(item => [item.name, item.value]),
        ),
      },
      timeoutMs: timeout * 1000,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 65_536,
      maxModels: 1000,
    }
    const result = await save(config, mode, revision)
    setBusy(false)
    if (result.status === 'applied') {
      setCommand('')
      setArgs([])
      setEnvironment([])
      close()
    } else setFailed(true)
  }
  return (
    <section className="cxmc-editor" aria-label={t('catalog.configureScript')}>
      <h3>{t('catalog.configureScript')}</h3>
      <p>{t('catalog.scriptNotice')}</p>
      {view.sourceKind === 'script' ? <p>{t('catalog.scriptReplaceNotice')}</p> : null}
      <div className="cxmc-connection-fields">
        <label>
          <span>{t('catalog.commandKind')}</span>
          <SelectField
            icon="configuration"
            label={t('catalog.commandKind')}
            value={kind}
            options={[{ value: 'exec', label: t('catalog.exec') }, { value: 'shell', label: t('catalog.shell') }]}
            onChange={value => setKind(value === 'shell' ? 'shell' : 'exec')}
          />
        </label>
        <label>
          <span>{t(kind === 'exec' ? 'catalog.executable' : 'catalog.shell')}</span>
          <CatalogInput
            label={t(kind === 'exec' ? 'catalog.executable' : 'catalog.shell')}
            value={command}
            autocomplete="off"
            maxlength={kind === 'exec' ? 4096 : 65_536}
            onChange={setCommand}
          />
        </label>
        <label>
          <span>{t('catalog.cwd')}</span>
          <CatalogInput label={t('catalog.cwd')} value={cwd} maxlength={4096} onChange={setCwd} />
        </label>
        <label>
          <span>{t('catalog.scriptMode')}</span>
          <SelectField
            icon="models-read"
            label={t('catalog.scriptMode')}
            value={mode}
            options={[{ value: 'replace', label: t('catalog.replace') }, {
              value: 'supplement',
              label: t('catalog.scriptSupplement'),
            }]}
            onChange={value => setMode(value === 'supplement' ? 'supplement' : 'replace')}
          />
        </label>
        <label>
          <span>{t('catalog.timeout')}</span>
          <InputNumber value={timeout} min={1} max={60} step={1} onChange={value => setTimeoutValue(Number(value))} />
        </label>
        <label>
          <span>{t('catalog.inheritEnv')}</span>
          <Switch value={inherit} aria-label={t('catalog.inheritEnv')} onChange={setInherit} />
        </label>
      </div>
      {kind === 'exec'
        ? (
          <div className="cxmc-editor-models">
            {args.map((arg, index) => (
              <div className="cxmc-argument" key={arg.key}>
                <CatalogInput
                  label={`${t('catalog.arguments')} ${index + 1}`}
                  value={arg.value}
                  maxlength={4096}
                  autocomplete="off"
                  onChange={value => setArgs(args.map(item => item.key === arg.key ? { ...item, value } : item))}
                />
                <IconButton
                  tag="button"
                  icon="delete"
                  label={`${t('catalog.removeField')} ${index + 1}`}
                  onClick={() => setArgs(args.filter(item => item.key !== arg.key))}
                />
              </div>
            ))}
            <IconButton
              tag="button"
              icon="add"
              label={t('catalog.addArgument')}
              disabled={args.length >= 128}
              onClick={() => {
                setArgs([...args, { key: nextKey, value: '' }])
                setNextKey(nextKey + 1)
              }}
            />
          </div>
        )
        : null}
      <div className="cxmc-editor-models">
        {environment.map((item, index) => (
          <div className="cxmc-environment" key={item.key}>
            <CatalogInput
              label={`${t('catalog.envName')} ${index + 1}`}
              value={item.name}
              maxlength={256}
              onChange={name => updateEnv(item.key, { name })}
            />
            <SelectField
              icon="configuration"
              label={`${t('catalog.envKind')} ${index + 1}`}
              value={item.source}
              options={[{ value: 'ref', label: t('catalog.envRef') }, { value: 'value', label: t('catalog.envValue') }]}
              onChange={value => updateEnv(item.key, { source: value === 'value' ? 'value' : 'ref', value: '' })}
            />
            <CatalogInput
              label={`${t(item.source === 'ref' ? 'catalog.envRef' : 'catalog.envValue')} ${index + 1}`}
              value={item.value}
              autocomplete="off"
              maxlength={item.source === 'ref' ? 256 : 4096}
              onChange={value => updateEnv(item.key, { value })}
            />
            <IconButton
              tag="button"
              icon="delete"
              label={`${t('catalog.removeField')}: ${item.name || index + 1}`}
              onClick={() => setEnvironment(environment.filter(value => value.key !== item.key))}
            />
          </div>
        ))}
        <IconButton
          tag="button"
          icon="add"
          label={t('catalog.addEnv')}
          disabled={environment.length >= 128}
          onClick={() => {
            setEnvironment([...environment, { key: nextKey, name: '', source: 'ref', value: '' }])
            setNextKey(nextKey + 1)
          }}
        />
      </div>
      {!valid && (command !== '' || cwd !== '') ? <p role="status">{t('catalog.scriptInvalid')}</p> : null}
      {scopeChanged ? <p role="status">{t('catalog.scopeChanged')}</p> : changed
        ? (
          <div role="status">
            <p>{t('catalog.conflict')}</p>
            <Button tag="button" variant="outline" onClick={() => setRevision(view.revision)}>
              {t('catalog.reviewed')}
            </Button>
          </div>
        )
        : failed
        ? <p role="status">{t('catalog.failed')}</p>
        : null}
      <footer className="cxmc-editor-actions">
        <Button tag="button" variant="outline" onClick={close} disabled={busy}>{t('catalog.cancel')}</Button>
        <Button
          tag="button"
          theme="primary"
          disabled={!valid || changed || scopeChanged}
          loading={busy}
          onClick={() => void submit()}
        >
          {t('catalog.save')}
        </Button>
      </footer>
    </section>
  )
}
