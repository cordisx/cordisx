import { safeServiceConfigEdit } from './manager-schema.js'
import { createChannelCredentialsUI } from './manager-channel-ui.js'

const tokenFromLink = location.hash.slice(1)
let token = sessionStorage.getItem('cordisx-manager-session')
if (/^[a-f0-9]{64}$/.test(tokenFromLink)) {
  history.replaceState(null, '', location.pathname)
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenFromLink }),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('SESSION_UNAVAILABLE')
    token = (await response.json()).token
    sessionStorage.setItem('cordisx-manager-session', token)
  } catch {
    token = null
  }
}
const element = id => document.getElementById(id)
let snapshot
let modelDirty = false
let modelRevision
let modelsSaving = false
let modelsLoading = true
let refreshVersion = 0
let modelResultUnknown = false
let managedServiceLoginBusy = false
let managedServiceRefreshVersion = 0
const uncertainManagedServices = new Set()
// Keep unrelated editors mounted while any of them has an unsaved draft.
const pluginDrafts = new Set()

function trackPluginDraft(element) {
  const mark = () => pluginDrafts.add(element)
  element.addEventListener('input', mark)
  element.addEventListener('change', mark)
}
function hasPluginDrafts(target, except) {
  return [...pluginDrafts].some(draft => target.contains(draft) && draft !== except)
}
function mayDiscardPluginDrafts(target, except) {
  return !hasPluginDrafts(target, except) || confirm('其他未保存的插件配置修改将被放弃，是否继续？')
}
function clearPluginDrafts(target) {
  for (const draft of pluginDrafts) if (target.contains(draft)) pluginDrafts.delete(draft)
}
function lockUncertainPluginWrites(target, control) {
  control.dataset.locked = 'true'
  for (const item of target.parentElement.querySelectorAll('button')) {
    if (item.dataset.refreshConfiguration === 'true') continue
    if (item.dataset.uncertainDisabled === undefined) item.dataset.uncertainDisabled = String(item.disabled)
    item.disabled = true
  }
  message('插件配置结果不确定，请重新读取并核对；不能直接重试。')
}
function unlockPluginWrites(target) {
  for (const item of target.parentElement.querySelectorAll('button[data-uncertain-disabled]')) {
    item.disabled = item.dataset.uncertainDisabled === 'true'
    delete item.dataset.uncertainDisabled
  }
}
async function whileControlsFrozen(container, operation) {
  const controls = [...container.querySelectorAll('input, textarea, select, button')]
  const disabled = controls.map(control => control.disabled)
  controls.forEach(control => {
    control.disabled = true
  })
  try {
    return await operation()
  } finally {
    controls.forEach((control, index) => {
      control.disabled = disabled[index]
    })
  }
}

