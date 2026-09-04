import { useState } from 'cordisx/react'
import { Button, Card, Heading, Stack, Text } from 'cordisx/ui'
import type { CordisXReactPageProps } from 'cordisx/contracts'

export type Messages = {
  'command.open': undefined
  'page.title': undefined
  'page.description': undefined
  'route.title': undefined
  'route.description': undefined
  'counter.label': { count: number }
}

/** A named component-only module forms a stable React Fast Refresh boundary. */
export function OverviewPage({ t }: CordisXReactPageProps<Messages>) {
  const [count, setCount] = useState(0)
  return (
    <Stack gap="large">
      <Heading>{t('page.title')}</Heading>
      <Card>
        <Stack gap="medium" align="flex-start">
          <Text tone="muted">{t('page.description')}</Text>
          <Button variant="primary" onClick={() => setCount(value => value + 1)}>
            {t('counter.label', { count })}
          </Button>
        </Stack>
      </Card>
    </Stack>
  )
}
