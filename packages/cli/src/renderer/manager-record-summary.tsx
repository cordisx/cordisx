import { cloneAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import { cloneBrandIconV1 } from '@cordisx/protocol/brand-icon/v1'
import type { ManagerContentRecordSummaryV6 } from '@cordisx/protocol/manager-content-navigation/v6'
import type { ManagerContentPresentation } from './manager-content-navigation.js'
import { assertManagerCollectionVisual } from './manager-collection-visual.js'
import { assertLocalId, assertLocalizedText } from './validation.js'
import { AccountIdentityVisual } from './host-ui/AccountIdentityVisual.js'
import { HostAgentAvatar } from './host-ui/avatar/AgentAvatar.js'
import { HostBrandIcon } from './host-ui/HostBrandIcon.js'
import { CORDISX_HOST_ICON_TOKENS } from './surfaces.js'

function keys(value: object, allowed: readonly string[]): void {
  if (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
  ) {
    throw new Error('manager content record summary has unknown fields')
  }
}

/** Fixed read-only Host chrome, with exact version-gated validation. */
export function assertManagerRecordSummary(summary: ManagerContentRecordSummaryV6, version: number): void {
  keys(
    summary,
    version >= 6
      ? ['leadingVisual', 'title', 'description', 'statuses', 'metrics']
      : ['leadingVisual', 'title', 'description'],
  )
  const visual = summary.leadingVisual
  if (visual.kind === 'identity' && version >= 6) {
    assertManagerCollectionVisual(visual, 'manager record identity', 2)
  } else if (visual.kind === 'agent-avatar') {
    keys(visual, ['kind', 'avatar'])
    cloneAgentAvatarRef(visual.avatar)
  } else throw new Error('manager content record summary leading visual kind is invalid')
  for (const [id, text] of [['title', summary.title], ['description', summary.description]] as const) {
    if (text === undefined && id === 'description') continue
    assertLocalizedText(text, `manager content record summary ${id}`)
    if (!text || typeof text.fallback !== 'string' || text.fallback.trim() === '') {
      throw new Error(`manager content record summary ${id} fallback is invalid`)
    }
  }
  for (const [kind, list, limit] of [['statuses', summary.statuses, 4], ['metrics', summary.metrics, 8]] as const) {
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > limit) throw new Error('manager record summary list is invalid')
    const ids = new Set<string>()
    for (const item of list) {
      keys(item, kind === 'metrics' ? ['id', 'label', 'icon', 'tone', 'value'] : ['id', 'label', 'icon', 'tone'])
      assertLocalId(item.id, 'manager record summary item id')
      if (ids.has(item.id)) throw new Error('manager record summary item id is duplicated')
      ids.add(item.id)
      assertLocalizedText(item.label, 'manager record summary item label')
      if (typeof item.label.fallback !== 'string' || !item.label.fallback.trim()) {
        throw new Error('manager record summary item fallback is invalid')
      }
      const icon = cloneBrandIconV1(item.icon)
      if (typeof icon === 'string' && !(CORDISX_HOST_ICON_TOKENS as readonly string[]).includes(icon)) {
        throw new Error('manager record summary icon is unavailable')
      }
      if (!['neutral', 'info', 'success', 'warning', 'danger'].includes(item.tone)) {
        throw new Error('manager record summary tone is invalid')
      }
      if (
        kind === 'metrics' && (!('value' in item) || !Number.isSafeInteger(item.value) || (item.value as number) < 0)
      ) throw new Error('manager record summary count is invalid')
    }
  }
}

export function ManagerRecordSummary({ summary, locale }: {
  readonly summary: NonNullable<ManagerContentPresentation['recordSummary']>
  readonly locale: string
}) {
  const visual = summary.leadingVisual
  return (
    <section
      className="cxr-manager-record-summary"
      data-manager-content-record-summary="true"
      aria-label={summary.title}
      data-has-metrics={Boolean(summary.metrics?.length) || undefined}
    >
      <span
        className="cxr-manager-record-avatar"
        role="img"
        aria-label={summary.title}
        data-manager-content-record-avatar-kind={visual.kind}
      >
        {visual.kind === 'identity'
          ? (
            <AccountIdentityVisual
              icon={visual.icon}
              {...(visual.avatar === undefined ? {} : { avatar: visual.avatar })}
            />
          )
          : (
            <HostAgentAvatar
              participant={{ id: 'manager-record-summary', name: summary.title, avatar: visual.avatar }}
            />
          )}
      </span>
      <div className="cxr-manager-record-copy">
        <strong>{summary.title}</strong>
        {summary.statuses?.length
          ? (
            <div className="cxr-manager-record-meta">
              {summary.description === undefined ? null : <span>{summary.description}</span>}
              {summary.statuses?.map(status => (
                <span
                  key={status.id}
                  className="cxr-manager-record-status"
                  data-tone={status.tone}
                  data-manager-record-status={status.id}
                >
                  <HostBrandIcon icon={status.icon} />
                  <span>{status.label}</span>
                </span>
              ))}
            </div>
          )
          : summary.description === undefined
          ? null
          : <span>{summary.description}</span>}
      </div>
      {summary.metrics?.length
        ? (
          <dl className="cxr-manager-record-metrics">
            {summary.metrics.map(metric => (
              <div key={metric.id} data-tone={metric.tone} data-manager-record-metric={metric.id}>
                <dt>
                  <HostBrandIcon icon={metric.icon} />
                  <span>{metric.label}</span>
                </dt>
                <dd>{new Intl.NumberFormat(locale).format(metric.value)}</dd>
              </div>
            ))}
          </dl>
        )
        : null}
    </section>
  )
}