function node(tag, text, className) {
  const result = document.createElement(tag)
  if (text !== undefined) result.textContent = text
  if (className) result.className = className
  return result
}
function message(text) {
  element('message').textContent = text
}
function failure(error) {
  const categories = {
    MANAGER_OWNER_CHANGED: '后台已切换，请重新打开管理台后核对状态。',
    MANAGER_OWNER_UNAVAILABLE: '后台当前不可用，请检查对应 Host。',
    OWNER_UNAVAILABLE: '后台当前不可用，请检查对应 Host。',
    OPERATION_RESULT_UNKNOWN: '操作结果不确定，请先刷新并核对，不能直接重试。',
    MODEL_SERVICE_SAFE_WRITE_UNAVAILABLE: '当前 Host 未确认安全保存能力；模型服务仅供查看。',
    UNAUTHORIZED: '管理会话已过期，请重新打开管理台。',
  }
  message(categories[error?.message] ?? '操作暂不可用；请检查后台状态。')
}
function button(text, click, disabled = false) {
  const result = node('button', text)
  result.type = 'button'
  result.disabled = disabled
  result.addEventListener('click', async () => {
    if (result.disabled) return
    result.disabled = true
    try {
      await click()
      if (result.dataset.locked !== 'true') result.disabled = false
    } catch (error) {
      result.dataset.locked = 'true'
      failure(error)
    }
  })
  return result
}
function label(text, control) {
  const result = node('label', text)
  result.append(control)
  return result
}
const channelCredentials = createChannelCredentialsUI({
  api,
  element,
  node,
  button,
  input,
  label,
  message,
  freeze: whileControlsFrozen,
  confirmAction: text => confirm(text),
})
function input(value = '', type = 'text') {
  const result = node('input')
  result.type = type
  result.value = value
  return result
}
async function api(path, value) {
  if (!token) throw new Error('NO_SESSION')
  let response
  try {
    response = await fetch(path, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      cache: 'no-store',
    })
  } catch {
    throw new Error(value === undefined ? 'OWNER_UNAVAILABLE' : 'OPERATION_RESULT_UNKNOWN')
  }
  if (!response.ok) {
    const details = await response.json().catch(() => ({}))
    const code = typeof details.error === 'string' ? details.error : 'REQUEST_FAILED'
    if (
      value !== undefined
      && ![
        'INVALID_REQUEST',
        'INVALID_ORIGIN',
        'INVALID_HOST',
        'UNAUTHORIZED',
        'METHOD_NOT_ALLOWED',
        'MODEL_SERVICE_SAFE_WRITE_UNAVAILABLE',
      ].includes(code)
    ) {
      throw new Error('OPERATION_RESULT_UNKNOWN')
    }
    throw new Error(code)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(value === undefined ? 'OWNER_UNAVAILABLE' : 'OPERATION_RESULT_UNKNOWN')
  }
}
function showResult(result) {
  const categories = {
    conflict: '配置版本已变化，请刷新后重新确认。',
    'stale-revision': '配置版本已变化，请刷新后重新确认。',
    'stale-generation': '后台已更换，请重新打开管理台。',
    'permission-denied': '现有 Host 权限不允许此操作。',
    'validation-failed': '配置未通过 Host 验证，请检查填写的字段。',
    'service-restart-failed': '服务重启失败；请检查服务状态和原有配置。',
    'lifecycle-unavailable': '当前后台不能执行插件生命周期操作。',
    'review-busy': '另一个权限审核正在进行；请稍后刷新并重新查看。',
  }
  if (result?.status === 'permission-review-required') {
    message('此操作需要现有权限审核流程；尚未执行。')
  } else if (result?.status === 'conflict') {
    message('配置已被其他位置修改；请刷新后重试。')
  } else if (result?.status === 'unknown') {
    message('结果不确定，请先刷新并核对，不能直接重试。')
  } else if (result?.status === 'unavailable' || result?.status === 'rejected') {
    const code = result?.reason ?? result?.code ?? result?.error?.code
    message(categories[code] ?? '操作未完成：当前功能不可用或请求被拒绝。')
  } else if (result?.status === 'staged' || result?.applies === 'app-restart') {
    message('已保存；完整重启对应 Host 后生效。')
  } else if (result?.status === 'applied' && result?.configApplies === 'service-restart') {
    message('配置已保存，服务已重启并生效。')
  } else if (result?.status === 'ok' || result?.status === 'applied') {
    message('操作完成。')
  } else {
    message('操作结果未知，请刷新并核对。')
  }
}
async function manage(request) {
  const plan = await api('/api/management', { kind: 'plan', request })
  if (plan.status === 'permission-review-required') return reviewPermissions(plan)
  if (plan.status !== 'planned') return showResult(plan)
  const affected = (plan.affectedPluginIds ?? []).join('、')
  if (!confirm(`确认执行此操作？${affected ? `\n涉及插件：${affected}` : ''}`)) return
  const result = await api('/api/management', {
    kind: 'execute',
    request: plan.executionRequest ?? request,
    expectedRevision: plan.snapshot.revision,
  })
  if (result.status === 'permission-review-required') return reviewPermissions(result)
  showResult(result)
  if (result.status === 'applied') await refresh(false)
}

