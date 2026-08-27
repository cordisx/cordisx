import type { ComponentType } from 'react'
import {
  AppIcon, ArrowLeftIcon, CloseIcon, ControlPlatformIcon, CopyIcon, DashboardIcon,
  DeleteIcon, DownloadIcon, EditIcon, ExtensionIcon, FileCopyIcon, FolderIcon,
  InfoCircleIcon, JumpIcon, KeyIcon, LayersIcon, MoreIcon, PauseIcon, PlayIcon, RefreshIcon,
  RollbackIcon, SaveIcon, SearchIcon, SealIcon, SettingIcon, ShopIcon, StarIcon, ToolsIcon, UploadIcon, UserIcon,
  VerifiedIcon, ViewListIcon,
} from 'tdesign-icons-react'
import type { ManagerIconToken } from '../icons.js'

type TDesignIcon = ComponentType<{ readonly className?: string; readonly size?: string | number }>

const ICONS: Readonly<Record<ManagerIconToken, TDesignIcon>> = {
  back: ArrowLeftIcon,
  'capability-fallback': InfoCircleIcon,
  close: CloseIcon,
  configuration: ToolsIcon,
  'console-clear': DeleteIcon,
  'console-copy': CopyIcon,
  'console-export': DownloadIcon,
  'console-follow': DownloadIcon,
  'console-pause': PauseIcon,
  'console-resume': PlayIcon,
  contributions: ControlPlatformIcon,
  diagnostics: DashboardIcon,
  document: ViewListIcon,
  'external-link': JumpIcon,
  launcher: AppIcon,
  marketplace: ShopIcon,
  'marketplace-certified': VerifiedIcon,
  'marketplace-official': SealIcon,
  'marketplace-source-add': UploadIcon,
  'marketplace-source-copy': FileCopyIcon,
  'marketplace-source-edit': EditIcon,
  'marketplace-source-move-down': DownloadIcon,
  'marketplace-source-move-up': UploadIcon,
  'models-read': DashboardIcon,
  outlets: LayersIcon,
  overview: DashboardIcon,
  permissions: KeyIcon,
  plugins: ExtensionIcon,
  'point-info': InfoCircleIcon,
  routes: AppIcon,
  runtime: DashboardIcon,
  search: SearchIcon,
  settings: SettingIcon,
  'tasks-catalog-read': ViewListIcon,
  'tasks-content-read': ViewListIcon,
  'tasks-control': ControlPlatformIcon,
  'tasks-create': UploadIcon,
  'turns-control': PauseIcon,
  'turns-submit': PlayIcon,
  'authors-source': UserIcon,
  'disable-plugin': PauseIcon,
  'enable-plugin': PlayIcon,
  favorite: StarIcon,
  'favorite-active': StarIcon,
  'import-plugin': FolderIcon,
  more: MoreIcon,
  'reload-plugin': RefreshIcon,
  'reset-configuration': RollbackIcon,
  'save-configuration': SaveIcon,
  'share-plugin': AppIcon,
  'uninstall-plugin': DeleteIcon,
}

export interface HostIconProps {
  readonly token: ManagerIconToken
  readonly className?: string
}

/** Closed Host semantic token mapped onto the official TDesign React icon set. */
export function HostIcon({ token, className }: HostIconProps) {
  const Icon = ICONS[token]
  return <Icon {...(className === undefined ? {} : { className })} size="1em" />
}
