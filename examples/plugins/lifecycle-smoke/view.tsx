import type { CordisXReactPageProps } from 'cordisx/contracts'
import { Card, Heading, Stack, Text } from 'cordisx/ui'

interface LifecycleSmokeState {
  apply: number
  dispose: number
  invoke: number
}

export function createLifecyclePage(snapshot: LifecycleSmokeState) {
  return function LifecyclePage(props: CordisXReactPageProps) {
    return (
      <Card data-lifecycle-smoke-page="true">
        <Stack gap="medium">
          <Heading level={2}>{props.t('page.overview.title' as never)}</Heading>
          <Text tone="muted">{props.t('page.overview.description' as never)}</Text>
          <Text as="span">apply {snapshot.apply} · dispose {snapshot.dispose} · invoke {snapshot.invoke}</Text>
        </Stack>
      </Card>
    )
  }
}
