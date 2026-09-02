import type { CordisXReactPageProps } from '../../../packages/cli/src/contracts.js'
import { Card, Heading, Stack, Text } from 'cordisx/ui'

interface Messages {
  'page.app.body': undefined
  'page.main.body': undefined
  'page.session.body': { readonly sessionId: string }
}

export function ShowcasePage(props: CordisXReactPageProps<Messages>) {
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
