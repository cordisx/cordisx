/** Feishu/Lark credentials are captured by the Host and never read back. */
export function createChannelCredentialsUI(
  { api, element, node, button, input, label, message, freeze, confirmAction },
) {
  let view
  let editing = false
  let busy = false
  let uncertain = false
  let captured
  let refreshVersion = 0

  const target = () => element('channel-credentials-list')
  const lockUncertain = () => {
    if (uncertain) { for (const control of target().querySelectorAll('button')) control.disabled = true }
  }
  const describe = result => {
    const codes = {
      PERMISSION_DENIED: 'Host 权限不允许修改此连接。',
      REVISION_CONFLICT: '连接配置已变化，请刷新后重新填写。',
      STALE_GENERATION: 'Channel 服务已更换，请刷新后重新填写。',
      TARGET_UNAVAILABLE: '目标连接已变化，请刷新后重新选择。',
      INVALID_APP_ID: 'App ID 格式不正确。',
      CREDENTIAL_VALIDATION_FAILED: '凭据验证失败，请检查 App ID、密钥和网络。',
      CREDENTIAL_VALIDATION_TIMEOUT: '凭据验证超时，请检查网络后重新填写。',
      TENANT_DISCOVERY_PERMISSION_DENIED: '应用没有查询租户信息的权限，可手动填写 Tenant ID。',
      TENANT_DISCOVERY_FAILED: '无法查询租户信息，可手动填写 Tenant ID。',
      TENANT_MISMATCH: '填写的租户 ID 与应用所属企业不一致，请核对 tenant_key，或留空以自动查询。',
      CREDENTIAL_UNAVAILABLE: '凭据暂存不可用。',
      CREDENTIAL_CLEANUP_UNAVAILABLE: '无法确认临时凭据已清理，请检查 Host 状态。',
      DRAFT_RECOVERY_UNAVAILABLE: '历史临时凭据尚未完成核对或清理；请检查 Host 状态。',
      DRAFT_JOURNAL_UNAVAILABLE: '无法安全记录临时凭据，操作未执行。',
      CHANNEL_OWNER_UNAVAILABLE: 'Channel 插件未运行，或其归属暂不可验证。',
      CHANNEL_UNAVAILABLE: 'Channel 服务当前不可用。',
      SESSION_CAPACITY: '凭据会话安全容量已满，请稍后重新查看。',
      SESSION_RETIRED: '管理会话已失效，请重新打开管理台。',
      DRAFT_LIMIT: '待保存的凭据过多，请稍后重试。',
    }
    return codes[result?.code] ?? '操作未完成，请检查连接与权限后重试。'
  }

  async function submitDiscard() {
    if (!captured) return true
    try {
      const result = await api('/api/channel-credentials', { action: 'discard', draftId: captured.draftId })
      if (result.status === 'unknown') {
        uncertain = true
        message('临时凭据的处理结果不确定，请刷新并核对后再操作。')
        return false
      }
      if (result.status !== 'applied') {
        message(describe(result))
        return false
      }
      captured = undefined
      return true
    } catch {
      uncertain = true
      message('临时凭据的处理结果不确定，请刷新并核对后再操作。')
      return false
    }
  }

  function edit(existing) {
    if (editing || busy || !view?.writable) return
    editing = true
    const form = node('div', undefined, 'detail')
    const fields = node('div', undefined, 'fields')
    const adapter = node('select')
    for (const [value, title] of [['feishu', '飞书'], ['lark', 'Lark']]) {
      const option = node('option', title)
      option.value = value
      adapter.append(option)
    }
    const accountId = input(existing?.accountId ?? '')
    const tenantId = input(existing?.tenantId ?? '')
    const displayName = input(existing?.displayName ?? '')
    const secret = input('', 'password')
    secret.autocomplete = 'new-password'
    if (existing) {
      adapter.value = existing.adapterId
      adapter.disabled = true
      accountId.disabled = true
      tenantId.disabled = true
      displayName.disabled = true
    }
    fields.append(
      label('服务', adapter),
      label('App ID', accountId),
      label('Tenant ID（可留空）', tenantId),
      label('连接名称', displayName),
      label('App Secret', secret),
    )
    form.append(fields, node('p', '密钥只写入 Host，验证后不会回显。', 'muted'))
    const actions = node('div', undefined, 'actions')
    const cancel = button('取消', async () => {
      if (busy || uncertain) return message('请先刷新并核对连接状态。')
      if (captured && !confirmAction('放弃已暂存的凭据？')) return
      busy = true
      let discarded
      try {
        discarded = await freeze(element('channel-credentials'), submitDiscard)
      } finally {
        busy = false
        lockUncertain()
      }
      if (!discarded) {
        if (uncertain) {
          cancel.dataset.locked = 'true'
          cancel.disabled = true
        }
        return
      }
      secret.value = ''
      editing = false
      await refresh(true)
    })
    const verify = button('验证并暂存', async () => {
      if (busy || uncertain) return message('请先刷新并核对连接状态。')
      const account = { adapterId: adapter.value, accountId: accountId.value.trim(), tenantId: tenantId.value.trim() }
      if (!account.accountId || !secret.value.trim() || (!existing && !displayName.value.trim())) {
        return message('请填写 App ID、连接名称和 App Secret。')
      }
      if (!/^cli_[A-Za-z0-9_]{1,256}$/u.test(account.accountId)) return message('App ID 格式不正确。')
      if (displayName.value.trim().length > 240) return message('连接名称不能超过 240 个字符。')
      if (
        account.tenantId.length > 512 || /[\u0000-\u001f\u007f]/u.test(account.tenantId)
        || secret.value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(secret.value)
      ) {
        return message('租户或密钥格式不正确。')
      }
      busy = true
      message('正在验证凭据，请稍候。')
      try {
        await freeze(element('channel-credentials'), async () => {
          let result
          try {
            result = await api('/api/channel-credentials', {
              action: 'capture',
              purpose: existing ? 'rotate' : 'create',
              expectedRevision: view.revision,
              serviceGeneration: view.serviceGeneration,
              account,
              secret: secret.value,
            })
          } finally {
            secret.value = ''
          }
          if (result.status === 'unknown') {
            uncertain = true
            verify.dataset.locked = 'true'
            return message('凭据验证结果不确定，请先刷新并核对连接状态，不要直接重试。')
          }
          if (result.status !== 'applied' || result.code !== 'CAPTURED' || typeof result.draftId !== 'string') {
            return message(describe(result))
          }
          captured = {
            draftId: result.draftId,
            purpose: existing ? 'rotate' : 'create',
            ref: result.ref,
            displayName: displayName.value.trim(),
          }
          form.replaceChildren(node(
            'p',
            captured.ref?.tenantId
              ? `已验证，租户：${captured.ref.tenantId}`
              : '已验证；租户尚未确认，保存后连接将处于待处理状态。',
          ))
          const next = node('div', undefined, 'actions')
          const commit = button('确认保存', async () => {
            if (busy || uncertain || !captured || !confirmAction('确认保存这份飞书/Lark 凭据？')) return
            busy = true
            try {
              await freeze(element('channel-credentials'), async () => {
                const outcome = await api('/api/channel-credentials', {
                  action: 'commit',
                  draftId: captured.draftId,
                  ...(captured.purpose === 'create' ? { draft: { displayName: captured.displayName } } : {}),
                })
                if (outcome.status === 'unknown') {
                  uncertain = true
                  commit.dataset.locked = 'true'
                  return message('保存结果不确定，请先刷新并核对连接状态，不要直接重试。')
                }
                if (outcome.status !== 'applied') {
                  commit.dataset.locked = 'true'
                  return message(describe(outcome))
                }
                const pending = !captured.ref?.tenantId
                captured = undefined
                editing = false
                message(pending ? '凭据已保存；租户尚待确认。' : '凭据已保存，请查看连接状态。')
              })
            } catch {
              uncertain = true
              commit.dataset.locked = 'true'
              message('保存结果不确定，请先刷新并核对连接状态，不要直接重试。')
            } finally {
              busy = false
              lockUncertain()
            }
            if (!editing) await refresh(true)
          })
          next.append(cancel, commit)
          form.append(next)
          message('凭据已暂存；请核对后确认保存。')
        })
      } catch {
        uncertain = true
        verify.dataset.locked = 'true'
        message('凭据验证结果不确定，请先刷新并核对连接状态，不要直接重试。')
      } finally {
        busy = false
        lockUncertain()
      }
    })
    actions.append(cancel, verify)
    form.append(actions)
    target().append(form)
  }

  function resolveTenant(item) {
    if (editing || busy || !view?.writable) return
    editing = true
    const form = node('div', undefined, 'detail')
    const tenant = input('')
    form.append(label('Tenant ID（留空由 Host 查询）', tenant))
    const actions = node('div', undefined, 'actions')
    actions.append(button('取消', async () => {
      if (busy || uncertain) return message('请先刷新并核对连接状态。')
      editing = false
      await refresh(true)
    }))
    const apply = button('确认租户', async () => {
      if (busy || uncertain) return
      if (tenant.value.trim().length > 512 || /[\u0000-\u001f\u007f]/u.test(tenant.value)) {
        return message('租户格式不正确。')
      }
      if (!confirmAction('确认完成此连接的租户设置？')) return
      busy = true
      message('正在确认租户，请稍候。')
      try {
        await freeze(element('channel-credentials'), async () => {
          const result = await api('/api/channel-credentials', {
            action: 'resolve-tenant',
            expectedRevision: view.revision,
            serviceGeneration: view.serviceGeneration,
            account: { adapterId: item.account.adapterId, accountId: item.account.accountId, tenantId: '' },
            ...(tenant.value.trim() ? { tenantId: tenant.value.trim() } : {}),
          })
          if (result.status === 'unknown') {
            uncertain = true
            apply.dataset.locked = 'true'
            return message('租户设置结果不确定，请先刷新并核对连接状态，不要直接重试。')
          }
          if (result.status !== 'applied') {
            apply.dataset.locked = 'true'
            return message(describe(result))
          }
          editing = false
          message('租户已确认，请查看连接状态。')
        })
      } catch {
        uncertain = true
        apply.dataset.locked = 'true'
        message('租户设置结果不确定，请先刷新并核对连接状态，不要直接重试。')
      } finally {
        busy = false
        lockUncertain()
      }
      if (!editing) await refresh(true)
    })
    actions.append(apply)
    form.append(actions)
    target().append(form)
  }

  async function setEnabled(item, control) {
    if (uncertain) return message('请先刷新并核对连接状态。')
    if (busy || editing || !view?.writable) return message('请先保存或放弃当前修改。')
    busy = true
    message('正在更新连接，请稍候。')
    try {
      await freeze(element('channel-credentials'), async () => {
        const result = await api('/api/channel-credentials', {
          action: 'set-enabled',
          account: item.ref,
          enabled: !item.enabled,
          expectedRevision: view.revision,
          serviceGeneration: view.serviceGeneration,
        })
        if (result.status === 'unknown') {
          uncertain = true
          return message('连接变更结果不确定，请先刷新并核对状态，不要直接重试。')
        }
        if (result.status !== 'applied') return message(describe(result))
        message(item.enabled ? '连接已停用，请查看状态。' : '连接已启用，请查看状态。')
      })
    } catch {
      uncertain = true
      message('连接变更结果不确定，请先刷新并核对状态，不要直接重试。')
    } finally {
      busy = false
      if (uncertain) control.dataset.locked = 'true'
      lockUncertain()
    }
    if (!uncertain) await refresh(true)
  }

  function render(result) {
    target().replaceChildren()
    if (result.status !== 'available') {
      target().append(
        node('p', result.code ? describe(result) : '当前 Host 未提供可验证的飞书/Lark Channel 配置。', 'muted'),
      )
      return
    }
    view = result
    const supported = account => account && ['feishu', 'lark'].includes(account.adapterId)
    const connections = Array.isArray(result.connections) ? result.connections.filter(item => supported(item.ref)) : []
    const pending = Array.isArray(result.pendingConnections)
      ? result.pendingConnections.filter(item => supported(item.account))
      : []
    const connectionStates = {
      disabled: '已停用',
      starting: '启动中',
      ready: '已连接',
      retrying: '重试中',
      unavailable: '状态不可用',
      stopped: '已停止',
    }
    const secretStates = {
      ready: '密钥可用',
      missing: '缺少密钥',
      unavailable: '密钥状态不可用',
      unknown: '密钥状态未知',
    }
    if (!connections.length && !pending.length) target().append(node('p', '尚未配置飞书/Lark 连接。', 'muted'))
    for (const item of connections) {
      const card = node('article', undefined, 'card row')
      const text = node('div')
      text.append(
        node('strong', item.displayName || item.ref.accountId),
        node(
          'p',
          `${item.ref.adapterId} · ${item.ref.accountId} · 配置${item.enabled ? '已启用' : '已停用'} · ${
            connectionStates[item.connectionState] ?? '状态不可用'
          } · ${secretStates[item.secretState] ?? '密钥状态未知'}`,
          'muted',
        ),
      )
      const toggle = button(item.enabled ? '停用连接' : '启用连接', () => setEnabled(item, toggle), !result.writable)
      card.append(
        text,
        toggle,
        button('更换密钥', () => edit({ ...item.ref, displayName: item.displayName }), !result.writable),
      )
      target().append(card)
    }
    for (const item of pending) {
      const card = node('article', undefined, 'card row')
      const text = node('div')
      text.append(
        node('strong', item.displayName || item.account.accountId),
        node('p', `${item.account.adapterId} · ${item.account.accountId} · 租户待确认`, 'muted'),
      )
      card.append(
        text,
        button('确认租户', () => resolveTenant(item), !result.writable),
        button(
          '更换密钥',
          () => edit({ ...item.account, tenantId: '', displayName: item.displayName }),
          !result.writable,
        ),
      )
      target().append(card)
    }
    target().append(button('添加飞书/Lark 连接', () => edit(), !result.writable))
  }

  async function refresh(force = false) {
    if (busy || (!force && (editing || uncertain))) return
    const version = ++refreshVersion
    let result
    try {
      result = await api('/api/channel-credentials', { action: 'view' })
    } catch (error) {
      if (version !== refreshVersion || busy || editing || uncertain) return
      throw error
    }
    if (version !== refreshVersion || busy || editing || uncertain) return
    render(result)
  }

  async function userRefresh() {
    if (busy) return
    if (
      (editing || uncertain) && !confirmAction(
        editing ? '核对后刷新？未保存的表单将被放弃。' : '确认已核对连接状态并刷新？',
      )
    ) return
    if (!uncertain) {
      busy = true
      let discarded
      try {
        discarded = await freeze(element('channel-credentials'), submitDiscard)
      } finally {
        busy = false
      }
      if (!discarded) return
    }
    captured = undefined
    editing = false
    uncertain = false
    await refresh(true)
  }

  return { refresh, userRefresh }
}
