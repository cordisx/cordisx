import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from '../../../packages/cli/src/contracts.js'

const label = (en: string, zh: string) => ({ label: { en, 'zh-CN': zh } })
const description = (en: string, zh: string) => ({ en, 'zh-CN': zh })

/**
 * Configuration-only gallery. It contributes no pages, routes, slots, or
 * commands: the Manager owns the detail page and every control in it.
 */
export const name = 'form-schema-gallery'
export const inject: readonly string[] = []
const fields = {
  workspaceName: Schema.string().required().default('Northstar workspace').min(3).max(48).pattern(/\S/u)
    .extra('extra', label('Workspace name', '工作区名称'))
    .description('A short name shown to people who share this workspace.')
    .i18n(description('A short name shown to people who share this workspace.', '面向协作成员显示的简短工作区名称。')),
  welcomeNote: Schema.string().default('Keep shared work clear, current, and respectful.').max(400).role('multiline')
    .extra('extra', label('Welcome note', '欢迎说明'))
    .description('Optional guidance shown when someone joins the workspace.')
    .i18n(description('Optional guidance shown when someone joins the workspace.', '新成员加入工作区时显示的可选说明。')),
  handoffNote: Schema.string().max(240).role('multiline')
    .extra('extra', label('Handoff note', '交接说明'))
    .description('Optional and intentionally empty until the workspace is handed over.')
    .i18n(description('Optional and intentionally empty until the workspace is handed over.', '可选字段，在工作区交接前保持为空。')),
  documentationUrl: Schema.string().default('https://docs.example.test/workspaces/northstar').max(200).role('url')
    .extra('extra', label('Documentation URL', '文档地址'))
    .description('A secure link to the team playbook.')
    .i18n(description('A secure link to the team playbook.', '团队工作手册的安全链接。')),
  exportDirectory: Schema.string().default('/Users/demo/Documents/Northstar exports').max(240).role('directory')
    .extra('extra', label('Export folder', '导出文件夹'))
    .description('Choose where privacy-safe exports are prepared on this device.')
    .i18n(description('Choose where privacy-safe exports are prepared on this device.', '选择在此设备上准备隐私安全导出的位置。')),
  maxParallelJobs: Schema.natural().default(4).min(1).max(16).step(1)
    .extra('extra', label('Parallel tasks', '并行任务数'))
    .description('Limit background work so the workspace stays responsive.')
    .i18n(description('Limit background work so the workspace stays responsive.', '限制后台任务数量，让工作区保持流畅。')),
  reviewThreshold: Schema.number().default(0.75).min(0.5).max(1).step(0.05).role('slider')
    .extra('extra', label('Review threshold', '审核阈值'))
    .description('Items at or above this confidence level can be queued for review.')
    .i18n(description('Items at or above this confidence level can be queued for review.', '达到此置信度的项目可进入审核队列。')),
  showMemberAvatars: Schema.boolean().default(true)
    .extra('extra', label('Show member avatars', '显示成员头像'))
    .description('Show initials and avatars in shared activity.')
    .i18n(description('Show initials and avatars in shared activity.', '在共享动态中显示头像和首字母。')),
  backgroundSync: Schema.boolean().default(true).role('switch')
    .extra('extra', label('Background sync', '后台同步'))
    .description('Keep this local preview current while CordisX is open.')
    .i18n(description('Keep this local preview current while CordisX is open.', 'CordisX 打开期间保持本地预览更新。')),
  releaseTrack: Schema.union([Schema.const('stable'), Schema.const('preview'), Schema.const('early-access')]).default('stable')
    .extra('extra', label('Release track', '发布通道'))
    .description('Choose the update stream for this workspace.')
    .i18n(description('Choose the update stream for this workspace.', '选择此工作区使用的更新通道。')),
  approvalMode: Schema.union([Schema.const('manual'), Schema.const('team-lead'), Schema.const('automatic')]).default('manual').role('radio')
    .extra('extra', label('Approval mode', '审批方式'))
    .description('Select how new shared requests are approved.')
    .i18n(description('Select how new shared requests are approved.', '选择新共享请求的审批方式。')),
  preferredReviewDate: Schema.string().default('2026-09-01').role('date')
    .extra('extra', label('Preferred review date', '首选审核日期'))
    .description('A future date field kept visible to demonstrate the Host safe fallback.')
    .i18n(description('A future date field kept visible to demonstrate the Host safe fallback.', '保留此未来日期字段以展示 Host 的安全回退。')),
  dailyQuietTime: Schema.string().default('18:30').role('time')
    .extra('extra', label('Daily quiet time', '每日免打扰时间'))
    .description('A future time field kept visible to demonstrate the Host safe fallback.')
    .i18n(description('A future time field kept visible to demonstrate the Host safe fallback.', '保留此未来时间字段以展示 Host 的安全回退。')),
  accentColor: Schema.string().default('#476a9c').role('color')
    .extra('extra', label('Accent color', '强调色'))
    .description('A future color field kept visible to demonstrate the Host safe fallback.')
    .i18n(description('A future color field kept visible to demonstrate the Host safe fallback.', '保留此未来颜色字段以展示 Host 的安全回退。')),
  audienceTags: Schema.array(Schema.string().min(1).max(32)).default(['design', 'research']).min(1).max(5).role('multi-select')
    .extra('extra', label('Audience tags', '受众标签'))
    .description('The public descriptor has no bounded array-choice contract, so the Host shows its safe unsupported diagnostic.')
    .i18n(description('The public descriptor has no bounded array-choice contract, so the Host shows its safe unsupported diagnostic.', '公开 descriptor 尚无有界数组选项契约，因此 Host 显示安全的不支持诊断。')),
  notificationRules: Schema.array(Schema.object({
    destination: Schema.string().min(3).max(80),
    enabled: Schema.boolean().default(true),
  })).default([{ destination: 'Daily summary', enabled: true }]).min(1).max(4)
    .extra('extra', label('Notification rules', '通知规则'))
    .description('Repeatable delivery rules. Edit the privacy-safe list as JSON.')
    .i18n(description('Repeatable delivery rules. Edit the privacy-safe list as JSON.', '可重复的投递规则，以 JSON 编辑这份隐私安全列表。')),
  appearance: Schema.object({
    density: Schema.union([Schema.const('comfortable'), Schema.const('compact')]).default('comfortable')
      .extra('extra', label('Display density', '显示密度'))
      .description('Choose a comfortable or compact layout for this workspace.')
      .i18n(description('Choose a comfortable or compact layout for this workspace.', '为此工作区选择舒适或紧凑的布局。')),
    showActivity: Schema.boolean().default(true)
      .extra('extra', label('Show recent activity', '显示最近动态'))
      .description('Include recent workspace activity in the overview.')
      .i18n(description('Include recent workspace activity in the overview.', '在概览中显示最近的工作区动态。')),
  }),
  referenceCode: Schema.string().default('DEMO-NORTHSTAR-01').disabled()
    .extra('extra', label('Reference code', '参考编号'))
    .description('This privacy-safe sample identifier cannot be changed.')
    .i18n(description('This privacy-safe sample identifier cannot be changed.', '此隐私安全示例编号不可修改。')),
}

export const Config = Schema.object(fields)

export type FormSchemaGalleryConfig = Schemastery.TypeT<typeof Config>
export const configApplies = 'plugin-restart'
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'form-schema-gallery',
  name: 'Form Schema Gallery',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export function apply(_ctx: Context, _config: FormSchemaGalleryConfig = Config({})): void {}