function permissionText(value) {
  if (typeof value === 'string') return value
  return value?.fallback ?? value?.['zh-CN'] ?? value?.en ?? ''
}
function reviewPermissions(result) {
  const plan = result.permissionPlan
  if (!plan || ![2, 4].includes(plan.schemaVersion) || !Array.isArray(plan.declarations)) {
    return message('此权限计划的版本当前不可在独立管理台审核，操作未执行。')
  }
  const dialog = node('dialog')
  dialog.append(node('h2', '审核插件权限'))
  dialog.append(node('p', `${plan.identity.pluginId} · ${plan.operation} · ${plan.profileId}`))
  dialog.append(node('p', `来源：${plan.identity.source}`, 'muted'))
  const validation = node('p', undefined, 'message')
  validation.setAttribute('role', 'alert')
  dialog.append(validation)
  const inputs = []
  const options = {
    'allow-once': '允许本次',
    'allow-persistent': '持续允许',
    'deny-once': '拒绝本次',
    'deny-persistent': '持续拒绝',
  }
  for (const declaration of plan.declarations) {
    const field = node('fieldset', undefined, 'permission-item')
    field.append(node('legend', `${declaration.capability} · ${declaration.required ? '必需' : '可选'}`))
    for (
      const text of [
        declaration.presentation?.name,
        declaration.presentation?.description,
        declaration.presentation?.risk,
        declaration.presentation?.limitation,
        declaration.rationale?.title,
        declaration.rationale?.description,
        declaration.rationale?.feature,
        declaration.rationale?.deniedBehavior,
      ]
    ) {
      const value = permissionText(text)
      if (value) field.append(node('p', value))
    }
    if (declaration.security) {
      field.append(node('pre', `数据使用声明：\n${JSON.stringify(declaration.security, null, 2)}`))
    }
    field.append(node('pre', JSON.stringify(declaration.scope, null, 2)))
    const requiresChoice = plan.schemaVersion === 2 || declaration.decisionRequired === true
    if (requiresChoice) {
      const select = node('select')
      const placeholder = node('option', '请选择')
      placeholder.value = ''
      select.append(placeholder)
      for (const value of declaration.allowedDecisions ?? []) {
        const option = node('option', options[value] ?? value)
        option.value = value
        select.append(option)
      }
      field.append(label('权限决定', select))
      inputs.push({ declaration, select })
    } else {
      field.append(node('p', '该项不需要新的决定，Host 将沿用当前策略。', 'muted'))
    }
    dialog.append(field)
  }
  const actions = node('div', undefined, 'actions')
  actions.append(button('取消', () => dialog.close()))
  const submit = button('提交审核', async () => {
    if (inputs.some(item => !item.select.value)) {
      validation.textContent = '请逐项选择权限决定，或取消。'
      return
    }
    if (inputs.some(item => item.declaration.required && item.select.value.startsWith('deny'))) {
      validation.textContent = '拒绝必需权限时请取消安装或启用。'
      return
    }
    if (!confirm('确认按页面显示的每项权限决定继续？')) return
    submit.dataset.locked = 'true'
    const decision = {
      $schema:
        `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v${plan.schemaVersion}.schema.json`,
      schemaVersion: plan.schemaVersion,
      ...(plan.schemaVersion === 4 ? { origin: 'explicit-user' } : {}),
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: inputs.map(({ declaration, select }) => ({
        capability: declaration.capability,
        scope: declaration.scope,
        securityFingerprint: declaration.securityFingerprint,
        decision: select.value,
      })),
    }
    let applied
    try {
      applied = await api('/api/permission-review', {
        expectedRevision: result.snapshot.activationRevision,
        userConfirmed: true,
        decision,
      })
    } catch {
      validation.textContent = '审核结果不确定，请关闭弹窗并刷新核对；不要直接重试。'
      return
    }
    dialog.close()
    if (applied.status !== 'ok') return showResult(applied)
    if (applied.result?.outcome === 'applied') {
      message('权限决定已保存，插件操作已完成。')
      await refresh(false)
    } else {
      message(`插件操作未完成：${applied.result?.outcome ?? '结果未知'}。请刷新并核对后再操作。`)
    }
  })
  actions.append(submit)
  dialog.append(actions)
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  document.body.append(dialog)
  dialog.showModal()
}

