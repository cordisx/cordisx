import type { Context, Disposable } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXModelDescriptor,
  type CordisXPageMountContext,
  type CordisXPlatformModelRef,
  type CordisXPlatformSessionRef,
  type CordisXPluginManifestV1,
  type CordisXSessionProjection,
  type CordisXSessionSummary,
} from '../contracts.js'
import type {} from '../contracts.js'

export const name = 'cli-proxy-api'
export const inject = ['i18n', 'slots', 'pages', 'routes', 'platform']

const capabilities = [
  'models.read', 'tasks.catalog.read', 'tasks.content.read', 'tasks.create', 'tasks.control', 'turns.submit', 'turns.control',
] as const

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'cli-proxy-api',
  name: 'CLIProxy Providers',
  capabilities: capabilities.map(capability => ({
    name: capability,
    required: false,
    reason: {
      namespace: 'cli-proxy-api',
      key: `permission.${capability}`,
      fallback: `Use ${capability} for explicitly configured external providers`,
    },
    scope: {},
  })),
} satisfies CordisXPluginManifestV1

interface Messages {
  'navigation.title': undefined
  'navigation.description': undefined
  'page.title': undefined
  'page.subtitle': undefined
  'field.provider': undefined
  'field.model': undefined
  'field.cwd': undefined
  'field.initial-message': undefined
  'field.search': undefined
  'action.refresh': undefined
  'action.create': undefined
  'action.load-more': undefined
  'action.continue': undefined
  'action.fork': undefined
  'action.archive': undefined
  'action.restore': undefined
  'action.delete': undefined
  'action.send': undefined
  'action.steer': undefined
  'action.interrupt': undefined
  'state.loading': undefined
  'state.empty': undefined
  'state.no-models': undefined
  'state.select-session': undefined
  'state.error': { readonly message: string }
  'session.provider': { readonly provider: string }
  'session.model': { readonly model: string }
  'permission.models.read': undefined
  'permission.tasks.catalog.read': undefined
  'permission.tasks.content.read': undefined
  'permission.tasks.create': undefined
  'permission.tasks.control': undefined
  'permission.turns.submit': undefined
  'permission.turns.control': undefined
}

interface Config {
  readonly providerIds?: readonly string[]
  readonly defaultCwd?: string
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return { namespace: 'cli-proxy-api', key, ...(args[0] === undefined ? {} : { params: args[0] }) }
}

function style(element: HTMLElement, rules: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, rules)
}

function button(document: Document, label: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  node.dataset.cordisxNoDrag = 'true'
  style(node, {
    minHeight: '32px', padding: '5px 11px', border: '1px solid var(--color-border, rgba(255,255,255,.12))',
    borderRadius: '8px', background: 'var(--color-background-elevated-secondary, rgba(255,255,255,.05))',
    color: 'inherit', cursor: 'pointer', font: 'inherit',
  })
  return node
}

function input(document: Document, label: string, type: 'input' | 'textarea' = 'input'): HTMLInputElement | HTMLTextAreaElement {
  const node = document.createElement(type)
  node.setAttribute('aria-label', label)
  node.dataset.cordisxNoDrag = 'true'
  style(node, {
    width: '100%', minHeight: type === 'textarea' ? '76px' : '34px', boxSizing: 'border-box', padding: '7px 9px',
    border: '1px solid var(--color-border, rgba(255,255,255,.12))', borderRadius: '8px',
    background: 'var(--color-background-elevated, rgba(255,255,255,.035))', color: 'inherit', font: 'inherit', resize: 'vertical',
  })
  return node
}

function select(document: Document, label: string): HTMLSelectElement {
  const node = document.createElement('select')
  node.setAttribute('aria-label', label)
  node.dataset.cordisxNoDrag = 'true'
  style(node, {
    width: '100%', minHeight: '34px', padding: '5px 8px', border: '1px solid var(--color-border, rgba(255,255,255,.12))',
    borderRadius: '8px', background: 'var(--color-background-elevated, #202020)', color: 'inherit', font: 'inherit',
  })
  return node
}

function sessionKey(ref: CordisXPlatformSessionRef): string {
  return JSON.stringify([ref.providerId, ref.remoteSessionId])
}

function modelKey(ref: CordisXPlatformModelRef): string {
  return JSON.stringify([ref.providerId, ref.modelId])
}

