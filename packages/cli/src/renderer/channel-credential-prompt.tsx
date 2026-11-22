import {
  channelCredentialFailure,
  channelCredentialFields,
  validateChannelCredentialValues,
} from './channel-credential-fields.js'
import { createRoot } from 'react-dom/client'
import { dialogCenterForDocument } from './dialogs/host.js'
import { HostDraftFields } from './host-ui/HostDraftFields.js'
import { HOST_FORM_REACT_STYLES } from './host-ui/HostForm.js'
import { HOST_TDESIGN_REACT_STYLES } from './host-ui/tdesign-styles.js'
import { ConfigProvider } from 'tdesign-react'
import type { ChannelCredentialRef } from '../launcher/channel-credential-drafts.js'

/** Only the Host owns these transient inputs. Plugins receive no fields or credential values. */
export async function captureChannelCredential(input: {
  readonly document: Document
  readonly owner: string
  readonly adapterKind: 'feishu' | 'lark'
  readonly account?: ChannelCredentialRef
  readonly signal: AbortSignal
  readonly submit: (
    account: ChannelCredentialRef,
    secret: string,
    signal: AbortSignal,
    reportFailure?: (code: string) => void,
  ) => Promise<boolean>
}): Promise<boolean> {
  const center = dialogCenterForDocument(input.document)
  if (center === undefined || input.signal.aborted) return false
  const zh = input.document.documentElement.lang.startsWith('zh')
  const values = { appId: input.account?.accountId ?? '', tenantId: input.account?.tenantId ?? '', secret: '' }
  let submitted = false
  const binding = center.bind({
    key: `host/channel-credential/${input.owner}`,
    name: () => 'CordisX',
    active: () => !input.signal.aborted,
    report: () => {},
  })
  const handle = binding.openBody({
    kind: 'channel.credential.capture',
    title: zh
      ? (input.account ? '更换飞书应用凭据' : '配置应用凭据')
      : (input.account ? 'Replace application credentials' : 'Configure application credentials'),
    description: zh
      ? '填写应用的 App ID 和 App Secret（App Key），密钥由 Host 私密保存：macOS 使用钥匙串，Linux 使用本机加密文件。'
      : 'Enter the application App ID and App Secret (App Key). The Host stores it privately in macOS Keychain or encrypted local files on Linux.',
    closeOnBackdrop: false,
  }, ({ container, dialog }) => {
    container.classList.add('cxh-tdesign-root')
    const styles = input.document.createElement('style')
    styles.textContent = HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES
    const seat = input.document.createElement('div')
    container.append(styles, seat)
    const root = createRoot(seat)
    const errors = new Map<string, string>()
    const definitions = channelCredentialFields({
      ...(input.account === undefined ? {} : { account: input.account }),
      values,
      zh,
      change: (id, value) => {
        values[id] = value
        errors.delete(`channel-${id}`)
        render()
      },
    })
    const render = () =>
      root.render(
        <ConfigProvider globalConfig={{ attach: () => container }}>
          <HostDraftFields definitions={definitions} locale={zh ? 'zh-CN' : 'en'} errors={errors} />
        </ConfigProvider>,
      )
    dialog.update({
      title: zh ? '配置应用凭据' : 'Configure application credentials',
      closeOnBackdrop: false,
      footer: {
        secondaryActions: [{
          id: 'cancel',
          label: zh ? '取消' : 'Cancel',
          onAction: async () => {
            await dialog.close('cancel')
          },
        }],
        primaryAction: {
          id: 'capture',
          label: zh ? '继续' : 'Continue',
          onAction: async signal => {
            errors.clear()
            for (const [id, message] of validateChannelCredentialValues(values, zh)) errors.set(id, message)
            render()
            if (errors.size) return
            let failureCode: string | undefined
            const accepted = await input.submit(
              { adapterId: input.adapterKind, accountId: values.appId, tenantId: values.tenantId },
              values.secret,
              signal,
              code => {
                failureCode = code
              },
            )
            if (!accepted || signal.aborted || input.signal.aborted) {
              const failure = channelCredentialFailure(failureCode, zh)
              errors.set(failure.id, failure.message)
              render()
              return
            }
            submitted = true
            values.secret = ''
            await dialog.close('programmatic')
          },
        },
      },
    })
    render()
    return () => {
      values.secret = ''
      root.unmount()
      seat.remove()
      styles.remove()
    }
  })
  const abort = () => binding.dispose()
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    await handle.result
    return submitted && !input.signal.aborted
  } finally {
    input.signal.removeEventListener('abort', abort)
    values.secret = ''
    binding.dispose()
  }
}