function modelCard(model, isNew = false, editable = true) {
  const card = node('article', undefined, 'card')
  card.model = model
  card.append(node('h3', isNew ? '新模型服务' : model.displayName))
  const fields = node('div', undefined, 'fields')
  const id = input(model.id), name = input(model.displayName), url = input(model.baseUrl, 'url')
  const key = input('', 'password')
  const codex = node('textarea'), claude = node('textarea')
  const responses = input('', 'checkbox'), messages = input('', 'checkbox'), enabled = input('', 'checkbox')
  id.disabled = !isNew
  key.autocomplete = 'new-password'
  key.placeholder = model.keyConfigured ? '已设置；留空保留原值' : '输入新密钥'
  codex.value = (model.codexModels ?? []).join('\n')
  claude.value = (model.claudeModels ?? []).join('\n')
  responses.checked = (model.protocols ?? ['openai-responses']).includes('openai-responses')
  messages.checked = (model.protocols ?? []).includes('anthropic-messages')
  enabled.checked = model.enabled !== false
  fields.append(label('服务 ID', id), label('显示名称', name), label('服务地址', url), label('API 密钥', key))
  fields.append(label('Codex 模型（每行一个）', codex), label('Claude 模型（每行一个）', claude))
  for (const [text, check] of [['OpenAI Responses', responses], ['Anthropic Messages', messages], ['启用', enabled]]) {
    const item = label(text, check)
    item.className = 'check'
    fields.append(item)
  }
  if (!editable) { for (const control of fields.querySelectorAll('input,textarea')) control.disabled = true }
  card.append(
    fields,
    button('从草稿移除', () => {
      card.remove()
      modelDirty = true
    }, !editable),
  )
  card.readDraft = () => ({
    id: id.value.trim(),
    displayName: name.value.trim(),
    baseUrl: url.value.trim(),
    protocols: [responses.checked && 'openai-responses', messages.checked && 'anthropic-messages'].filter(Boolean),
    codexModels: codex.value.split('\n').map(item => item.trim()).filter(Boolean),
    claudeModels: claude.value.split('\n').map(item => item.trim()).filter(Boolean),
    enabled: enabled.checked,
    ...(key.value ? { apiKey: key.value } : {}),
  })
  return card
}
function renderModels(result) {
  const target = element('models')
  target.replaceChildren()
  const available = result?.status === 'ok'
  const editable = available && result.managerSafeWrite === 'cordisx.model-service-safe-write/v1'
  modelRevision = available ? result.revision : undefined
  element('add-model').disabled = !editable
  syncModelSaveAvailability()
  if (!available) return target.append(node('p', '此 Host 未提供模型服务配置。', 'muted'))
  if (!editable) {
    target.append(
      node('p', '当前 Host 尚未确认安全保存能力，模型服务仅供查看；请升级 Host 后重新打开管理台。', 'muted'),
    )
  }
  if (!result.services.length) target.append(node('p', '尚未配置共享模型服务。', 'muted'))
  for (const model of result.services) target.append(modelCard(model, false, editable))
}
function canSaveModels() {
  return !modelsLoading && snapshot?.services?.status === 'ok' && typeof modelRevision === 'string'
    && snapshot.services.managerSafeWrite === 'cordisx.model-service-safe-write/v1'
    && snapshot.services.revision === modelRevision && !modelResultUnknown
}
function syncModelSaveAvailability() {
  element('save-models').disabled = modelsSaving || !canSaveModels()
}
async function saveModels() {
  if (!canSaveModels()) return message('模型服务状态不可用或已变化，请先核对并刷新草稿。')
  const services = [...element('models').querySelectorAll('.card')].map(card => card.readDraft())
  if (services.some(item => !item.id || !item.displayName || !item.baseUrl || !item.protocols.length)) {
    return message('请填写服务 ID、名称、地址，并选择至少一种协议。')
  }
  await whileControlsFrozen(element('models').closest('section'), async () => {
    const result = await api('/api/model-services', { expectedRevision: modelRevision, services })
    const rejectedBeforeWrite = result?.status === 'rejected' && ['invalid', 'conflict'].includes(result.code)
    if (result?.status !== 'applied' && !rejectedBeforeWrite && result?.status !== 'unavailable') {
      modelResultUnknown = true
      message('模型服务保存结果不确定，请刷新并核对；不能直接重试。')
    } else showResult(result)
    if (result.status === 'applied') {
      modelDirty = false
      try {
        await refresh(false)
      } catch {
        modelDirty = true
        modelResultUnknown = true
        message('已保存，但无法刷新服务状态；草稿已保留，请先核对后再放弃或重新编辑。')
        return
      }
      message('模型服务已保存，应用时机：重启对应客户端。')
    }
  })
}
function renderSources(management) {
  const target = element('sources')
  target.replaceChildren()
  if (!management?.sources) return target.append(node('p', '来源管理暂不可用。', 'muted'))
  if (!management.sources.length) target.append(node('p', '没有配置来源。', 'muted'))
  for (const source of management.sources) {
    const card = node('article', undefined, 'card row')
    const text = node('div')
    text.append(node('strong', source.local?.name ?? source.url), node('div', source.url, 'muted'))
    text.append(
      node('div', `${source.enabled ? '已启用' : '已停用'} · ${source.trusted ? '可信来源' : '未标记为可信'}`, 'muted'),
    )
    const actions = node('div', undefined, 'actions')
    actions.append(button('编辑', async () => {
      const url = prompt('来源地址', source.url)
      if (url === null) return
      const name = prompt('来源名称', source.local?.name ?? '')
      if (name === null) return
      const local = { ...source.local }
      if (name.trim()) local.name = name.trim()
      else delete local.name
      await manage({
        kind: 'source-edit',
        url: source.url,
        source: {
          url: url.trim(),
          enabled: source.enabled,
          trusted: source.trusted,
          ...(Object.keys(local).length ? { local } : {}),
        },
      })
    }))
    actions.append(
      button(
        source.enabled ? '停用' : '启用',
        () => manage({ kind: 'source-set-enabled', url: source.url, enabled: !source.enabled }),
      ),
    )
    actions.append(button('移除', () => manage({ kind: 'source-remove', url: source.url }), !source.removable))
    card.append(text, actions)
    target.append(card)
  }
}

