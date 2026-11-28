import { useRef, useState } from 'react'
import { Button } from 'tdesign-react'
import type { CordisXPermissionCapabilityV2, CordisXPermissionPolicyV2 } from '../../../permission-contracts.js'
import type { ManagerModel, ManagerPermissionSnapshot } from '../../manager.js'
import { registerStandaloneRuntimePolicyButton } from '../../standalone-runtime-policy-review.js'
import { productLocale } from '../../ui-copy.js'

/** Settings always go through the owner-backed, user-originated review path. */
export function RuntimePolicyReview({ model, permission, locale, onUpdated }: {
  readonly model: ManagerModel
  readonly permission: ManagerPermissionSnapshot
  readonly locale: string
  readonly onUpdated: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const unbind = useRef<Partial<Record<CordisXPermissionPolicyV2, () => void>>>({})
  const review = model.standaloneRuntimeReview
  const current = review?.describe(permission.identity, permission.capability, permission.fingerprint)
  if (!review || !current) return null
  const chinese = productLocale(locale) === 'zh-CN'
  const labels = {
    ask: chinese ? '每次询问' : 'Ask each time',
    'allow-persistent': chinese ? '始终允许' : 'Always allow',
    'deny-persistent': chinese ? '始终拒绝' : 'Always deny',
  }
  return (
    <>
      <p role="status">
        {chinese ? '核心服务当前策略' : 'Current service policy'}: {labels[current.policy]}
      </p>
      {current.options.map(policy => (
        <Button
          key={policy}
          ref={element => {
            unbind.current[policy]?.()
            delete unbind.current[policy]
            if (element) {
              unbind.current[policy] = registerStandaloneRuntimePolicyButton(
                element,
                permission.identity,
                permission.capability as CordisXPermissionCapabilityV2,
                permission.fingerprint,
                policy,
                review.native,
              )
            }
          }}
          tag="button"
          type="button"
          theme="default"
          variant="outline"
          disabled={busy || current.policy === policy}
          onClick={event => {
            if (!event.nativeEvent.isTrusted || busy) return
            setBusy(true)
            setFailed(false)
            void review.set(
              permission.identity,
              permission.capability,
              permission.fingerprint,
              policy,
              event.nativeEvent,
            )
              .then(updated => setFailed(!updated), () => setFailed(true))
              .finally(() => {
                setBusy(false)
                onUpdated()
              })
          }}
        >
          {labels[policy]}
        </Button>
      ))}
      {failed ? <p role="status">{chinese ? '权限未能更新。' : 'Access was not updated.'}</p> : null}
    </>
  )
}
