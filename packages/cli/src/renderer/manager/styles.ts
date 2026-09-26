import managerNavigationCss from './manager-navigation.css'
import managerContentCss from './manager-content.css'
import managerCatalogCss from './manager-catalog.css'
import managerDetailsCss from './manager-details.css'
import managerMarketplaceCss from './manager-marketplace.css'
import managerMarkdownCss from './manager-markdown.css'
import managerPluginDetailsCss from './manager-plugin-details.css'
import managerAboutCss from './manager-about.css'
import managerCollectionCss from './manager-collection.css'
import managerCompactShellCss from './manager-compact-shell.css'
import searchCss from '../host-ui/search.css'
import actionGroupCss from '../host-ui/action-group.css'
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
  PLUGIN_CONSOLE_REACT_STYLES,
  HOST_FORM_REACT_STYLES,
  HOST_COLLECTION_STYLES,
].join('\n')