function fieldEditor(field) {
  const current = field.value
  let control, read, dirty = false
  if (field.choices?.length) {
    control = node('select')
    field.choices.forEach((choice, index) => {
      const option = node('option', choice.label)
      option.value = String(index)
      option.selected = JSON.stringify(choice.value) === JSON.stringify(current)
      control.append(option)
    })
    read = () => field.choices[Number(control.value)]?.value
  } else if (typeof current === 'boolean') {
    control = input('', 'checkbox')
    control.checked = current
    read = () => control.checked
  } else if (typeof current === 'string') {
    control = input(current)
    read = () => control.value
  } else {
    control = node('textarea')
    control.value = JSON.stringify(current ?? null, null, 2)
    read = () => JSON.parse(control.value)
  }
  control.disabled = field.disabled
  control.addEventListener('input', () => {
    dirty = true
  })
  control.addEventListener('change', () => {
    dirty = true
  })
  const wrapper = label(field.label || field.path.join('.'), control)
  if (field.description) wrapper.append(node('small', field.description, 'muted'))
  return { wrapper, read, field, dirty: () => dirty }
}
async function openPluginConfig(plugin, target) {
  const revision = (target.requestRevision ?? 0) + 1
  target.requestRevision = revision
  target.replaceChildren(node('p', '正在读取配置…', 'muted'))
  const response = await api('/api/plugin-configuration', { action: 'read', pluginId: plugin.id })
  if (target.requestRevision !== revision) return
  if (response.status !== 'ok') {
    target.replaceChildren(node('p', `插件配置不可用：${response.reason ?? '需要唯一活动的客户端'}`, 'muted'))
    return
  }
  const config = response.configuration
  const editors = (config.fields ?? []).map(fieldEditor)
  const fields = node('div', undefined, 'fields')
  trackPluginDraft(fields)
  for (const editor of editors) fields.append(editor.wrapper)
  target.replaceChildren(fields)
  if (!editors.length) target.append(node('p', '此插件没有可编辑的普通配置字段。', 'muted'))
  if (config.secrets?.length) target.append(node('p', '敏感字段由原有凭据通道管理，不会在此显示。', 'muted'))
  const savePlugin = button('保存插件配置', async () => {
    let changes
    try {
      changes = editors.flatMap(editor => {
        if (!editor.dirty()) return []
        const value = editor.read()
        return JSON.stringify(value) === JSON.stringify(editor.field.value)
          ? []
          : [{ op: 'set', path: editor.field.path, value }]
      })
    } catch {
      return message('配置值不是有效的 JSON。')
    }
    if (!changes.length) return message('没有配置变更。')
    if (!mayDiscardPluginDrafts(target, fields)) return
    let uncertain = false
    try {
      await whileControlsFrozen(target.parentElement, async () => {
        const result = await api('/api/plugin-configuration', {
          action: 'update',
          pluginId: plugin.id,
          expectedRevision: config.revision,
          operations: changes,
        })
        if (!['ok', 'rejected', 'unavailable'].includes(result?.status)) {
          uncertain = true
          return
        }
        showResult(result)
        if (result.status === 'ok') {
          clearPluginDrafts(target)
          await openPluginConfig(plugin, target)
          message(config.applies === 'app-restart' ? '已保存；完整重启对应 Host 后生效。' : '插件配置已保存并应用。')
        }
      })
    } catch (error) {
      if (error?.message !== 'OPERATION_RESULT_UNKNOWN') throw error
      uncertain = true
    }
    if (uncertain) lockUncertainPluginWrites(target, savePlugin)
  }, !config.writable)
  target.append(savePlugin)
  const services = await api('/api/plugin-configuration', { action: 'services', pluginId: plugin.id })
  if (target.requestRevision !== revision) return
  if (services.status === 'ok') {
    for (const service of services.services ?? []) appendServiceConfig(plugin, service, target)
    unlockPluginWrites(target)
  }
}
function appendServiceConfig(plugin, service, target) {
  const section = node('div', undefined, 'detail')
  trackPluginDraft(section)
  section.append(node('h3', `服务配置：${service.identity.serviceId}`))
  if (service.restartRequired) section.append(node('p', '已有配置等待重启后生效。', 'muted'))
  if (service.schema?.projection?.kind !== 'schemastery') {
    section.append(node('p', '此服务未提供可呈现的配置 schema；编辑暂不可用。', 'muted'))
    target.append(section)
    return
  }
  section.append(
    node(
      'p',
      '高级配置（JSON）：只能修改现有条目的普通字段；新增或删除数组项暂不支持。敏感字段通过独立凭据通道管理。',
      'muted',
    ),
  )
  const editor = node('textarea')
  editor.value = JSON.stringify(service.configuration, null, 2)
  editor.disabled = !service.writable
  section.append(editor)
  if (service.secrets?.length) section.append(node('p', '服务密钥由凭据通道管理，不在此回显。', 'muted'))
  const saveService = button('保存服务配置', async () => {
    let configuration
    try {
      configuration = JSON.parse(editor.value)
    } catch {
      return message('服务配置不是有效的 JSON。')
    }
    if (!safeServiceConfigEdit(service.schema.projection.envelope, service.configuration, configuration)) {
      return message('无法保存：修改涉及未知字段、敏感字段或不受支持的数组变更。')
    }
    if (!mayDiscardPluginDrafts(target, section)) return
    let uncertain = false
    try {
      await whileControlsFrozen(target.parentElement, async () => {
        const response = await api('/api/plugin-configuration', {
          action: 'update-service',
          pluginId: plugin.id,
          mutation: {
            contract: 'cordisx.service-config-mutation/v1',
            schemaVersion: 1,
            identity: service.identity,
            scope: service.scope,
            expectedRevision: service.revision,
            configuration,
          },
        })
        if (response.status === 'unknown') {
          uncertain = true
          return
        }
        if (response.status !== 'ok') return showResult(response)
        if (!['applied', 'staged'].includes(response.result?.status)) {
          uncertain = true
          return
        }
        showResult(response.result)
        if (['applied', 'staged'].includes(response.result.status)) {
          clearPluginDrafts(target)
          await openPluginConfig(plugin, target)
        }
      })
    } catch (error) {
      if (error?.message !== 'OPERATION_RESULT_UNKNOWN') throw error
      uncertain = true
    }
    if (uncertain) {
      lockUncertainPluginWrites(target, saveService)
    }
  }, !service.writable)
  section.append(saveService)
  target.append(section)
}
function renderPlugins(management, runtime) {
  const target = element('plugins')
  target.replaceChildren()
  const installed = management?.plugins ?? []
  const discovered = runtime?.status === 'ok' ? runtime.plugins : []
  const plugins = [...new Map([...installed, ...discovered].map(plugin => [plugin.id, plugin])).values()]
  if (!plugins.length) target.append(node('p', '没有可管理的插件。', 'muted'))
  for (const plugin of plugins) {
    const card = node('article', undefined, 'card')
    const header = node('div', undefined, 'row')
    const info = node('div')
    info.append(node('strong', plugin.name || plugin.id), node('div', `${plugin.id} · ${plugin.status}`, 'muted'))
    const actions = node('div', undefined, 'actions')
    const managed = installed.find(item => item.id === plugin.id)
    if (managed) {
      actions.append(
        button(
          managed.enabled ? '停用' : '启用',
          () => manage({ kind: managed.enabled ? 'plugin-disable' : 'plugin-enable', pluginId: plugin.id }),
        ),
      )
    }
    if (managed) actions.append(button('卸载', () => manage({ kind: 'plugin-uninstall', pluginId: plugin.id })))
    const detail = node('div', undefined, 'detail')
    const configure = button('配置', () => {
      if (!mayDiscardPluginDrafts(detail)) return
      clearPluginDrafts(detail)
      return openPluginConfig(plugin, detail)
    }, runtime?.status !== 'ok')
    configure.dataset.refreshConfiguration = 'true'
    actions.append(configure)
    header.append(info, actions)
    card.append(header, detail)
    target.append(card)
  }
  if (runtime?.status !== 'ok') target.append(node('p', '配置编辑需要唯一活动的客户端 renderer；当前不可用。', 'muted'))
}

