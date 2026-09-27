import managerNavigationCss from './manager-navigation.css?inline'
import managerContentCss from './manager-content.css?inline'
import managerCatalogCss from './manager-catalog.css?inline'
import managerDetailsCss from './manager-details.css?inline'
import managerMarketplaceCss from './manager-marketplace.css?inline'
import managerMarkdownCss from './manager-markdown.css?inline'
import managerPluginDetailsCss from './manager-plugin-details.css?inline'
import managerAboutCss from './manager-about.css?inline'
import managerCollectionCss from './manager-collection.css?inline'
import managerBrowseCss from './manager-browse.css?inline'
import managerCompactShellCss from './manager-compact-shell.css?inline'
import searchCss from '../host-ui/search.css?inline'
import actionGroupCss from '../host-ui/action-group.css?inline'
import { PLUGIN_CONSOLE_REACT_STYLES } from './components/PluginConsolePanel.js'
import { HOST_FORM_REACT_STYLES } from '../host-ui/HostForm.js'
import { HOST_COLLECTION_STYLES } from '../host-collection.js'
import { HOST_ICON_16PX_CSS } from '../icons.js'
import tdesignReactCss from 'tdesign-react/dist/tdesign.css'

const scopedTDesignReactCss = tdesignReactCss.replace(
  ":root.dark,\n:root[theme-mode='dark']",
  ".cxr-root[data-cordisx-app-theme='dark']",
)

// Keep responsibility modules in the original cascade order, including the
// compact shell overrides after collection styles and before embedded Host styles.
export const REACT_MANAGER_STYLES = [
  scopedTDesignReactCss,
  HOST_ICON_16PX_CSS,
  searchCss,
  actionGroupCss,
  managerNavigationCss,
  managerContentCss,
  managerCatalogCss,
  managerDetailsCss,
  managerMarketplaceCss,
  managerMarkdownCss,
  managerPluginDetailsCss,
  managerAboutCss,
  managerCollectionCss,
  managerCompactShellCss,
  managerBrowseCss,
  PLUGIN_CONSOLE_REACT_STYLES,
  HOST_FORM_REACT_STYLES,
  HOST_COLLECTION_STYLES,
].join('\n')
