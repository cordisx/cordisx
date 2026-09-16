import type { Context } from '@deepseek-ai/cordis'
import React, { defineReactPage, useEffect, useState } from 'cordisx/react'
import {
  Button,
  Card,
  Dialog,
  Disclosure,
  FieldList,
  Heading,
  MarkdownViewer,
  SelectionRail,
  Stack,
  StatusBadge,
  Text,
} from 'cordisx/ui'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from '../../packages/cli/src/contracts.js'

declare global {
  var __sharedReactPluginReact: typeof React | undefined
  var __sharedReactEffectMounts: number | undefined
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
  const [section, setSection] = useState('overview')
  const [dialogOpen, setDialogOpen] = useState(false)
  useEffect(() => {
    globalThis.__sharedReactEffectMounts = (globalThis.__sharedReactEffectMounts ?? 0) + 1
    return () => {
      globalThis.__sharedReactEffectCleanups = (globalThis.__sharedReactEffectCleanups ?? 0) + 1
    }
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
      <Card>
        <SelectionRail
          aria-label="Document sections"
          value={section}
          options={[
            { value: 'overview', label: 'Overview', controls: 'shared-react-document' },
            { value: 'details', label: 'Details', controls: 'shared-react-document' },
          ]}
          onChange={setSection}
        />
        <div id="shared-react-document" role="tabpanel">
          <MarkdownViewer source={`## ${section}\n\nSafe **Markdown**.`} />
        </div>
      </Card>
      <Card>
        <FieldList
          aria-label="Runtime details"
          density="compact"
          columns={2}
          items={[{
            id: 'status',
            label: 'Runtime status',
            value: <StatusBadge tone="success">Ready</StatusBadge>,
            description: 'Host-owned status and aligned fields.',
          }]}
        />
        <Disclosure summary="Technical details">Generation shared-react-test</Disclosure>
        <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      </Card>
      <Dialog
        open={dialogOpen}
        title="Shared dialog"
        description="Rendered through the Host portal."
        onClose={() => setDialogOpen(false)}
        actions={<Button onClick={() => setDialogOpen(false)}>Close</Button>}
      />
    </Stack>
  )
})

export const inject = ['i18n', 'pages', 'routes']

export function apply(ctx: Context): void {
  globalThis.__sharedReactPluginReact = React
  ctx.i18n.define<Messages>({
    namespace: 'shared-react',
    locale: 'en',
    default: true,
    messages: {
      'page.title': 'Shared React',
      'page.description': 'One React instance renders this plugin page.',
      'route.title': 'Shared React',
      'route.description': 'Open the shared React integration fixture.',
      'counter': 'Count {count, number}',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'shared-react',
    locale: 'zh-CN',
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