async function searchCatalog(query = '') {
  const result = await api('/api/catalog', { action: 'search', query })
  const target = element('market-results')
  target.replaceChildren()
  if (!Array.isArray(result)) return target.append(node('p', '插件目录暂不可用。', 'muted'))
  if (!result.length) return target.append(node('p', '没有匹配的插件。', 'muted'))
  for (const plugin of result) {
    const card = node('article', undefined, 'card row')
    const info = node('div')
    info.append(node('strong', plugin.name), node('div', plugin.description, 'muted'))
    card.append(
      info,
      button('安装', () =>
        manage({
          kind: 'plugin-plan-marketplace',
          pluginId: plugin.identity.pluginId,
          sourceUrl: plugin.identity.sourceUrl,
          version: plugin.version,
        }), !plugin.installable),
    )
    target.append(card)
  }
}

function managedServiceMessage(result) {
  if (result?.status === 'unknown' || result?.code === 'LOGIN_RESULT_UNKNOWN') {
    return '登录结果不确定，请刷新状态核对；不要直接重试。'
  }
  const codes = {
    OWNER_UNAVAILABLE: '后台不可用，请检查对应 Host。',
    SESSION_RETIRED: '管理会话已失效，请重新打开管理台。',
    STALE_GENERATION: '服务实例已变化，请刷新状态后重新选择。',
    STALE_REVISION: '服务状态已变化，请刷新后重新确认。',
    SERVICE_UNAVAILABLE: '插件服务当前不可用。',
    LOGIN_UNAVAILABLE: '此服务当前不能登录。',
    LEASE_UNAVAILABLE: '登录准备已过期，请重新查看服务状态。',
    LEASE_LIMIT: '登录准备数量已达上限，请稍后重新查看状态。',
    SESSION_CAPACITY: '登录会话安全容量已满；请稍后重新查看状态。',
    LOGIN_NOT_ACCEPTED: '插件未接受登录请求，请查看服务状态。',
  }
  return codes[result?.code] ?? '插件服务登录暂不可用，请查看服务状态。'
}