function parsedModel(value: string): CordisXPlatformModelRef | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')
      ? { providerId: parsed[0] as string, modelId: parsed[1] as string }
      : undefined
  } catch {
    return undefined
  }
}

function mountFleet(ctx: Context, context: CordisXPageMountContext<Messages>, config: Config): Disposable<void> {
  const { document } = context
  const root = document.createElement('section')
  root.dataset.cordisxProviderFleet = 'true'
  style(root, {
    display: 'grid', gridTemplateColumns: 'minmax(300px, 42%) minmax(360px, 1fr)', gap: '0', minHeight: 'calc(100vh - 54px)',
    color: 'var(--color-text, #e6e6e6)', font: '13px/1.45 ui-sans-serif, system-ui, sans-serif',
  })
  const catalog = document.createElement('div')
  style(catalog, { padding: '18px', borderRight: '1px solid var(--color-border, rgba(255,255,255,.09))', overflow: 'auto' })
  const detail = document.createElement('div')
  style(detail, { padding: '18px 22px', overflow: 'auto' })
  root.append(catalog, detail)
  context.container.append(root)

  const intro = document.createElement('p')
  intro.textContent = context.t('page.subtitle')
  style(intro, { margin: '0 0 14px', color: 'var(--color-text-secondary, rgba(255,255,255,.7))' })
  const controls = document.createElement('div')
  style(controls, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px', marginBottom: '10px' })
  const providerSelect = select(document, context.t('field.provider'))
  const modelSelect = select(document, context.t('field.model'))
  const cwd = input(document, context.t('field.cwd')) as HTMLInputElement
  cwd.placeholder = context.t('field.cwd')
  cwd.value = config.defaultCwd ?? ''
  const search = input(document, context.t('field.search')) as HTMLInputElement
  search.placeholder = context.t('field.search')
  const initialMessage = input(document, context.t('field.initial-message')) as HTMLInputElement
  initialMessage.placeholder = context.t('field.initial-message')
  const refresh = button(document, context.t('action.refresh'))
  const create = button(document, context.t('action.create'))
  controls.append(providerSelect, modelSelect, cwd, search, initialMessage, refresh, create)
  const status = document.createElement('div')
  status.setAttribute('role', 'status')
  style(status, { minHeight: '20px', margin: '5px 0', color: 'var(--color-text-secondary, rgba(255,255,255,.7))' })
  const list = document.createElement('div')
  list.setAttribute('role', 'list')
  style(list, { display: 'grid', borderTop: '1px solid var(--color-border, rgba(255,255,255,.09))' })
  const loadMore = button(document, context.t('action.load-more'))
  loadMore.hidden = true
  style(loadMore, { marginTop: '10px', width: '100%' })
  catalog.append(intro, controls, status, list, loadMore)

  let models: readonly CordisXModelDescriptor[] = []
  let sessions: CordisXSessionSummary[] = []
  let nextCursor: string | undefined
  let selected: CordisXSessionProjection | CordisXSessionSummary | undefined
  let operation = 0

  const providerFilter = (): readonly string[] | undefined => providerSelect.value === ''
    ? config.providerIds ?? [...new Set(models.map(item => item.ref.providerId))].sort()
    : [providerSelect.value]

  const renderModels = (): void => {
    const currentProvider = providerSelect.value
    const currentModel = modelSelect.value
    const providerIds = [...new Set(models.map(item => item.ref.providerId))].sort()
    providerSelect.replaceChildren(new Option('All providers', ''))
    for (const providerId of providerIds) providerSelect.append(new Option(providerId, providerId))
    if (providerIds.includes(currentProvider)) providerSelect.value = currentProvider
    const visible = models.filter(item => providerSelect.value === '' || item.ref.providerId === providerSelect.value)
    modelSelect.replaceChildren(...visible.map(item => new Option(`[${item.ref.providerId}] ${item.label}`, modelKey(item.ref), item.ref.providerId === providerSelect.value && item.isDefault === true)))
    if (visible.some(item => modelKey(item.ref) === currentModel)) modelSelect.value = currentModel
    create.disabled = visible.length === 0 || cwd.value.trim() === ''
  }

  const renderList = (): void => {
    list.replaceChildren()
    if (sessions.length === 0) {
      const empty = document.createElement('p')
      empty.textContent = context.t('state.empty')
      style(empty, { color: 'var(--color-text-secondary, rgba(255,255,255,.7))' })
      list.append(empty)
    }
    for (const session of sessions) {
      const row = document.createElement('button')
      row.type = 'button'
      row.dataset.session = sessionKey(session.ref)
      row.dataset.cordisxNoDrag = 'true'
      row.setAttribute('role', 'listitem')
      style(row, {
        display: 'grid', gap: '4px', padding: '11px 4px', textAlign: 'left', border: '0',
        borderBottom: '1px solid var(--color-border, rgba(255,255,255,.07))', background: 'transparent', color: 'inherit', cursor: 'pointer',
      })
      const title = document.createElement('strong')
      title.textContent = session.title ?? session.ref.remoteSessionId
      const meta = document.createElement('span')
      meta.textContent = `${context.t('session.provider', { provider: session.ref.providerId })} · ${context.t('session.model', { model: session.model.modelId })}`
      style(meta, { color: 'var(--color-text-secondary, rgba(255,255,255,.68))', fontSize: '12px' })
      const location = document.createElement('span')
      location.textContent = session.cwd
      style(location, { color: 'var(--color-text-tertiary, rgba(255,255,255,.48))', overflow: 'hidden', textOverflow: 'ellipsis' })
      row.append(title, meta, location)
      row.addEventListener('click', () => { void read(session.ref) })
      list.append(row)
    }
    loadMore.hidden = nextCursor === undefined
  }

  const renderDetail = (): void => {
    detail.replaceChildren()
    if (selected === undefined) {
      const empty = document.createElement('p')
      empty.textContent = context.t('state.select-session')
      style(empty, { color: 'var(--color-text-secondary, rgba(255,255,255,.7))' })
      detail.append(empty)
      return
    }
    const heading = document.createElement('h2')
    heading.textContent = selected.title ?? selected.ref.remoteSessionId
    style(heading, { margin: '0 0 4px', fontSize: '18px' })
    const identity = document.createElement('code')
    identity.textContent = `${selected.ref.providerId} / ${selected.ref.remoteSessionId}`
    style(identity, { color: 'var(--color-text-secondary, rgba(255,255,255,.68))', overflowWrap: 'anywhere' })
    const actions = document.createElement('div')
    style(actions, { display: 'flex', flexWrap: 'wrap', gap: '8px', margin: '14px 0' })
    const actionNames = selected.state === 'archived'
      ? ['restore', 'delete'] as const
      : ['continue', 'fork', 'archive', 'delete'] as const
    for (const action of actionNames) {
      const control = button(document, context.t(`action.${action}`))
      control.addEventListener('click', () => { void controlSession(action, selected!.ref) })
      actions.append(control)
    }
    detail.append(heading, identity, actions)
    if ('turns' in selected) {
      const turns = document.createElement('div')
      style(turns, { display: 'grid', gap: '14px', margin: '18px 0' })
      for (const turn of selected.turns) {
        const block = document.createElement('section')
        const label = document.createElement('strong')
        label.textContent = `${turn.state} · ${turn.id}`
        block.append(label)
        for (const item of turn.items) {
          const content = document.createElement('p')
          content.textContent = item.text ?? `[${item.kind}]`
          style(content, { margin: '7px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
          block.append(content)
        }
        turns.append(block)
      }
      detail.append(turns)
    }
    if (selected.state === 'active') {
      const composer = input(document, context.t('action.send'), 'textarea') as HTMLTextAreaElement
      const send = button(document, context.t('action.send'))
      send.addEventListener('click', () => { void submit(selected!.ref, composer) })
      detail.append(composer, send)
      const activeTurn = 'turns' in selected
        ? [...selected.turns].reverse().find(turn => turn.state === 'in-progress')
        : undefined
      if (activeTurn !== undefined) {
        const steerMessage = input(document, context.t('action.steer')) as HTMLInputElement
        const steer = button(document, context.t('action.steer'))
        const interrupt = button(document, context.t('action.interrupt'))
        steer.addEventListener('click', () => { void controlTurn('steer', selected!.ref, activeTurn.id, steerMessage.value) })
        interrupt.addEventListener('click', () => { void controlTurn('interrupt', selected!.ref, activeTurn.id) })
        const turnControls = document.createElement('div')
        style(turnControls, { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', marginTop: '10px' })
        turnControls.append(steerMessage, steer, interrupt)
        detail.append(turnControls)
      }
    }
  }

  const showError = (error: { readonly message: string }): void => {
    status.textContent = context.t('state.error', { message: error.message })
  }

  const refreshAll = async (): Promise<void> => {
    const generation = ++operation
    status.textContent = context.t('state.loading')
    const modelPage = await ctx.platform.models.list(config.providerIds === undefined ? {} : { providerIds: config.providerIds })
    if (generation !== operation) return
    if (!modelPage.ok) return showError(modelPage.error)
    models = modelPage.value.models
    renderModels()
    await refreshSessions(generation)
  }

  const refreshSessions = async (generation = ++operation): Promise<void> => {
    status.textContent = context.t('state.loading')
    const ids = providerFilter()
    const page = await ctx.platform.tasks.list({
      ...(ids === undefined ? {} : { providerIds: ids }),
      ...(cwd.value.trim() === '' ? {} : { cwd: cwd.value.trim() }),
      ...(search.value.trim() === '' ? {} : { searchTerm: search.value.trim() }),
      limit: 50,
    })
    if (generation !== operation) return
    if (!page.ok) return showError(page.error)
    sessions = [...page.value.sessions]
    nextCursor = page.value.nextCursor
    status.textContent = models.length === 0 ? context.t('state.no-models') : ''
    renderList()
  }

  const more = async (): Promise<void> => {
    if (nextCursor === undefined) return
    const cursor = nextCursor
    const ids = providerFilter()
    const page = await ctx.platform.tasks.list({
      ...(ids === undefined ? {} : { providerIds: ids }),
      ...(cwd.value.trim() === '' ? {} : { cwd: cwd.value.trim() }),
      ...(search.value.trim() === '' ? {} : { searchTerm: search.value.trim() }),
      cursor,
      limit: 50,
    })
    if (!page.ok) return showError(page.error)
    const known = new Set(sessions.map(item => sessionKey(item.ref)))
    sessions.push(...page.value.sessions.filter(item => !known.has(sessionKey(item.ref))))
    nextCursor = page.value.nextCursor
    renderList()
  }

  const read = async (ref: CordisXPlatformSessionRef): Promise<void> => {
    const result = await ctx.platform.tasks.read({ session: ref })
    if (!result.ok) return showError(result.error)
    selected = result.value
    renderDetail()
  }

  const createSession = async (): Promise<void> => {
    const model = parsedModel(modelSelect.value)
    if (model === undefined || cwd.value.trim() === '') return
    const result = await ctx.platform.tasks.create({
      model,
      cwd: cwd.value.trim(),
      ...(initialMessage.value.trim() === '' ? {} : { initialMessage: initialMessage.value.trim() }),
    })
    if (!result.ok) return showError(result.error)
    selected = result.value.session
    initialMessage.value = ''
    renderDetail()
    if (result.value.status === 'created-initial-turn-failed') showError(result.value.error)
    await refreshSessions()
    if (result.value.status === 'created' && result.value.initialTurn !== undefined) await read(result.value.session.ref)
  }

  const controlSession = async (action: 'continue' | 'fork' | 'archive' | 'restore' | 'delete', ref: CordisXPlatformSessionRef): Promise<void> => {
    const result = await ctx.platform.tasks.control({ action, session: ref } as Parameters<typeof ctx.platform.tasks.control>[0])
    if (!result.ok) return showError(result.error)
    if (result.value.action === 'delete') selected = undefined
    else selected = result.value.session
    renderDetail()
    await refreshSessions()
  }

  const submit = async (ref: CordisXPlatformSessionRef, composer: HTMLTextAreaElement): Promise<void> => {
    const text = composer.value.trim()
    if (text === '') return
    const result = await ctx.platform.turns.submit({ session: ref, message: text })
    if (!result.ok) return showError(result.error)
    composer.value = ''
    await read(ref)
  }

  const controlTurn = async (
    action: 'steer' | 'interrupt',
    ref: CordisXPlatformSessionRef,
    turnId: string,
    messageText = '',
  ): Promise<void> => {
    const result = await ctx.platform.turns.control(action === 'steer'
      ? { action, session: ref, turnId, message: messageText.trim() }
      : { action, session: ref, turnId })
    if (!result.ok) return showError(result.error)
    await read(ref)
  }

  providerSelect.addEventListener('change', () => { renderModels(); void refreshSessions() })
  cwd.addEventListener('input', () => { create.disabled = modelSelect.options.length === 0 || cwd.value.trim() === '' })
  search.addEventListener('keydown', event => { if (event.key === 'Enter') void refreshSessions() })
  refresh.addEventListener('click', () => { void refreshAll() })
  create.addEventListener('click', () => { void createSession() })
  loadMore.addEventListener('click', () => { void more() })
  renderDetail()
  void refreshAll()
  return () => {
    operation += 1
    root.remove()
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.i18n.define<Messages>({
    namespace: 'cli-proxy-api', locale: 'en', default: true, messages: {
      'navigation.title': 'Providers', 'navigation.description': 'Models and sessions across external CLIProxyAPI providers',
      'page.title': 'Provider sessions', 'page.subtitle': 'Each model and session keeps its provider identity through create, list, search, resume, and control.',
      'field.provider': 'Provider', 'field.model': 'Model', 'field.cwd': 'Working directory', 'field.search': 'Search sessions',
      'field.initial-message': 'Initial message (recommended for persistence)',
      'action.refresh': 'Refresh', 'action.create': 'New session', 'action.load-more': 'Load more', 'action.continue': 'Continue',
      'action.fork': 'Fork', 'action.archive': 'Archive', 'action.restore': 'Restore', 'action.delete': 'Delete', 'action.send': 'Send message',
      'action.steer': 'Steer active turn', 'action.interrupt': 'Interrupt',
      'state.loading': 'Loading providers…', 'state.empty': 'No matching sessions.', 'state.no-models': 'No provider models are available.',
      'state.select-session': 'Select a provider session to inspect its content.', 'state.error': 'Provider request failed: {message}',
      'session.provider': 'Provider {provider}', 'session.model': 'Model {model}',
      'permission.models.read': 'List models from configured external providers', 'permission.tasks.catalog.read': 'List and search external provider sessions',
      'permission.tasks.content.read': 'Read selected external provider session content', 'permission.tasks.create': 'Create a session for the selected provider model',
      'permission.tasks.control': 'Continue, fork, archive, restore, or delete selected sessions', 'permission.turns.submit': 'Send messages to selected sessions',
      'permission.turns.control': 'Steer or interrupt selected turns',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'cli-proxy-api', locale: 'zh-CN', messages: {
      'navigation.title': 'Providers', 'navigation.description': '统一管理多个 CLIProxyAPI Provider 的模型与会话',
      'page.title': 'Provider 会话', 'page.subtitle': '模型、创建、列表、搜索、续聊和控制始终携带 Provider 复合身份。',
      'field.provider': 'Provider', 'field.model': '模型', 'field.cwd': '工作目录', 'field.search': '搜索会话',
      'field.initial-message': '首条消息（建议填写以立即持久化）',
      'action.refresh': '刷新', 'action.create': '新建会话', 'action.load-more': '加载更多', 'action.continue': '继续',
      'action.fork': '分叉', 'action.archive': '归档', 'action.restore': '恢复', 'action.delete': '删除', 'action.send': '发送消息',
      'action.steer': '引导进行中的 turn', 'action.interrupt': '中断',
      'state.loading': '正在加载 Provider…', 'state.empty': '没有匹配的会话。', 'state.no-models': '没有可用的 Provider 模型。',
      'state.select-session': '选择一个 Provider 会话以查看内容。', 'state.error': 'Provider 请求失败：{message}',
      'session.provider': 'Provider {provider}', 'session.model': '模型 {model}',
      'permission.models.read': '读取已配置外部 Provider 的模型', 'permission.tasks.catalog.read': '列出并搜索外部 Provider 会话',
      'permission.tasks.content.read': '读取所选外部 Provider 会话内容', 'permission.tasks.create': '用所选 Provider 模型创建会话',
      'permission.tasks.control': '继续、分叉、归档、恢复或删除所选会话', 'permission.turns.submit': '向所选会话发送消息',
      'permission.turns.control': '引导或中断所选 turn',
    },
  })
  ctx.pages.register<Messages>({ id: 'providers.sessions', title: message('page.title'), icon: 'host:layers', localeNamespace: 'cli-proxy-api' }, context => mountFleet(ctx, context, config))
  ctx.routes.register({ id: 'providers.sessions', path: '/main/providers/sessions', outlet: 'main', page: 'providers.sessions' })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'providers', order: -100 }, {
    label: message('navigation.title'), description: message('navigation.description'), icon: 'host:layers', route: { id: 'providers.sessions' },
  })
}
