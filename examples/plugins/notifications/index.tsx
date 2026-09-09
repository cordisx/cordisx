import type { Context } from '@deepseek-ai/cordis'
import { defineReactPage } from 'cordisx/react'
import { Button, Stack, Text } from 'cordisx/ui'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
} from '../../../packages/cli/src/contracts.js'

export const name = 'notifications-demo'
export const inject = ['notifications', 'i18n', 'pages', 'routes', 'slots']
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: name,
  name: 'Notification demo',
  capabilities: [],
}
export const icon = {
  mediaType: 'image/png',
  data:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGMIibxBU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAGTXFFtPNsmFAAAAAElFTkSuQmCC',
} as const
const text = (key: string, fallback: string) => ({ namespace: name, key, fallback })
export function apply(ctx: Context) {
  ctx.i18n.define({
    namespace: name,
    locale: 'en',
    messages: {
      'page.title': 'Notification demo',
      'page.description': 'Exercise the public notification API.',
      'route.title': 'Notification demo',
      'route.description': 'Open the notification interaction demo.',
    },
  })
  ctx.i18n.define({
    namespace: name,
    locale: 'zh-CN',
    messages: {
      'page.title': '通知演示',
      'page.description': '体验统一通知卡片、操作和屏蔽规则。',
      'route.title': '通知演示',
      'route.description': '打开通知交互演示页面。',
    },
  })
  let attempts = 0
  ctx.pages.register(
    {
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'main',
      title: text('page.title', 'Notification demo'),
      description: text('page.description', 'Exercise the public notification API.'),
    },
    defineReactPage(() => (
      <Stack gap="medium">
        <Text>Notification interaction demo</Text>
        <Button
          data-notification-demo="error"
          onClick={() =>
            ctx.notifications.show({
              kind: 'connection.failed',
              type: 'error',
              message: '无法连接来源',
              description: '暂时无法连接棋牌服务，请稍后重试。',
              details: 'Connection denied. No account data is included.',
              action: {
                label: '重试',
                run: async signal => {
                  signal.throwIfAborted()
                  attempts += 1
                  if (attempts % 2) throw new Error('Demo retry failure')
                },
              },
            })}
        >
          Show connection error
        </Button>
        <Button
          data-notification-demo="success"
          onClick={() => ctx.notifications.show({ kind: 'settings.saved', type: 'success', message: '设置已保存' })}
        >
          Show success
        </Button>
        <Button
          data-notification-demo="queue"
          onClick={() => {
            for (let i = 0; i < 5; i++) {
              ctx.notifications.show({
                kind: `demo.queue.${i}`,
                type: 'error',
                message: `Queue item ${i + 1}`,
              })
            }
          }}
        >
          Queue five errors
        </Button>
      </Stack>
    )),
  )
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'main',
    path: '/notification-demo',
    outlet: 'app',
    page: 'main',
    title: text('route.title', 'Notification demo'),
    description: text('route.description', 'Open the notification interaction demo.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'notifications-demo', order: -100 }, {
    label: text('route.title', 'Notification demo'),
    icon: 'host:info',
    route: { id: 'main' },
  })
}