async function loginManagedService(item) {
  if (managedServiceLoginBusy) return
  const serviceKey = `${item.pluginId}\u0000${item.serviceId}`
  if (uncertainManagedServices.has(serviceKey)) return
  managedServiceLoginBusy = true
  message('正在联系插件服务，请稍候。')
  try {
    await whileControlsFrozen(element('managed-service-auth'), async () => {
      const target = { pluginId: item.pluginId, serviceId: item.serviceId }
      const view = await api('/api/managed-services', { action: 'view', ...target })
      if (view.status !== 'available' || view.explicitLogin !== true || view.canLogin !== true) {
        return message(managedServiceMessage(view))
      }
      const prepared = await api('/api/managed-services', {
        action: 'prepare-login',
        ...target,
        pluginGeneration: view.pluginGeneration,
        bindingId: view.bindingId,
      })
      if (prepared.status !== 'prepared') return message(managedServiceMessage(prepared))
      const result = await api('/api/managed-services', { action: 'login', leaseId: prepared.leaseId })
      if (result.status === 'unknown' || result.code === 'LOGIN_RESULT_UNKNOWN') {
        uncertainManagedServices.add(serviceKey)
      }
      message(
        result.status === 'accepted'
          ? '插件已接受登录请求，请刷新状态核对。'
          : managedServiceMessage(result),
      )
    })
  } catch {
    uncertainManagedServices.add(serviceKey)
    message('登录结果不确定，请刷新状态核对；不要直接重试。')
  } finally {
    managedServiceLoginBusy = false
    await refreshManagedServices().catch(() => undefined)
  }
}

async function refreshManagedServices() {
  if (managedServiceLoginBusy) return
  const version = ++managedServiceRefreshVersion
  const target = element('managed-services')
  let result
  try {
    result = await api('/api/managed-services', { action: 'list' })
  } catch (error) {
    if (version !== managedServiceRefreshVersion || managedServiceLoginBusy) return
    throw error
  }
  if (version !== managedServiceRefreshVersion || managedServiceLoginBusy) return
  target.replaceChildren()
  if (result.status !== 'available' || !Array.isArray(result.services)) {
    target.append(node('p', '插件服务状态暂不可用。', 'muted'))
    return
  }
  if (!result.services.length) target.append(node('p', '当前后台没有已激活的插件服务。', 'muted'))
  const authStates = {
    authenticated: '已登录',
    authenticating: '登录中',
    missing: '未登录',
    expired: '登录已过期',
    failed: '登录失败',
    'logged-out': '已退出',
  }
  const readiness = {
    starting: '启动中',
    ready: '服务就绪',
    degraded: '服务异常',
    stopping: '停止中',
    stopped: '已停止',
    failed: '服务异常',
  }
  for (const item of result.services) {
    const serviceKey = `${item.pluginId}\u0000${item.serviceId}`
    const card = node('article', undefined, 'card row')
    const details = node('div')
    details.append(node('strong', `${item.pluginId} / ${item.serviceId}`))
    details.append(node(
      'p',
      item.status === 'available'
        ? `${authStates[item.authState] ?? '登录状态未知'} · ${readiness[item.readiness] ?? '服务状态未知'}`
        : '服务状态不可用',
      'muted',
    ))
    const actions = node('div', undefined, 'actions')
    if (uncertainManagedServices.has(serviceKey)) {
      details.append(node('p', '上次登录结果未知，请先核对服务状态。', 'muted'))
      actions.append(button('已核对状态', async () => {
        if (!confirm('确认已检查插件服务状态，并决定允许再次发起登录？')) return
        uncertainManagedServices.delete(serviceKey)
        await refreshManagedServices()
      }))
    }
    actions.append(button(
      '登录',
      () => loginManagedService(item),
      uncertainManagedServices.has(serviceKey)
        || item.status !== 'available' || item.explicitLogin !== true || item.canLogin !== true,
    ))
    card.append(details, actions)
    target.append(card)
  }
}

