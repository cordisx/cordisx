import { useState } from 'cordisx/react'
import type { CordisXReactPageProps } from '../../../packages/cli/src/contracts.js'
import { Card, Stack, Text } from 'cordisx/ui'

interface Messages {
  'body.label': undefined
}

export function createSettingsNavigationPage(initialValue: string) {
  return function SettingsNavigationPage(props: CordisXReactPageProps<Messages>) {
    const [value, setValue] = useState(initialValue)
    return (
      <Card data-settings-navigation-demo-content="mounted">
        <Stack gap="medium">
          <label style={{ display: 'grid', gap: 6 }}>
            <strong>{props.t('body.label')}</strong>
            <input
              data-settings-navigation-demo-focus="true"
              value={value}
              onChange={event => setValue(event.currentTarget.value)}
            />
          </label>
          <Text as="span" tone="muted" data-settings-navigation-demo-route={props.routeId}>
            {props.outlet} · {props.routeId}
          </Text>
        </Stack>
      </Card>
    )
  }
}
