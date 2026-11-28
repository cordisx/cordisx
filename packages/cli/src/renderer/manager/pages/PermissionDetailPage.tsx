import { EmptyState } from '../../host-ui/EmptyState.js'
import { useCallback, useRef, useState } from 'react'
import { managerCopy, productLocale } from '../../ui-copy.js'
import { Button, Select } from 'tdesign-react'
import type { CordisXPermissionPolicy } from '../../../contracts.js'
import type { ManagerModel, ManagerPermissionSnapshot, ManagerSnapshot } from '../../manager.js'
import type { ManagerRouter } from '../model/routes.js'
import { registerStandaloneDomResetButton } from '../../standalone-dom-reset-button.js'
import { PermissionDecisionHistory } from './PermissionDecisionHistory.js'

const policyOptions = [{ label: '每次询问', value: 'ask' }, { label: '始终允许', value: 'allow' }, {
  label: '始终拒绝',
  value: 'deny',
}]

function StandaloneDomPermissionReview({ model, permission, locale, onReviewed }: {
  readonly model: ManagerModel
  readonly permission: ManagerPermissionSnapshot
  readonly locale: string
  readonly onReviewed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [resetFailed, setResetFailed] = useState(false)
  const points = permission.scope.extensionPoints
  const pointId = permission.capability === 'ui.extension-points.render' && points?.length === 1
    ? points[0]
    : undefined
  const review = model.standaloneDomReview
  const unbindReset = useRef<(() => void) | undefined>(undefined)
  const resetRef = useCallback((element: HTMLElement | null) => {
    unbindReset.current?.()
    unbindReset.current = undefined
    if (element && pointId) {
      unbindReset.current = registerStandaloneDomResetButton(element, permission.identity, pointId, review?.native)
    }
  }, [permission.identity.id, permission.identity.source, pointId, review?.native])
  const artifact = pointId === undefined ? undefined : review?.describe(permission.identity, pointId)
  if (pointId === undefined || review === undefined || artifact === undefined) return null
  const chinese = productLocale(locale) === 'zh-CN'
  return (
    <section
      className="cxr-section"
      data-standalone-dom-review={artifact.policy === 'inherit' ? pointId : undefined}
      data-standalone-dom-policy={artifact.policy === 'inherit' ? undefined : pointId}
    >
      <h3>
        {artifact.persistentAvailable
          ? chinese ? '页面授权' : 'Page access'
          : chinese
          ? review.native ? '当前客户端的页面授权' : '当前标签页的页面授权'
          : review.native
          ? 'Page access in this client'
          : 'Page access in this tab'}
      </h3>
      <p>
        {artifact.persistentAvailable
          ? chinese
            ? '可以选择单次允许，或持续授权并同步到其他客户端。'
            : 'Allow once or save a decision shared with other clients.'
          : chinese
          ? review.native
            ? '仅对此客户端有效；刷新或与服务失联后需要重新审核。'
            : '仅对此标签页有效；刷新或与后台失联后需要重新审核。'
          : review.native
          ? 'Only this client is covered; review again after refresh or disconnection.'
          : 'Only this tab is covered; review again after refresh or disconnection.'}
      </p>
      <p>
        {chinese ? '版本' : 'Version'}: <code>{artifact.version}</code>
      </p>
      <p>
        {chinese ? '制品摘要' : 'Artifact digest'}: <code>{artifact.integrity}</code>
      </p>
      {artifact.policy !== 'inherit'
        ? (
          <>
            <p role="status">
              {artifact.policy === 'allow'
                ? chinese ? '已持续允许。' : 'Always allowed.'
                : chinese
                ? '已持续拒绝。'
                : 'Always denied.'}
            </p>
            {artifact.resetAvailable
              ? (
                <Button
                  ref={resetRef}
                  tag="button"
                  type="button"
                  theme="default"
                  variant="outline"
                  disabled={busy}
                  data-standalone-dom-reset={pointId}
                  onClick={event => {
                    if (!event.nativeEvent.isTrusted || busy) return
                    setBusy(true)
                    setResetFailed(false)
                    void review.reset(permission.identity, pointId, event.nativeEvent).then(
                      reset => setResetFailed(!reset),
                      () => setResetFailed(true),
                    ).finally(() => {
                      setBusy(false)
                      onReviewed()
                    })
                  }}
                >
                  {chinese ? '恢复每次询问' : 'Ask each time'}
                </Button>
              )
              : null}
            {resetFailed ? <p role="status">{chinese ? '权限未能更新。' : 'Access was not updated.'}</p> : null}
          </>
        )
        : artifact.authorized
        ? (
          <p role="status">
            {chinese
              ? review.native ? '已在此客户端允许。' : '已在此标签页允许。'
              : review.native
              ? 'Allowed in this client.'
              : 'Allowed in this tab.'}
          </p>
        )
        : (
          <>
            <Button
              tag="button"
              type="button"
              theme="default"
              variant="outline"
              disabled={busy}
              onClick={event => {
                if (!event.nativeEvent.isTrusted || busy) return
                setBusy(true)
                setDeclined(false)
                void review.request(permission.identity, pointId).then(
                  allowed => setDeclined(!allowed),
                  () => setDeclined(true),
                ).finally(() => {
                  setBusy(false)
                  onReviewed()
                })
              }}
            >
              {artifact.persistentAvailable
                ? chinese ? '审核页面权限' : 'Review page access'
                : chinese
                ? '审核此标签页权限'
                : 'Review access for this tab'}
            </Button>
            {declined ? <p role="status">{chinese ? '本次未允许。' : 'Access was not allowed.'}</p> : null}
          </>
        )}
    </section>
  )
}

export function PermissionDetailPage(
  { model, snapshot, router }: {
    readonly model: ManagerModel
    readonly snapshot: ManagerSnapshot
    readonly router: ManagerRouter
  },
) {
  const [historyRevision, setHistoryRevision] = useState(0)
  const route = router.route
  if (route.kind !== 'permission') return null
  const permission = snapshot.permissions.find(item =>
    item.identity.id === route.pluginId && item.capability === route.capability
    && item.fingerprint === route.fingerprint
  )
  if (permission === undefined) {
    return <EmptyState icon="permissions" family="plugins" presentation="compact" title={'权限记录已不存在'} />
  }
  const certifiedAutomatic = permission.authorizationOrigin === 'certified-implicit' && permission.policy === 'ask'
  const ownService = permission.authorizationOrigin === 'service-owner'
  const point = permission.capability === 'ui.extension-points.render' && permission.scope.extensionPoints?.length === 1
    ? permission.scope.extensionPoints[0]
    : undefined
  const reviewedHere = point !== undefined
    && model.standaloneDomReview?.describe(permission.identity, point) !== undefined
  return (
    <section className="cxr-page cxr-grid">
      <StandaloneDomPermissionReview
        model={model}
        permission={permission}
        locale={snapshot.localization.locale}
        onReviewed={() => setHistoryRevision(value => value + 1)}
      />
      <section className="cxr-section">
        <h3>授权策略</h3>
        <p>{permission.reasonText}</p>
        {ownService ? <p>{managerCopy(snapshot.localization.locale, 'permission.service-owner-reason')}</p> : (
          <>
            <Select
              value={permission.policy}
              disabled={model.permissionPolicyWritable === false}
              options={permission.authorizationOrigin === 'local-development' || certifiedAutomatic
                ? policyOptions.map(option =>
                  option.value === (certifiedAutomatic ? 'ask' : 'allow')
                    ? {
                      ...option,
                      label: managerCopy(
                        snapshot.localization.locale,
                        certifiedAutomatic
                          ? 'permission.certified-automatic-authorization'
                          : 'permission.development-authorized',
                      ),
                    }
                    : option
                )
                : policyOptions}
              onChange={value =>
                void model.setPermissionPolicy(
                  route.pluginId,
                  route.capability,
                  value as CordisXPermissionPolicy,
                  permission.scope,
                )}
            />
            {model.permissionPolicyWritable === false
              ? (
                <p role="status">
                  {reviewedHere
                    ? (productLocale(snapshot.localization.locale) === 'zh-CN'
                      ? '请使用上方的页面授权控制设置此权限。'
                      : 'Use the page access control above to change this permission.')
                    : managerCopy(
                      snapshot.localization.locale,
                      model.permissionReviewInWeb ? 'permission.read-only-web' : 'permission.read-only',
                    )}
                </p>
              )
              : null}
          </>
        )}
      </section>
      <section className="cxr-section">
        <h3>能力可用性</h3>
        <p>{permission.availability.status}</p>
        <p>{permission.availability.reasonText}</p>
      </section>
      <section className="cxr-section">
        <h3>使用范围</h3>
        <pre className="cxr-code">{JSON.stringify(permission.scope, null, 2)}</pre>
      </section>
      <PermissionDecisionHistory
        permission={permission}
        locale={snapshot.localization.locale}
        model={model}
        refreshKey={historyRevision}
      />
      {permission.authorizationOrigin === undefined
        ? null
        : (
          <section className="cxr-section" data-permission-authorization-origin={permission.authorizationOrigin}>
            <h3>
              {permission.authorizationOrigin === 'certified-implicit' ? '认证自动批准的 DOM 权限' : '最近授权来源'}
            </h3>
            <p>
              {ownService
                ? managerCopy(snapshot.localization.locale, 'permission.service-owner-reason')
                : permission.authorizationOrigin === 'local-development'
                ? managerCopy(snapshot.localization.locale, 'permission.development-reason')
                : permission.authorizationReason ?? (permission.authorizationOrigin === 'certified-implicit'
                  ? 'Host 根据精确制品认证投影自动批准。'
                  : '由用户显式确认。')}
            </p>
            {permission.certification === undefined ? null : (
              <dl className="cxr-facts">
                <div>
                  <dt>制品</dt>
                  <dd>
                    <code>{permission.certification.pluginId}@{permission.certification.version}</code>
                  </dd>
                </div>
                <div>
                  <dt>完整性</dt>
                  <dd>
                    <code>{permission.certification.integrity}</code>
                  </dd>
                </div>
                <div>
                  <dt>审核策略</dt>
                  <dd>
                    <code>
                      {permission.certification.reviewPolicy.id}@{permission.certification.reviewPolicy.version}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>证据</dt>
                  <dd>
                    <a href={permission.certification.evidence.reference} target="_blank" rel="noopener noreferrer">
                      {permission.certification.evidence.reference}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>
                    <code>{permission.certification.revision}</code>
                  </dd>
                </div>
                <div>
                  <dt>Fingerprint</dt>
                  <dd>
                    <code>{permission.certification.fingerprint}</code>
                  </dd>
                </div>
              </dl>
            )}
          </section>
        )}
      <section className="cxr-section cxr-item-full">
        <h3>提供方</h3>
        {permission.availability.providers.map(provider => (
          <p key={provider.providerId}>{provider.providerNameText} · {provider.kind} · {provider.status}</p>
        ))}
        {permission.availability.providers.length === 0 ? <p>Host 当前未发布提供方。</p> : null}
      </section>
    </section>
  )
}