async function refresh(clearMessage = true) {
  if (clearMessage) message('')
  const revision = ++refreshVersion
  modelsLoading = true
  syncModelSaveAvailability()
  let fresh
  try {
    fresh = await api('/api/state')
  } catch (error) {
    if (revision !== refreshVersion) return
    snapshot = undefined
    modelsLoading = false
    element('add-model').disabled = true
    syncModelSaveAvailability()
    throw error
  }
  if (revision !== refreshVersion) return
  snapshot = fresh
  modelsLoading = false
  const mode = snapshot.management?.runtime?.kind !== 'active'
    ? '状态不可用'
    : snapshot.management.runtime.mode === 'service'
    ? '服务模式'
    : 'App 模式'
  element('owner').textContent = `Host：${snapshot.owner.appId} / ${snapshot.owner.profileId} · ${mode}`
  element('clients').replaceChildren(
    node(
      'p',
      'Codex Desktop、Claude Code 等客户端的连接状态暂不可用。现有 Host 没有客户端连接注册表，不能由进程状态推断。',
      'muted',
    ),
  )
  if (!modelDirty) renderModels(snapshot.services)
  else {
    element('add-model').disabled = snapshot.services?.status !== 'ok'
      || snapshot.services.managerSafeWrite !== 'cordisx.model-service-safe-write/v1'
    if (
      snapshot.services?.status === 'ok'
      && snapshot.services.managerSafeWrite !== 'cordisx.model-service-safe-write/v1'
    ) {
      message('当前 Host 尚未确认安全保存能力；草稿已保留，模型服务只读。')
    }
    syncModelSaveAvailability()
  }
  if (!pluginDrafts.size) renderPlugins(snapshot.management, snapshot.rendererPlugins)
  renderSources(snapshot.management)
  await refreshManagedServices().catch(() => {
    element('managed-services').replaceChildren(node('p', '插件服务状态暂不可用。', 'muted'))
  })
  await channelCredentials.refresh().catch(() => {
    element('channel-credentials-list').replaceChildren(node('p', 'Channel 连接状态暂不可用。', 'muted'))
  })
}
element('refresh').addEventListener('click', () => refresh().catch(() => message('连接失败，请重新打开管理台。')))
element('models').addEventListener('input', () => {
  modelDirty = true
})
element('models').addEventListener('change', () => {
  modelDirty = true
})
element('discard-models').addEventListener('click', () => {
  if (!modelDirty || confirm('放弃所有未保存的模型服务修改？')) {
    modelDirty = false
    modelResultUnknown = false
    void refresh().catch(() => message('连接失败，请重新打开管理台。'))
  }
})
element('add-model').addEventListener(
  'click',
  () => {
    modelDirty = true
    element('models').append(
      modelCard({
        id: '',
        displayName: '',
        baseUrl: '',
        protocols: ['openai-responses'],
        codexModels: [],
        claudeModels: [],
        enabled: true,
      }, true),
    )
  },
)
element('save-models').addEventListener('click', async event => {
  const control = event.currentTarget
  if (control.disabled || !canSaveModels()) return
  modelsSaving = true
  control.disabled = true
  try {
    await saveModels()
  } catch (error) {
    failure(error)
    if (error?.message === 'OPERATION_RESULT_UNKNOWN') modelResultUnknown = true
  } finally {
    modelsSaving = false
    syncModelSaveAvailability()
  }
})
element('add-source').addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(event.currentTarget)
  const name = String(data.get('name') ?? '').trim()
  void manage({
    kind: 'source-add',
    source: { url: String(data.get('url')), enabled: true, trusted: false, ...(name ? { local: { name } } : {}) },
  }).catch(failure)
})
element('market-search').addEventListener('submit', event => {
  event.preventDefault()
  const query = String(new FormData(event.currentTarget).get('query') ?? '')
  void searchCatalog(query).catch(() => message('无法搜索插件目录。'))
})
element('refresh-catalog').addEventListener('click', () => {
  void api('/api/catalog', { action: 'refresh' }).then(() => searchCatalog()).catch(() => message('无法刷新插件目录。'))
})
element('refresh-managed-services').addEventListener('click', () => {
  void refreshManagedServices().catch(() => message('插件服务状态暂不可用。'))
})
element('refresh-channel-credentials').addEventListener('click', () => {
  void channelCredentials.userRefresh().catch(() => message('Channel 连接状态暂不可用。'))
})
refresh().catch(() => message('无法连接管理后台。请确认入口来自当前的 CordisX 进程。'))
