import type { ProductCopyCatalog } from './types.js'

export const RUNTIME_DETAIL_COPY = {
  'runtime.active-contributions': { en: 'Active contributions', 'zh-CN': '活跃贡献' },
  'runtime.commands': { en: 'Commands', 'zh-CN': '命令' },
  'runtime.processing': { en: 'Working…', 'zh-CN': '处理中…' },
  'runtime.healthy': { en: 'Healthy', 'zh-CN': '运行正常' },
  'runtime.status-attention': { en: 'Needs attention', 'zh-CN': '需要处理' },
  'runtime.status-details': {
    en: 'Details are available in Logs & diagnostics.',
    'zh-CN': '详细信息请在日志与诊断中查看。',
  },
  'runtime.configured-disabled': { en: 'Disabled by configuration', 'zh-CN': '配置中已禁用' },
  'runtime.reauthorize': { en: 'Reauthorize', 'zh-CN': '重新授权' },
  'runtime.restore-plugin': { en: 'Restore plugin', 'zh-CN': '恢复插件' },
  'runtime.block-plugin': { en: 'Block plugin', 'zh-CN': '屏蔽插件' },
  'runtime.diagnostics': { en: 'Diagnostics', 'zh-CN': '诊断' },
  'runtime.configuration': { en: 'Configuration', 'zh-CN': '配置' },
  'runtime.not-declared': { en: 'Not declared', 'zh-CN': '未声明' },
  'runtime.revision': { en: 'revision', 'zh-CN': '版本' },
  'runtime.last-good': { en: 'last good', 'zh-CN': '最后可用' },
  'runtime.writer': { en: 'writer', 'zh-CN': '写入器' },
  'runtime.available': { en: 'available', 'zh-CN': '可用' },
  'runtime.unavailable': { en: 'unavailable', 'zh-CN': '不可用' },
  'runtime.availability-supported': { en: 'Available', 'zh-CN': '可用' },
  'runtime.availability-degraded': { en: 'Partially available', 'zh-CN': '部分可用' },
  'runtime.host': { en: 'Host', 'zh-CN': '宿主' },
  'runtime.adapter': { en: 'adapter', 'zh-CN': '适配器' },
  'runtime.secondary-connection': { en: 'secondary connection', 'zh-CN': '二次连接' },
  'runtime.raw-bridge': { en: 'raw bridge', 'zh-CN': '原始 bridge 暴露' },
  'runtime.yes': { en: 'yes', 'zh-CN': '是' },
  'runtime.no': { en: 'no', 'zh-CN': '否' },
  'runtime.permission-boundary': {
    en: 'Permissions apply only to Host API calls.',
    'zh-CN': '当前权限仅适用于 Host API 调用。',
  },
  'runtime.permission-documentation': { en: 'View permission documentation', 'zh-CN': '查看权限说明' },
} satisfies ProductCopyCatalog<'runtime'>

export const RUNTIME_EMPTY_COPY = {
  'runtime.empty': { en: 'No blocked plugins.', 'zh-CN': '暂无被屏蔽的插件。' },
  'runtime.restore': { en: 'Restore', 'zh-CN': '恢复' },
} satisfies ProductCopyCatalog<'runtime'>
