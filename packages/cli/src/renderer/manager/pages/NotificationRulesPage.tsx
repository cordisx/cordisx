import { EmptyState } from '../../host-ui/EmptyState.js'
import { managerCopy } from '../../ui-copy.js'
import { useSyncExternalStore } from 'react'
import { Button } from 'tdesign-react'
import type { NotificationCenter } from '../../notifications/model.js'

export function NotificationRulesPage({ center, locale }: { center: NotificationCenter; locale: string }) {
  useSyncExternalStore(center.subscribe, center.snapshot, center.snapshot)
  const zh = locale.startsWith('zh')
  const rules = center.getRules()
  const t = (cn: string, en: string) => zh ? cn : en
  return (
    <section
      className={`cxr-page cxr-notification-rules${rules.length === 0 ? ' cxr-empty-page' : ''}`}
      data-notification-rules-page="true"
    >
      {center.persistenceError
        ? (
          <div className="cxr-notice" role="alert">
            {t('规则仅在当前窗口生效，暂时无法保存。', 'Rules apply in this window only; saving is unavailable.')}
          </div>
        )
        : null}
      {rules.length === 0
        ? (
          <EmptyState
            family="notification-rules"
            icon="settings"
            title={managerCopy(locale, 'empty.notifications')}
            description={managerCopy(locale, 'empty.notificationsHelp')}
          />
        )
        : (
          <div className="cxr-notification-rule-list">
            {rules.map(rule => (
              <div className="cxr-notification-rule" key={rule.id}>
                <div>
                  <strong>{rule.name}</strong>
                  <p>{rule.kind ?? t('所有通知', 'All notifications')}</p>
                  <small>
                    {rule.expiresAt
                      ? new Date(rule.expiresAt).toLocaleString()
                      : t('持续屏蔽', 'Muted until restored')}
                  </small>
                </div>
                <Button variant="outline" onClick={() => center.removeRule(rule.id)}>
                  {t('恢复通知', 'Restore notifications')}
                </Button>
              </div>
            ))}
          </div>
        )}
    </section>
  )
}
