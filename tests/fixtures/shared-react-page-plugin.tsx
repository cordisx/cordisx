import type { Context } from '@deepseek-ai/cordis'
import React, { defineReactPage, useEffect, useState } from 'cordisx/react'
import { Button, Card, Heading, Stack, Text } from 'cordisx/ui'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../../packages/cli/src/contracts.js'

declare global {
  // eslint-disable-next-line no-var
  var __sharedReactPluginReact: typeof React | undefined
  // eslint-disable-next-line no-var
  var __sharedReactEffectMounts: number | undefined
  // eslint-disable-next-line no-var
  var __sharedReactEffectCleanups: number | undefined
}

type Messages = {
  'page.title': undefined
  'page.description': undefined
  'route.title': undefined
  'route.description': undefined
  'counter': { count: number }
}

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'overview',
  title: { key: 'page.title', fallback: 'Shared React' },
  description: { key: 'page.description', fallback: 'Exercise Host-owned React rendering.' },
  icon: 'host:info',
} as const

const route = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'overview',
  path: '/app/shared-react',
  outlet: 'app',
  page: 'overview',
  title: { key: 'route.title', fallback: 'Shared React' },
  description: { key: 'route.description', fallback: 'Open the shared React integration fixture.' },
} as const

const mount = defineReactPage<Messages>(({ t }) => {
  const [count, setCount] = useState(0)
  useEffect(() => {
    globalThis.__sharedReactEffectMounts = (globalThis.__sharedReactEffectMounts ?? 0) + 1
    return () => { globalThis.__sharedReactEffectCleanups = (globalThis.__sharedReactEffectCleanups ?? 0) + 1 }
  }, [])
  return (
    <Stack gap="medium" data-shared-react-page="mounted">
      <Heading>{t('page.title')}</Heading>
      <Card>
        <Stack gap="small" align="flex-start">
          <Text tone="muted">{t('page.description')}</Text>
          <Button variant="primary" onClick={() => setCount(value => value + 1)}>
            {t('counter', { count })}
          </Button>
        </Stack>
      </Card>
    </Stack>
  )
})

export const inject = ['i18n', 'pages', 'routes']

export function apply(ctx: Context): void {
  globalThis.__sharedReactPluginReact = React
  ctx.i18n.define<Messages>({
    namespace: 'shared-react', locale: 'en', default: true,
    messages: {
      'page.title': 'Shared React',
      'page.description': 'One React instance renders this plugin page.',
      'route.title': 'Shared React',
      'route.description': 'Open the shared React integration fixture.',
      'counter': 'Count {count, number}',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'shared-react', locale: 'zh-CN',
    messages: {
      'page.title': '共享 React',
      'page.description': '此插件页面由同一个 React 实例渲染。',
      'route.title': '共享 React',
      'route.description': '打开共享 React 集成夹具。',
      'counter': '计数 {count, number}',
    },
  })
  ctx.pages.register<Messages>(page, mount)
  ctx.routes.register(route)
}
