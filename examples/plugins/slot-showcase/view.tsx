import type { CordisXReactPageProps } from '../../../packages/cli/src/contracts.js'
import cordisxMarkDark from '../../../packages/cli/assets/brand/cordisx-mark-dark.svg'
import cordisxMarkLight from '../../../packages/cli/assets/brand/cordisx-mark-light.svg'
import { Card, Heading, Stack, Text } from 'cordisx/ui'

const cordisxMarkDarkUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkDark)}`
const cordisxMarkLightUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cordisxMarkLight)}`

interface Messages {
  'page.app.body': undefined
  'page.main.body': undefined
  'page.session.body': { readonly sessionId: string }
  'page.welcome.eyebrow': undefined
  'page.welcome.title': undefined
}

export function ShowcasePage(props: CordisXReactPageProps<Messages>) {
  if (props.routeId.endsWith(':main.welcome')) {
    return <section
      data-cordisx-demo-marker={props.outlet}
      data-cordisx-welcome="true"
      style={{
        minHeight: 'min(620px, calc(100vh - 170px))',
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
        color: 'var(--color-text-primary, currentColor)',
      }}
    >
      <div style={{ display: 'grid', justifyItems: 'center', gap: '22px' }}>
        <span
          aria-label="CordisX"
          role="img"
          className="cordisx-welcome-mark"
          style={{ display: 'grid', width: '112px', height: '112px' }}
        >
          <img className="cordisx-welcome-mark-dark" src={cordisxMarkDarkUri} alt="" style={{ gridArea: '1 / 1', width: '100%', height: '100%' }} />
          <img className="cordisx-welcome-mark-light" src={cordisxMarkLightUri} alt="" style={{ gridArea: '1 / 1', width: '100%', height: '100%' }} />
        </span>
        <style>{`
          .cordisx-welcome-mark-light { display: none; }
          [data-cordisx-app-theme="light"] .cordisx-welcome-mark-dark { display: none; }
          [data-cordisx-app-theme="light"] .cordisx-welcome-mark-light { display: block; }
        `}</style>
        <div style={{ display: 'grid', gap: '10px' }}>
          <span style={{ color: 'var(--color-text-secondary, #8490a3)', fontSize: '14px' }}>{props.t('page.welcome.eyebrow')}</span>
          <h2 style={{ margin: 0, font: '600 24px/1.25 system-ui, sans-serif' }}>{props.t('page.welcome.title')}</h2>
        </div>
      </div>
    </section>
  }

  const body = props.routeId.endsWith(':app.overview') ? props.t('page.app.body')
    : props.routeId.endsWith(':main.analytics') ? props.t('page.main.body')
    : props.t('page.session.body', { sessionId: String(props.params.sessionId) })
  return <Card as="article" data-cordisx-demo-marker={props.outlet}>
    <Stack gap="medium">
      <Text as="span" tone="muted">CORDISX · {props.outlet.toUpperCase()}</Text>
      <Heading level={3}>{body}</Heading>
      <Text as="span" tone="muted">{props.routeId} · {JSON.stringify(props.params)}</Text>
    </Stack>
  </Card>
}
