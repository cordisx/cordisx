import { HOST_COLLECTION_STYLES } from '.././host-collection.js'
import { HOST_FORM_STYLES } from '.././host-form.js'

export const MANAGER_STYLES = `
  ${HOST_FORM_STYLES}
  ${HOST_COLLECTION_STYLES}
  [data-cordisx-manager-trigger] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-left: 2px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: .72;
  }
  [data-cordisx-manager-trigger]:hover,
  [data-cordisx-manager-trigger][aria-expanded="true"] {
    background: color-mix(in srgb, currentColor 9%, transparent);
    opacity: 1;
  }
  [data-cordisx-manager-trigger]:focus-visible {
    outline: 2px solid #c7ccd4;
    outline-offset: 1px;
  }
  .cxm-brand-mark {
    display: block;
    width: 18px;
    height: 18px;
    flex: none;
    pointer-events: none;
  }
  [data-cordisx-manager-trigger] .cxm-brand-mark {
    width: 20px;
    height: 20px;
  }
  .cxm-brand-mark,
  .cxm-host-icon,
  .cxm-host-icon svg,
  .cordisx-host-icon,
  .cordisx-host-icon svg,
  .cxm-plugin-icon,
  .cxm-status-dot,
  .cxm-dot {
    -webkit-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  .cxm-host-icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    line-height: 0;
    pointer-events: none;
  }
  .cordisx-host-icon { flex: none; line-height: 0; pointer-events: none; }
  .cxm-host-icon svg {
    display: block;
    width: 100%;
    height: 100%;
    color: currentColor;
    pointer-events: none;
  }
  .cordisx-host-icon svg { color: currentColor; pointer-events: none; }
  .cxm-brand-mark[data-brand-rendering^="direct-"] { object-fit: contain; }
  [data-cordisx-manager-modal] {
    position: fixed;
    inset: 0;
    z-index: 2147483600;
    color: #e7e9ee;
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  }
  [data-cordisx-manager-modal][hidden] { display: none; }
  .cxm-backdrop {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    padding: 20px;
    box-sizing: border-box;
    background: rgba(5, 7, 12, .66);
    backdrop-filter: blur(8px);
  }
  .cxm-dialog {
    --cx-compact-list-icon-seat: 22px;
    --cx-compact-list-icon-glyph: 16px;
    display: grid;
    grid-template-columns: 248px minmax(0, 1fr);
    width: min(1440px, calc(100vw - 40px));
    height: min(960px, calc(100vh - 40px));
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 18px;
    background: #12151d;
    box-shadow: 0 32px 120px rgba(0, 0, 0, .55);
  }
  .cxm-sidebar {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 18px 12px 14px;
    border-right: 1px solid rgba(255, 255, 255, .08);
    background: linear-gradient(180deg, #191c26, #141720);
  }
  .cxm-nav { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 4px; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
  .cxm-nav-button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #aeb5c3;
    cursor: pointer;
    text-align: left;
    font: inherit;
  }
  .cxm-nav-button:hover { background: rgba(255, 255, 255, .05); color: #fff; }
  .cxm-nav-button[aria-current="page"] { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-nav-button:disabled { cursor: default; opacity: .48; }
  .cxm-nav-button[data-tab="about"] { margin-top: auto; }
  .cxm-nav-icon { width: 20px; height: 20px; color: #b8bec8; }
  .cxm-nav-icon.cordisx-host-icon { display: inline-grid; place-items: center; }
  .cxm-nav-icon svg { width: 18px; height: 18px; }
  .cxm-nav-button:focus-visible,
  .cxm-close:focus-visible,
  .cxm-tab:focus-visible,
  .cxm-action:focus-visible,
  .cxm-mini-action:focus-visible {
    outline: 2px solid #c7ccd4;
    outline-offset: 2px;
  }
  .cxm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }
  .cxm-header {
    --cx-manager-header-leading-seat: 26px;
    --cx-manager-header-leading-glyph: 18px;
    --cx-manager-header-title-size: 16px;
    --cx-manager-header-title-line-height: 26px;
    --cx-manager-icon-control-size: 30px;
    --cx-manager-icon-control-glyph: 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 72px;
    flex: 0 0 auto;
    padding: 0 22px;
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-heading { position: relative; display: grid; grid-template-columns: var(--cx-manager-header-leading-seat) minmax(0, 1fr); align-items: start; column-gap: 9px; min-width: 0; flex: 1 1 auto; }
  .cxm-heading[data-heading-actions="true"] { padding-right: 36px; }
  .cxm-heading-menu { position: absolute; z-index: 8; top: -2px; right: 0; }
  .cxm-heading-menu > .cxm-manager-icon-action { color: var(--cx-muted); }
  .cxm-heading-menu-popup { position: absolute; z-index: 9; top: 34px; right: 0; min-width: 172px; box-sizing: border-box; padding: 4px; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); box-shadow: 0 14px 32px rgba(0, 0, 0, .2); }
  .cxm-heading-menu-popup[hidden] { display: none; }
  .cxm-heading-menu-item { display: flex; width: 100%; align-items: center; gap: 8px; box-sizing: border-box; padding: 8px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--cx-text); cursor: pointer; font: inherit; text-align: left; }
  .cxm-heading-menu-item:hover { background: var(--cx-hover); }
  .cxm-heading-menu-item:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 1px; }
  .cxm-heading-menu-item .cxm-host-icon { width: 16px; height: 16px; }
  .cxm-heading-row { display: contents; }
  .cxm-heading-title { display: flex; grid-column: 2; align-items: center; min-width: 0; min-height: var(--cx-manager-header-leading-seat); color: #fff; font-size: var(--cx-manager-header-title-size); font-weight: 700; line-height: var(--cx-manager-header-title-line-height); }
  .cxm-heading-current-heading { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .cxm-heading p { grid-column: 1 / -1; margin: 3px 0 0; color: #7f899a; font-size: 11px; }
  .cxm-heading-direct-title { grid-column: 2; min-width: 0; min-height: var(--cx-manager-header-leading-seat); margin: 0; color: #fff; font-size: var(--cx-manager-header-title-size); font-weight: 700; line-height: var(--cx-manager-header-title-line-height); }
  .cxm-heading-leading {
    display: grid;
    place-items: center;
    width: var(--cx-manager-header-leading-seat);
    height: var(--cx-manager-header-leading-seat);
    flex: none;
    box-sizing: border-box;
    border: 0;
    background: transparent;
    color: #d8dce3;
    align-self: start;
  }
  .cxm-heading-icon svg { width: var(--cx-manager-header-leading-glyph); height: var(--cx-manager-header-leading-glyph); transform: translateY(-.5px); }
  .cxm-back {
    padding: 0;
    cursor: pointer;
  }
  .cxm-back { border-radius: 7px; }
  .cxm-back-icon { width: var(--cx-manager-header-leading-glyph); height: var(--cx-manager-header-leading-glyph); }
  .cxm-back-icon svg { transform: translateY(-.5px); }
  .cxm-back:hover { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-back:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-breadcrumbs { min-width: 0; width: 100%; }
  .cxm-breadcrumb-list { display: flex; min-width: 0; min-height: var(--cx-manager-header-leading-seat); margin: 0; padding: 0; align-items: center; list-style: none; line-height: var(--cx-manager-header-title-line-height); white-space: nowrap; }
  .cxm-breadcrumb-item { display: inline-flex; min-width: 0; min-height: var(--cx-manager-header-leading-seat); flex: 0 0 auto; align-items: center; }
  .cxm-breadcrumb-item:last-child { flex: 1 1 auto; }
  .cxm-breadcrumb-separator { padding: 0 6px; color: #656e7e; font-weight: 400; }
  .cxm-breadcrumb-action {
    min-width: 0;
    padding: 2px 3px;
    overflow: hidden;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #a9b1c0;
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    line-height: calc(var(--cx-manager-header-title-line-height) - 4px);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cxm-breadcrumb-action:hover { background: rgba(199, 204, 212, .1); color: #eef0f3; }
  .cxm-breadcrumb-action:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 1px; }
  .cxm-breadcrumb-current { min-width: 0; overflow: hidden; color: #fff; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-breadcrumb-overflow { position: relative; }
  .cxm-breadcrumb-overflow > summary {
    display: grid;
    width: 28px;
    height: 24px;
    place-items: center;
    border-radius: 5px;
    color: #a9b1c0;
    cursor: pointer;
    list-style: none;
  }
  .cxm-breadcrumb-overflow > summary::-webkit-details-marker { display: none; }
  .cxm-breadcrumb-overflow > summary:hover { background: rgba(199, 204, 212, .1); color: #eef0f3; }
  .cxm-breadcrumb-overflow > summary:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 1px; }
  .cxm-breadcrumb-menu {
    position: absolute;
    z-index: 2;
    top: calc(100% + 6px);
    left: 0;
    display: grid;
    min-width: 180px;
    max-width: min(360px, calc(100vw - 80px));
    padding: 6px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 9px;
    background: #1a1e28;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .42);
  }
  .cxm-breadcrumb-menu .cxm-breadcrumb-action { width: 100%; padding: 7px 9px; text-align: left; }
  .cxm-close {
    display: grid;
    place-items: center;
    width: var(--cx-manager-icon-control-size);
    height: var(--cx-manager-icon-control-size);
    flex: none;
    box-sizing: border-box;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #d8dce5;
    cursor: pointer;
  }
  .cxm-close-icon { display: block; width: var(--cx-manager-icon-control-glyph); height: var(--cx-manager-icon-control-glyph); }
  .cxm-close:hover { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-content {
    --cx-manager-content-block-start: 20px;
    --cx-manager-content-inline: 22px;
    --cx-manager-content-block-end: 24px;
    min-height: 0;
    flex: 1 1 0%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: var(--cx-manager-content-block-start) var(--cx-manager-content-inline) var(--cx-manager-content-block-end);
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  /* A sidebar-owned manager.content page is a plugin-owned content seat. The
     shared scroll viewport must not add an outer Host inset around it. */
  .cxm-content[data-manager-content-page="true"] { padding: 0; }
  .cxm-content[data-marketplace-discovery="true"] { overflow: hidden; }
  .cxm-content[data-manager-list-page="true"] { display: flex; overflow: hidden; }
  .cxm-content[data-manager-list-page="true"] > .cxm-fixed-list-collection { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .cxm-content[data-manager-list-page="true"] > .cxm-fixed-list-collection .cxc-list { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .cxm-marketplace-discovery { display: flex; min-width: 0; min-height: 0; height: 100%; flex-direction: column; }
  .cxm-marketplace-discovery-tools { flex: 0 0 auto; }
  .cxm-marketplace-filter-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
  .cxm-marketplace-results { min-width: 0; min-height: 0; flex: 1 1 auto; margin: 12px -8px -24px; padding: 0 8px 24px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .cxm-marketplace-source-page { min-width: 0; }
  .cxm-marketplace-source-page .cxf-form { inline-size: 100%; max-inline-size: none; margin-inline: 0; }
  .cxm-marketplace-source-page .cxf-form-grid { inline-size: 100%; }
  .cxm-marketplace-source-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 12px; }
  .cxm-marketplace-source-readonly { overflow-wrap: anywhere; color: var(--cx-muted); font: 11px/1.5 ui-monospace, monospace; user-select: text; }
  .cxm-tabs {
    display: flex;
    width: 100%;
    min-width: 0;
    flex-wrap: wrap;
    gap: 5px;
    margin: -4px -8px 16px;
    padding: 0;
    overflow: visible;
  }
  .cxm-tab {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    flex: none;
    padding: 7px 9px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: #858fa1;
    cursor: pointer;
    font: 11px/1.2 system-ui, sans-serif;
  }
  .cxm-tab-content { display: inline-grid; min-width: 0; max-width: 100%; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 7px; }
  .cxm-tab-content > span:last-child { min-width: 0; overflow-wrap: anywhere; }
  .cxm-tab-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; color: currentColor; }
  .cxm-tab-icon svg { width: 17px; height: 17px; transform: translateY(-.5px); }
  .cxm-tab:hover { background: rgba(199, 204, 212, .08); color: #eef0f3; }
  .cxm-tab[aria-selected="true"] { background: rgba(199, 204, 212, .14); color: #eef0f3; }
  .cxm-settings-root { display: flex; min-width: 0; min-height: 100%; flex-direction: column; }
  .cxm-settings-root > .cxm-tabs { flex: 0 0 auto; }
  .cxm-settings-panel { min-width: 0; min-height: 0; flex: 1 1 auto; outline: none; }
  .cxm-settings-panel-body { min-width: 0; min-height: 100%; overflow: visible; }
  .cxm-settings-panel[aria-busy="true"] .cxm-settings-panel-body { opacity: .78; }
  .cxm-settings-tab-icon.cordisx-host-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; }
  .cxm-settings-tab-icon.cordisx-host-icon svg { width: 17px; height: 17px; }
  .cxm-manager-content-root { min-width: 0; max-width: 100%; }
  .cxm-content[data-manager-content-page="true"] > .cxm-manager-content-root { padding: 0; }
  .cxm-content[data-manager-content-page="true"] > .cxm-tabs { margin: 16px calc(var(--cx-manager-content-inline) - 8px) 16px; }
  .cxm-tab:disabled { cursor: default; opacity: .42; }
  .cxm-about-identity { display: flex; align-items: center; gap: 18px; padding: 4px 2px 22px; }
  .cxm-about-identity-copy { min-width: 0; white-space: nowrap; }
  .cxm-about-mark.cxm-brand-mark { width: 54px; height: 54px; }
  .cxm-about-name { color: #f5f6f8; font-size: 22px; font-weight: 720; letter-spacing: -.02em; }
  .cxm-about-version { margin-top: 3px; color: #8d96a8; font: 11px/1.4 ui-monospace, monospace; }
  .cxm-about-actions { overflow: hidden; border: 1px solid rgba(255, 255, 255, .08); border-radius: 12px; background: rgba(255, 255, 255, .025); }
  .cxm-about-action { display: flex; width: 100%; min-width: 0; box-sizing: border-box; align-items: center; gap: 16px; padding: 14px 12px; border-radius: 9px; background: transparent; color: inherit; text-decoration: none; }
  .cxm-about-action-item + .cxm-about-action-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-about-action:hover, .cxm-about-action:focus-visible { background: rgba(199, 204, 212, .08); color: #fff; }
  .cxm-about-action:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -2px; }
  .cxm-about-action-body { min-width: 0; overflow: hidden; flex: 1; }
  .cxm-about-action-title { display: block; overflow: hidden; background: transparent; color: #d8dce3; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-about-action-copy { display: -webkit-box; margin-top: 3px; overflow: hidden; background: transparent; color: #838d9f; font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-about-action-arrow { width: 16px; height: 16px; flex: none; color: #747e8e; transition: color .12s ease; }
  .cxm-about-action:hover .cxm-about-action-title, .cxm-about-action:focus-visible .cxm-about-action-title { color: currentColor; }
  .cxm-about-action:hover .cxm-about-action-arrow, .cxm-about-action:focus-visible .cxm-about-action-arrow { color: currentColor; }
  .cxm-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .cxm-card, .cxm-slot-card, .cxm-source-row {
    border: 1px solid rgba(255, 255, 255, .09);
    border-radius: 12px;
    background: rgba(255, 255, 255, .035);
  }
  .cxm-card { padding: 15px; }
  .cxm-card-label { color: #7f899a; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .cxm-card-value { margin-top: 6px; color: #fff; font-size: 20px; font-weight: 700; }
  .cxm-section-title { margin: 22px 0 8px; color: #f2f4f8; font-size: 13px; font-weight: 700; }
  .cxm-tab-panel { min-width: 0; }
  .cxm-content:has(.cxm-console-panel) { display: flex; flex-direction: column; overflow: hidden; }
  .cxm-console-panel { display: flex; min-width: 0; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .cxm-tab-panel:has(.cxf-form), .cxm-permission-detail { inline-size: 100%; max-inline-size: none; margin-inline: 0; }
  .cxm-tab-panel > .cxm-section-title:first-child { margin-top: 0; }
  /* The Markdown surface uses the available detail width; prose itself keeps
     a GitHub-like reading measure while code, tables, and headings can span it. */
  .cxm-readme { inline-size: 100%; max-inline-size: 96rem; color: var(--cx-text); font-size: 12px; line-height: 1.62; overflow-wrap: anywhere; }
  .cxm-readme p, .cxm-readme li, .cxm-readme blockquote { max-inline-size: 76ch; }
  .cxm-readme > :first-child { margin-top: 0; }
  .cxm-readme > :last-child { margin-bottom: 0; }
  .cxm-readme h1, .cxm-readme h2, .cxm-readme h3, .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { margin: 1.4em 0 .55em; color: var(--cx-text); line-height: 1.28; }
  .cxm-readme h1 { padding-bottom: .35em; border-bottom: 1px solid var(--cx-border); font-size: 1.55em; }
  .cxm-readme h2 { padding-bottom: .28em; border-bottom: 1px solid var(--cx-border); font-size: 1.28em; }
  .cxm-readme h3 { font-size: 1.12em; }
  .cxm-readme p, .cxm-readme ul, .cxm-readme ol, .cxm-readme blockquote, .cxm-readme pre, .cxm-readme table { margin: .7em 0; }
  .cxm-readme ul, .cxm-readme ol { padding-left: 1.55em; }
  .cxm-readme li + li { margin-top: .22em; }
  .cxm-readme .task-list-item { display: flex; align-items: baseline; gap: .45em; list-style: none; margin-left: -1.3em; }
  .cxm-readme .task-list-item input { accent-color: var(--cx-primary); }
  .cxm-readme a { color: var(--cx-primary); text-underline-offset: 2px; }
  .cxm-readme code { padding: .12em .28em; border-radius: 4px; background: var(--cx-hover); font: .92em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-readme pre { overflow: auto; padding: 10px 12px; border: 1px solid var(--cx-border); border-radius: 8px; background: color-mix(in srgb, var(--cx-surface-raised) 86%, #000); }
  .cxm-readme pre code { padding: 0; background: transparent; }
  .cxm-readme blockquote { padding: .1em 1em; border-left: 3px solid var(--cx-border); color: var(--cx-muted); }
  .cxm-readme blockquote p { margin: .55em 0; }
  .cxm-readme hr { height: 1px; margin: 1.35em 0; border: 0; background: var(--cx-border); }
  .cxm-readme table { display: block; max-width: 100%; overflow: auto; border-spacing: 0; border-collapse: collapse; }
  .cxm-readme th, .cxm-readme td { padding: .45em .65em; border: 1px solid var(--cx-border); text-align: left; }
  .cxm-readme th { background: var(--cx-hover); font-weight: 650; }
  .cxm-flat-list {
    margin-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, .08);
    border-bottom: 1px solid rgba(255, 255, 255, .08);
  }
  .cxm-settings-group { overflow: clip; border: 1px solid var(--cx-border); border-radius: .8rem; background: color-mix(in srgb, var(--cx-surface-raised) 86%, var(--cx-surface)); box-shadow: 0 1px 2px color-mix(in srgb, var(--cx-shadow) 18%, transparent); }
  .cxm-plugin-service-config .cxm-service-config-footer {
    position: static;
    z-index: auto;
    min-block-size: 2.75rem;
    padding: .25rem 0 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
  }
  .cxm-settings-group.cxm-flat-list { border-top-color: var(--cx-border); border-bottom-color: var(--cx-border); }
  .cxm-settings-group .cxm-flat-item { padding: .9rem 1rem; }
  .cxm-flat-item { padding: 14px 2px; }
  .cxm-flat-item + .cxm-flat-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-permission-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 18px; }
  .cxm-permission-open {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    gap: 11px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .cxm-permission-open:hover .cxm-permission-name { color: #fff; }
  .cxm-permission-open:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 4px; border-radius: 5px; }
  .cxm-capability-icon { width: 24px; height: 24px; color: #bfc5ce; }
  .cxm-capability-icon svg { width: 20px; height: 20px; }
  .cxm-permission-copy { min-width: 0; }
  .cxm-permission-title { display: flex; align-items: center; gap: 7px; }
  .cxm-permission-name { color: #e7e9ee; font-size: 12px; font-weight: 650; }
  .cxm-required-badge { padding: 2px 5px; border-radius: 5px; background: rgba(251, 191, 36, .1); color: #d6c37e; font-size: 9px; font-weight: 700; }
  .cxm-permission-reason { display: block; margin-top: 3px; overflow: hidden; color: #858fa1; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-permission-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 118px; }
  .cxm-permission-policy-select { inline-size: min(100%, 12rem); min-inline-size: 0; }
  .cxm-permission-detail-intro { display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 12px; }
  .cxm-permission-detail-intro .cxm-capability-icon { width: 34px; height: 34px; }
  .cxm-permission-detail-intro .cxm-capability-icon svg { width: 26px; height: 26px; }
  .cxm-permission-detail { display: grid; gap: 1.35rem; padding-block: .25rem 1rem; }
  .cxm-permission-detail-policy { inline-size: min(100%, 16rem); }
  .cxm-settings-info-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(11rem, 42%); align-items: center; gap: 1rem; padding: .9rem 1rem; }
  .cxm-settings-info-row + .cxm-settings-info-row { border-top: 1px solid var(--cx-border); }
  .cxm-settings-info-label { color: var(--cx-text); font-size: .82rem; font-weight: 600; }
  .cxm-settings-info-value { min-width: 0; color: var(--cx-muted); font: .78rem/1.4 ui-monospace, monospace; overflow-wrap: anywhere; text-align: end; }
  .cxm-permission-provider-item { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 8px 16px; }
  .cxm-permission-provider-item > .cxm-code { grid-column: 1 / -1; margin: 0; }
  .cxm-permission-audit { margin-top: 16px; }
  .cxm-diagnostics { margin-top: 22px; border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-diagnostics summary { padding: 14px 2px; color: #98a1b2; cursor: pointer; font-size: 11px; }
  .cxm-diagnostics[open] summary { color: #d8dce3; }
  .cxm-diagnostics-body { padding: 0 2px 4px; }
  .cxm-runtime-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .cxm-runtime-console-summary { display: flex; min-width: 0; align-items: stretch; gap: 1px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(255,255,255,.08); }
  .cxm-runtime-overview { display: grid; gap: 10px; inline-size: 100%; max-inline-size: none; }
  .cxm-runtime-status { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--cx-border); border-radius: 12px; background: var(--cx-surface-raised); }
  .cxm-runtime-status-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 9px; background: var(--cx-hover); color: var(--cx-primary); }
  .cxm-runtime-status-icon .cxm-host-icon { width: 19px; height: 19px; }
  .cxm-runtime-status-copy { min-width: 0; }
  .cxm-runtime-status-label { display: block; color: var(--cx-text); font-size: 13px; font-weight: 680; }
  .cxm-runtime-status-meta { display: block; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-status-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .cxm-runtime-status-fact { display: grid; gap: 2px; min-width: 0; padding: 9px 10px; border: 1px solid var(--cx-border); border-radius: 9px; background: var(--cx-surface-raised); color: var(--cx-muted); font-size: 10px; }
  .cxm-runtime-status-fact strong { overflow: hidden; color: var(--cx-text); font-size: 15px; line-height: 1.15; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-status-fact span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-runtime-diagnostics { overflow: hidden; border: 1px solid var(--cx-border); border-radius: 10px; background: var(--cx-surface-raised); }
  .cxm-runtime-diagnostics > summary { padding: 10px 12px; color: var(--cx-text); cursor: pointer; font-size: 11px; font-weight: 650; }
  .cxm-runtime-diagnostics > summary::marker { color: var(--cx-muted); }
  .cxm-runtime-diagnostic-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 1px; border-top: 1px solid var(--cx-border); background: var(--cx-border); }
  .cxm-runtime-diagnostic { display: grid; min-width: 0; gap: 3px; padding: 10px 12px; background: var(--cx-surface-raised); }
  .cxm-runtime-diagnostic-label { color: var(--cx-muted); font-size: 10px; }
  .cxm-runtime-diagnostic-value { overflow-wrap: anywhere; color: var(--cx-text); font-size: 11px; line-height: 1.4; }
  .cxm-runtime-console-metric { min-width: 72px; padding: 7px 10px; background: #191b1f; }
  .cxm-runtime-console-metric strong { display: inline; color: #eceef2; font: 600 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-runtime-console-metric span { margin-left: 6px; color: #818a99; font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
  .cxm-runtime-console-performance { flex: 1; min-width: 0; background: #191b1f; }
  .cxm-runtime-console-performance summary { padding: 8px 10px; color: #8d96a8; cursor: pointer; font-size: 10px; list-style-position: inside; }
  .cxm-runtime-console-performance-body { padding: 0 10px 8px; color: #aab2c0; font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls { display: grid; grid-template-columns: minmax(150px, 1.35fr) repeat(3, minmax(96px, 1fr)) max-content; gap: 7px; align-items: center; min-width: 0; margin: 8px 0; }
  .cxm-console-controls input { min-width: 0; height: 30px; border: 1px solid #353a42; border-radius: 6px; padding: 0 8px; background: #15171a; color: #d8dce3; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-controls t-select { min-width: 0; width: 100%; box-sizing: border-box; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-action-toolbar { display: flex; flex: none; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; white-space: nowrap; }
  .cxm-console-warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 8px; }
  .cxm-console-warning button { flex: none; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
  .cxm-console-workspace { display: grid; min-width: 0; min-height: 0; flex: 1 1 auto; overflow: hidden; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: stretch; }
  .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); }
  .cxm-console-body { position: relative; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
  .cxm-console-frame { width: 100%; height: 100%; min-height: 0; flex: 1 1 auto; overflow: auto; box-sizing: border-box; border: 1px solid #30343a; border-radius: 7px; background: #101215; scrollbar-gutter: stable; overscroll-behavior: contain; }
  .cxm-console-frame.cxm-console-luna { min-height: 28px; color: #cad0da; cursor: default; }
  .cxm-console-frame.cxm-console-luna.luna-console { height: 100%; border: 1px solid #30343a; background: #101215; }
  .cxm-console-frame.cxm-console-luna .luna-console-log-content { font-size: 11px; line-height: 16px; }
  .cxm-console-frame.cxm-console-luna .luna-console-header { font-size: 10px; }
  .cxm-console-frame.cxm-console-luna:focus-visible { outline: 2px solid #8e98a9; outline-offset: 2px; }
  .cxm-console-latest { position: absolute; right: 14px; bottom: 12px; z-index: 1; border: 1px solid #4a515c; background: #252a31; color: #e3e7ee; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
  .cxm-console-inspector { min-width: 0; min-height: 0; overflow: auto; border: 1px solid #30343a; border-radius: 7px; background: #141619; }
  .cxm-console-inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #30343a; color: #cdd2db; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-head button { border: 0; background: transparent; color: #98a1b2; cursor: pointer; }
  .cxm-console-inspector-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; margin: 0; padding: 10px; font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cxm-console-inspector-grid dt { color: #778294; }
  .cxm-console-inspector-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: #bdc5d2; }
  .cxm-console-empty { display: grid; min-height: 160px; place-items: center; padding: 20px 16px; color: #737d8e; text-align: center; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-summary { border-color: rgba(18,24,33,.12); background: rgba(18,24,33,.12); }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-metric,
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-performance { background: #f4f5f7; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-runtime-console-metric strong { color: #1d222b; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-controls input { border-color: #c7ccd4; background: #fff; color: #20242c; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-frame.cxm-console-luna.luna-console { border-color: #c7ccd4; background: #fff; color: #252b35; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector { border-color: #c7ccd4; background: #f8f9fa; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector-head { border-color: #d7dbe1; color: #252b35; }
  [data-cordisx-manager-modal][data-cordisx-app-theme="light"] .cxm-console-inspector-grid dd { color: #354052; }
  .cxm-copy { margin: 0; color: #98a1b2; font-size: 12px; }
  .cxm-notice {
    margin-top: 14px;
    padding: 12px 14px;
    border: 1px solid rgba(199, 204, 212, .2);
    border-radius: 11px;
    background: rgba(199, 204, 212, .07);
    color: #b8bfd0;
    font-size: 11px;
  }
  .cxm-notice[data-tone="warning"] { border-color: rgba(251, 191, 36, .2); background: rgba(251, 191, 36, .055); color: #c5b889; }
  .cxm-slots { display: grid; gap: 10px; }
  .cxm-slot-card { padding: 13px 14px; }
  .cxm-slot-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cxm-slot-name { color: #d8dce3; font: 12px/1.3 ui-monospace, monospace; }
  .cxm-contributions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .cxm-contribution {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 8px;
    background: rgba(255, 255, 255, .05);
    color: #c7cdd8;
    font-size: 10px;
  }
  .cxm-dot { width: 7px; height: 7px; box-sizing: border-box; border: 1px solid #86efac; border-radius: 50%; }
  .cxm-dot[data-rendered="true"] { background: #86efac; }
  .cxm-empty { padding: 28px 12px; color: #687284; font-size: 11px; text-align: center; }
  .cxm-toolbar { display: flex; align-items: center; gap: 10px; }
  .cxm-list-search { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 38px; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, .1); border-radius: 9px; background: rgba(255, 255, 255, .045); }
  .cxm-toolbar > .cxm-action { height: 38px; }
  .cxm-toolbar > .cxm-toolbar-icon-action {
    width: 38px;
    height: 38px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    background: rgba(255, 255, 255, .045);
  }
  .cxm-marketplace-filter {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: max-content;
    min-height: 28px;
    box-sizing: border-box;
    padding: 4px 9px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 999px;
    background: rgba(255, 255, 255, .045);
    color: #aab2c0;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .cxm-marketplace-filter:hover { border-color: rgba(199, 204, 212, .38); color: #eef0f4; }
  .cxm-marketplace-filter[aria-pressed="true"] { border-color: rgba(125, 211, 252, .45); background: rgba(125, 211, 252, .12); color: #dff5ff; }
  .cxm-marketplace-filter:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-marketplace-filter .cxm-host-icon { width: 17px; height: 17px; }
  .cxm-list-search-icon { width: 18px; height: 18px; margin-left: 10px; color: #8e98a9; }
  .cxm-list-search .cxm-search { min-width: 0; padding-left: 0; border-width: 0; background: transparent; }
  .cxm-list-search:focus-within { border-color: rgba(199, 204, 212, .65); outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-list-search .cxm-search:focus-visible { outline: 0; }
  .cxm-list-search-clear { width: 28px; height: 28px; margin-right: 3px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: #9fa8b8; cursor: pointer; }
  .cxm-list-search-clear[hidden] { display: none; }
  .cxm-search-match { padding: 0; border-radius: 2px; background: rgba(251, 191, 36, .25); color: inherit; }
  .cxm-search, .cxm-source-input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 11px;
    border: 1px solid rgba(255, 255, 255, .1);
    border-radius: 9px;
    outline: none;
    background: rgba(255, 255, 255, .045);
    color: #fff;
    font: inherit;
  }
  .cxm-search:focus, .cxm-source-input:focus { border-color: rgba(199, 204, 212, .65); }
  .cxm-search:focus-visible, .cxm-source-input:focus-visible { outline: 2px solid #c7ccd4; outline-offset: 2px; }
  .cxm-plugin-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 8px; margin-top: 12px; }
  .cxm-plugin-row {
    container-type: inline-size;
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    border: 1px solid rgba(255, 255, 255, .075);
    border-radius: 11px;
    background: rgba(255, 255, 255, .025);
    color: inherit;
  }
  .cxm-plugin-row:hover, .cxm-plugin-row:focus-within { border-color: rgba(199, 204, 212, .3); background: rgba(199, 204, 212, .07); }
  .cxm-plugin-primary { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; align-self: stretch; padding: 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; text-align: left; font: inherit; }
  .cxm-plugin-primary:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -3px; }
  .cxm-plugin-actions { display: flex; align-items: center; flex: none; gap: 2px; padding: 8px 8px 8px 0; opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .cxm-plugin-row:hover .cxm-plugin-actions,
  .cxm-plugin-row:focus-within .cxm-plugin-actions,
  .cxm-plugin-row[data-action-menu-open="true"] .cxm-plugin-actions { opacity: 1; pointer-events: auto; }
  /* One compact, rounded-square geometry for every Host icon action. It is
     deliberately not a circular affordance: native toolbar actions, close,
     overflow, and extension controls belong to the same control family. */
  .cxm-manager-icon-action, .cxm-plugin-icon-action, .cxm-plugin-menu-trigger {
    display: inline-grid; place-items: center; width: 32px; min-width: 32px; height: 32px; min-height: 32px; flex: none;
    box-sizing: border-box; border: 1px solid transparent; border-radius: 8px;
    background: transparent; color: #aeb5c3; cursor: pointer;
  }
  .cxm-manager-icon-action:hover:not(:disabled), .cxm-plugin-icon-action:hover:not(:disabled), .cxm-plugin-menu-trigger:hover { background: var(--cx-hover, rgba(199, 204, 212, .12)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action:focus-visible, .cxm-plugin-icon-action:focus-visible, .cxm-plugin-menu-trigger:focus-visible { outline: 2px solid var(--cx-focus, #c7ccd4); outline-offset: 1px; }
  .cxm-manager-icon-action:disabled, .cxm-plugin-icon-action:disabled { cursor: default; opacity: var(--cx-disabled, .34); }
  .cxm-manager-icon-action[aria-pressed="true"] { background: var(--cx-pressed, rgba(199, 204, 212, .2)); color: var(--cx-text, #eef0f4); }
  .cxm-manager-icon-action .cxm-host-icon { width: 17px; height: 17px; max-width: 100%; max-height: 100%; }
  .cxm-plugin-icon {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    flex: none;
    border: 1px solid rgba(199, 204, 212, .24);
    border-radius: 10px;
    background: rgba(199, 204, 212, .1);
    color: #d8dce3;
    font-size: 10px;
    font-weight: 800;
  }
  .cxm-plugin-icon > img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: contain;
  }
  .cxc-icon-seat[data-icon-kind="artwork"] > .cxm-plugin-icon { border: 0; background: transparent; }
  .cxm-plugin-body { min-width: 0; flex: 1; }
  .cxm-plugin-name { overflow: hidden; color: #f0f2f6; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-plugin-name-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxm-plugin-name-row > .cxm-plugin-name { min-width: 0; }
  .cxm-marketplace-trust-badges { display: inline-flex; flex: none; align-items: center; gap: 4px; }
  .cxm-marketplace-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxm-marketplace-title-row > .cxc-title { min-width: 0; }
  .cxm-marketplace-trust-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    border: 1px solid rgba(199, 204, 212, .18);
    border-radius: 999px;
    background: rgba(199, 204, 212, .075);
    color: #bfc6d2;
    font-size: 9px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
  }
  .cxm-marketplace-trust-badge[data-trust-dimension="official"] { color: #c9d9ff; }
  .cxm-marketplace-trust-badge[data-trust-dimension="certified"] { color: #c8f1dc; }
  .cxm-marketplace-trust-badge .cxm-host-icon { width: 12px; height: 12px; }
  .cxm-plugin-description { display: -webkit-box; margin-top: 4px; overflow: hidden; color: #818b9d; font-size: 10px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-plugin-meta { display: flex; min-width: 0; align-items: center; gap: 6px; margin-top: 4px; color: #7d8798; font-size: 10px; }
  .cxm-plugin-meta-version { flex: none; }
  .cxm-plugin-meta-source { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-status-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: #6b7280; }
  .cxm-status-dot[data-status="active"], .cxm-status-dot[data-status="loaded"] { background: #4ade80; }
  .cxm-status-dot[data-status="failed"] { background: #fb7185; }
  .cxm-status-dot[data-status="blocked"], .cxm-status-dot[data-status="loading"] { background: #fbbf24; }
  .cxm-status-dot[data-status="installing"], .cxm-status-dot[data-status="updating"], .cxm-status-dot[data-status="enabling"], .cxm-status-dot[data-status="disabling"], .cxm-status-dot[data-status="reloading"], .cxm-status-dot[data-status="uninstalling"], .cxm-status-dot[data-status="rolling-back"] { background: #60a5fa; }
  .cxm-status-dot[data-status="rollback-failed"] { background: #fb7185; }
  .cxm-lifecycle-overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: rgb(0 0 0 / 58%); }
  .cxm-lifecycle-dialog { width: min(460px, 100%); max-height: min(660px, calc(100vh - 48px)); overflow: auto; box-sizing: border-box; border: 1px solid #3b4048; border-radius: 14px; padding: 16px; background: #20242b; color: #edf0f4; font: 13px/1.45 system-ui, sans-serif; box-shadow: 0 24px 80px rgb(0 0 0 / 45%); }
  .cxm-lifecycle-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
  .cxm-lifecycle-dialog h2 { min-width: 0; margin: 0; font-size: 15px; line-height: 1.3; }
  .cxm-lifecycle-dialog p { margin: 6px 0 0; color: #bfc5ce; font-size: 12px; line-height: 1.45; }
  .cxm-lifecycle-impact { margin: 12px 0; padding: 10px 12px; border-radius: 9px; background: rgba(255,255,255,.05); color: #d7dbe3; }
  .cxm-lifecycle-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .cxm-directory-control { display: grid; min-inline-size: 0; grid-template-columns: minmax(0, 1fr) 32px; align-items: center; gap: 7px; }
  .cxm-directory-control > :first-child { min-inline-size: 0; }
  .cxm-directory-picker { width: 32px; height: 32px; }
  .cxm-local-import-dialog { width: min(420px, 100%); padding: 12px; }
  .cxm-local-import-dialog .cxm-lifecycle-header { min-block-size: 32px; }
  .cxm-local-import-form { min-inline-size: 0; gap: 12px; padding: 10px 0 0; }
  .cxm-local-import-field { display: grid; gap: 6px; min-width: 0; }
  .cxm-local-import-field .cxf-label { font-size: 12px; }
  .cxm-local-import-field[data-invalid="true"] .cxf-tdesign-control { border-color: var(--td-error-color); }
  .cxm-local-import-error { margin: 0; color: var(--td-error-color); font-size: 11px; line-height: 1.4; }
  .cxm-local-import-error[hidden] { display: none; }
  .cxm-local-import-actions { margin: 0; }
  .cxm-visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
  .cxm-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .cxm-detail-id { color: #747f91; font: 10px/1.3 ui-monospace, monospace; }
  .cxm-detail-description { max-width: 680px; margin: 14px 0 0; color: #a7afbe; font-size: 12px; }
  .cxm-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    padding: 7px 10px;
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 8px;
    background: rgba(255, 255, 255, .055);
    color: #f2f4f8;
    cursor: pointer;
    text-decoration: none;
    font: 11px/1.2 system-ui, sans-serif;
    gap: 6px;
  }
  .cxm-action-icon { width: 14px; height: 14px; }
  .cxm-action:hover:not(:disabled) { border-color: rgba(199, 204, 212, .5); background: rgba(199, 204, 212, .12); }
  .cxm-action:disabled { cursor: default; opacity: .45; }
  .cxm-action[data-tone="danger"] { color: #fecdd3; }
  .cxm-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; }
  .cxm-field { min-width: 0; padding: 10px; border-radius: 9px; background: rgba(255, 255, 255, .035); }
  .cxm-field-label { color: #737e90; font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .cxm-field-value { margin-top: 5px; overflow-wrap: anywhere; color: #cdd2dc; font-size: 11px; }
  .cxm-marketplace-trust-list { display: grid; gap: 9px; margin-top: 10px; }
  .cxm-marketplace-trust-item { padding: 12px 13px; border: 1px solid rgba(199, 204, 212, .16); border-radius: 10px; background: rgba(199, 204, 212, .045); }
  .cxm-marketplace-trust-title { display: flex; align-items: center; gap: 7px; color: #edf0f4; font-size: 12px; font-weight: 700; }
  .cxm-marketplace-trust-title .cxm-host-icon { width: 17px; height: 17px; }
  .cxm-marketplace-trust-copy { margin: 6px 0 0; color: #9da6b6; font-size: 11px; }
  .cxm-marketplace-trust-meta { margin-top: 7px; color: #7f899a; font: 10px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
  .cxm-marketplace-trust-evidence { display: inline-flex; margin-top: 8px; }
  .cxm-manager-inline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .cxm-code { max-height: 140px; margin: 6px 0 0; overflow: auto; color: #bac2d2; font: 10px/1.45 ui-monospace, monospace; white-space: pre-wrap; }
  .cxm-config-renderer { min-height: 2rem; }
  .cxm-readme { inline-size: 100%; max-inline-size: 96rem; box-sizing: border-box; color: var(--cx-text); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  .cxm-readme > :first-child { margin-top: 0 !important; }
  .cxm-readme > :last-child { margin-bottom: 0 !important; }
  .cxm-readme h1, .cxm-readme h2, .cxm-readme h3, .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { color: var(--cx-text); line-height: 1.25; }
  .cxm-readme h1 { margin: 0 0 16px; padding-bottom: 9px; border-bottom: 1px solid var(--cx-border); font-size: 24px; }
  .cxm-readme h2 { margin: 24px 0 12px; padding-bottom: 7px; border-bottom: 1px solid var(--cx-border); font-size: 18px; }
  .cxm-readme h3 { margin: 20px 0 8px; font-size: 15px; }
  .cxm-readme h4, .cxm-readme h5, .cxm-readme h6 { margin: 18px 0 7px; font-size: 13px; }
  .cxm-readme p { margin: 0 0 14px; color: var(--cx-text); }
  .cxm-readme ul, .cxm-readme ol { margin: 0 0 16px; padding-left: 24px; }
  .cxm-readme li { margin: 5px 0; }
  .cxm-readme .task-list-item { list-style: none; }
  .cxm-readme .task-list-item > input { margin: 0 7px 0 -20px; accent-color: var(--cx-primary); }
  .cxm-readme a { color: var(--cx-primary); text-decoration: none; }
  .cxm-readme a:hover { text-decoration: underline; }
  .cxm-readme blockquote { margin: 0 0 16px; padding: 0 14px; border-left: 4px solid var(--cx-border); color: var(--cx-muted); }
  .cxm-readme blockquote p { color: inherit; }
  .cxm-readme hr { height: 1px; margin: 22px 0; border: 0; background: var(--cx-border); }
  .cxm-readme table { display: block; inline-size: 100%; margin: 0 0 16px; overflow: auto; border-spacing: 0; border-collapse: collapse; }
  .cxm-readme th, .cxm-readme td { padding: 7px 11px; border: 1px solid var(--cx-border); text-align: left; }
  .cxm-readme th { background: var(--cx-hover); font-weight: 650; }
  .cxm-readme tr:nth-child(2n) td { background: color-mix(in srgb, var(--cx-hover) 48%, transparent); }
  .cxm-readme code { padding: 2px 5px; border-radius: 4px; background: var(--cx-hover); color: var(--cx-text); font: 11px/1.5 ui-monospace, monospace; }
  .cxm-readme pre { margin: 14px 0 18px; overflow: auto; padding: 14px 16px; border: 1px solid var(--cx-border); border-radius: 8px; background: color-mix(in srgb, var(--cx-surface-raised) 82%, #000); }
  .cxm-readme pre code { padding: 0; background: transparent; color: inherit; white-space: pre; }
  .cxm-readme pre code[data-shiki-theme] { display: block; }
  .cxm-readme-code-line { display: block; min-height: 1.45em; }
  .cxm-error { margin-top: 12px; color: #fda4af; font-size: 11px; }
  .cxm-catalog-list { margin-top: 12px; border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 15px 2px;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .cxm-catalog-row + .cxm-catalog-row { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-item + .cxm-catalog-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-catalog-row:hover .cxm-catalog-title { color: #fff; }
  .cxm-catalog-row:focus-visible { outline: 2px solid #c7ccd4; outline-offset: -2px; border-radius: 7px; }
  .cxm-catalog-icon { width: 32px; height: 32px; flex: none; color: #bfc5ce; }
  .cxm-catalog-icon svg { width: 21px; height: 21px; }
  .cxm-catalog-copy { min-width: 0; flex: 1 1 auto; }
  .cxm-catalog-title, .cxm-catalog-description, .cxm-catalog-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-catalog-title { display: block; color: #e7e9ee; font-size: 12px; font-weight: 650; }
  .cxm-catalog-description { display: block; margin-top: 3px; color: #858fa1; font-size: 11px; }
  .cxm-catalog-id { display: block; margin-top: 4px; color: #697386; cursor: text; font: 10px/1.35 ui-monospace, monospace; -webkit-user-select: text; user-select: text; }
  .cxm-catalog-status { display: inline-flex; min-width: 0; max-width: min(168px, 38%); flex: 0 1 auto; align-items: center; gap: 5px; overflow: hidden; color: #8f98a9; font-size: 10px; white-space: nowrap; }
  .cxm-catalog-status[data-tone="pending"] { color: #b8a574; }
  .cxm-catalog-status[data-tone="unavailable"], .cxm-catalog-status[data-tone="error"] { color: #d8948f; }
  .cxm-catalog-status-copy { overflow: hidden; text-overflow: ellipsis; }
  .cxm-catalog-status-icon { width: 14px; height: 14px; }
  .cxm-catalog-status-icon svg { width: 14px; height: 14px; }
  .cxm-kind-badge { padding: 3px 7px; border-radius: 6px; background: rgba(199, 204, 212, .09); color: #aeb6c5; font-size: 9px; }
  .cxm-route-section { margin-top: 18px; }
  .cxm-route-section:first-of-type { margin-top: 12px; }
  .cxm-route-section-heading { margin: 0; color: var(--cx-text); font-size: 13px; font-weight: 700; }
  .cxm-route-section-copy { margin: 4px 0 9px; color: var(--cx-muted); font-size: 10px; line-height: 1.45; }
  .cxm-route-group { overflow: hidden; border: 1px solid var(--cx-border); border-radius: 12px; background: var(--cx-surface-raised); }
  .cxm-route-group-item + .cxm-route-group-item { border-top: 1px solid var(--cx-border); }
  .cxm-route-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    box-sizing: border-box;
    padding: 13px 14px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
  }
  button.cxm-route-card { cursor: pointer; }
  button.cxm-route-card:hover { background: color-mix(in srgb, var(--cx-text) 5%, transparent); }
  button.cxm-route-card:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: -3px; border-radius: 10px; }
  .cxm-route-card-icon { display: grid; place-items: center; width: var(--cx-compact-list-icon-seat); height: var(--cx-compact-list-icon-seat); flex: none; color: var(--cx-muted); }
  .cxm-route-card-icon svg { width: var(--cx-compact-list-icon-glyph); height: var(--cx-compact-list-icon-glyph); }
  .cxm-route-card-body { min-width: 0; flex: 1 1 auto; }
  .cxm-route-card-title { display: block; overflow: hidden; color: var(--cx-text); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-route-card-description { display: -webkit-box; margin-top: 3px; overflow: hidden; color: var(--cx-muted); font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxm-route-machine { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; }
  .cxm-route-machine-item { display: grid; min-width: 0; grid-template-columns: max-content minmax(0, 1fr); gap: 5px; font-size: 10px; line-height: 1.4; }
  .cxm-route-machine dt { color: var(--cx-muted); }
  .cxm-route-machine dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--cx-text); font-family: ui-monospace, monospace; user-select: text; }
  .cxm-route-metadata-diagnostic { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-muted); font-size: 10px; line-height: 1.35; }
  .cxm-route-metadata-diagnostic .cxm-host-icon { width: 13px; height: 13px; flex: none; }
  .cxm-route-state { display: flex; min-width: 0; align-items: center; gap: 5px; margin-top: 7px; color: var(--cx-danger); font-size: 10px; line-height: 1.35; }
  .cxm-usage-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-item { padding: 12px 2px; }
  .cxm-usage-item + .cxm-usage-item { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-usage-header { display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 190px); align-items: center; gap: 12px; }
  /* The policy adapter is already an official TDesign Select. This layout
     seat must not borrow the native input chrome or it becomes a second
     visible border/background around the Web Component. */
  .cxm-usage-policy-select { inline-size: 100%; min-inline-size: 0; }
  .cxm-usage-identity { display: flex; min-width: 0; align-items: center; gap: 10px; }
  .cxm-usage-identity .cxm-plugin-icon { width: 32px; height: 32px; }
  .cxm-usage-resources { margin: 9px 0 0 42px; border-top: 1px solid rgba(255, 255, 255, .065); }
  .cxm-resource-row { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 4px 12px; padding: 8px 0; color: #8f98a9; }
  .cxm-resource-row + .cxm-resource-row { border-top: 1px solid rgba(255, 255, 255, .055); }
  .cxm-resource-title { color: #d3d8e1; font-size: 11px; font-weight: 600; }
  .cxm-resource-description { grid-column: 1; color: #858fa1; font-size: 10px; line-height: 1.4; }
  .cxm-resource-id { grid-column: 2; grid-row: 1 / span 2; align-self: center; color: #697386; font: 10px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; user-select: text; }
  .cxm-link-list { border-top: 1px solid rgba(255, 255, 255, .08); border-bottom: 1px solid rgba(255, 255, 255, .08); }
  .cxm-link-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 2px; }
  .cxm-link-row + .cxm-link-row { border-top: 1px solid rgba(255, 255, 255, .08); }
  .cxm-link-row-copy { min-width: 0; }
  .cxm-link-row-title { color: #d8dce3; font-size: 11px; font-weight: 650; }
  .cxm-link-row-value { display: block; margin-top: 3px; overflow-wrap: anywhere; color: #778295; font: 10px/1.4 ui-monospace, monospace; }
  .cxm-source-list { display: grid; gap: 8px; margin-top: 14px; }
  .cxm-source-row { display: flex; align-items: center; gap: 10px; padding: 11px; }
  .cxm-source-body { min-width: 0; flex: 1; }
  .cxm-source-url { display: block; overflow: hidden; color: #c6ccd8; font: 10px/1.35 ui-monospace, monospace; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
  .cxm-source-state { display: flex; align-items: center; gap: 6px; margin-top: 4px; color: #737e90; font-size: 10px; }
  .cxm-mini-action { padding: 5px 7px; border: 1px solid rgba(255, 255, 255, .09); border-radius: 7px; background: transparent; color: #99a2b2; cursor: pointer; font: 10px/1.2 system-ui, sans-serif; }
  .cxm-mini-action:hover:not(:disabled) { color: #fff; border-color: rgba(199, 204, 212, .4); }
  .cxm-mini-action:disabled { cursor: default; opacity: .35; }
  .cxm-console-warning .cxm-manager-icon-action, .cxm-console-inspector-head .cxm-manager-icon-action { color: inherit; }
  @media (max-width: 760px) {
    .cxm-backdrop { padding: 10px; }
    .cxm-dialog { grid-template-columns: 168px minmax(0, 1fr); width: calc(100vw - 20px); height: calc(100vh - 20px); }
    .cxm-card-grid, .cxm-detail-grid { grid-template-columns: 1fr; }
    .cxm-usage-header { grid-template-columns: minmax(0, 1fr); }
    .cxm-usage-header .cxm-usage-policy-select { width: 100%; }
    .cxm-usage-resources { margin-left: 42px; }
    .cxm-resource-row { grid-template-columns: minmax(0, 1fr); }
    .cxm-resource-id { grid-column: 1; grid-row: auto; }
    .cxm-console-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cxm-console-controls > input { grid-column: 1 / -1; }
    .cxm-console-action-toolbar { grid-column: 1 / -1; justify-content: flex-start; }
    .cxm-console-workspace[data-inspector="true"] { grid-template-columns: minmax(0, 1fr); }
    .cxm-runtime-status-facts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .cxm-catalog-row { gap: 8px; padding: 12px 2px; }
    .cxm-catalog-icon { width: 24px; height: 24px; }
    .cxm-catalog-status { max-width: 34%; }
    .cxm-route-card { gap: 9px; padding: 12px; }
    .cxm-route-machine { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .cxm-permission-item { grid-template-columns: minmax(0, 1fr); }
    .cxm-permission-control { justify-content: space-between; padding-inline-start: 35px; }
    .cxm-permission-control t-select { inline-size: min(100%, 13rem); }
  }
  @media (max-width: 520px) {
    .cxm-console-controls { grid-template-columns: minmax(0, 1fr); }
    .cxm-runtime-status { grid-template-columns: auto minmax(0, 1fr); }
    .cxm-runtime-status > .cxm-manager-icon-action { grid-column: 2; justify-self: start; }
    .cxm-runtime-status-facts { grid-template-columns: 1fr; }
    .cxm-console-action-toolbar { grid-column: 1 / -1; justify-content: flex-start; }
  }
`

export const HOST_THEME_OVERLAY_STYLES = `
  [data-cordisx-manager-modal], .cxm-lifecycle-overlay, .cxm-authorization-overlay { color: var(--cx-text); }
  .cxm-backdrop, .cxm-lifecycle-overlay, .cxm-authorization-overlay { background: var(--cx-backdrop); }
  .cxm-dialog, .cxm-lifecycle-dialog, .cxm-authorization-dialog { border-color: var(--cx-border); background: var(--cx-surface); color: var(--cx-text); box-shadow: 0 24px 80px var(--cx-shadow); }
  .cxm-sidebar { border-color: var(--cx-border); background: var(--cx-surface-raised); }
  .cxm-header, .cxm-about-actions, .cxm-about-action-item + .cxm-about-action-item, .cxm-flat-item + .cxm-flat-item { border-color: var(--cx-border); }
  .cxm-about-actions { background: var(--cx-surface-raised); }
  .cxm-nav-button, .cxm-heading p, .cxm-detail-description, .cxm-permission-reason, .cxm-copy, .cxm-source-state, .cxm-detail-id, .cxm-plugin-description, .cxm-plugin-meta, .cxm-catalog-description, .cxm-catalog-id, .cxm-catalog-status, .cxm-marketplace-trust-copy, .cxm-marketplace-trust-meta, .cxm-field-label { color: var(--cx-muted); }
  .cxm-heading-direct-title { color: var(--cx-text); }
  .cxm-nav-icon { color: currentColor; }
  .cxm-heading-leading { color: var(--cx-text); }
  .cxm-nav-button:hover, .cxm-nav-button[aria-current="page"], .cxm-nav-button[aria-selected="true"], .cxm-back:hover, .cxm-breadcrumb-action:hover, .cxm-breadcrumb-overflow > summary:hover, .cxm-tab:hover, .cxm-tab[aria-selected="true"], .cxm-about-action:hover, .cxm-about-action:focus-visible { background: var(--cx-hover); color: var(--cx-text); }
  .cxm-about-action-title, .cxm-about-action-copy { background: transparent; }
  .cxm-about-action-title { color: var(--cx-text); }
  .cxm-about-action-copy, .cxm-about-action-arrow { color: var(--cx-muted); }
  .cxm-about-action:hover .cxm-about-action-arrow, .cxm-about-action:focus-visible .cxm-about-action-arrow { color: var(--cx-text); }
  .cxm-heading-title, .cxm-breadcrumb-current, .cxm-card-value, .cxm-section-title, .cxm-about-name, .cxm-search, .cxm-source-input, .cxm-plugin-name, .cxm-catalog-title, .cxm-marketplace-trust-title, .cxm-field-value { color: var(--cx-text); }
  .cxm-card, .cxm-slot-card, .cxm-source-row, .cxm-field, .cxm-lifecycle-impact, .cxm-marketplace-trust-item, .cxm-marketplace-trust-badge { border-color: var(--cx-border); background: var(--cx-hover); }
  .cxm-search, .cxm-source-input, .cxm-action, .cxm-mini-action, .cxm-marketplace-filter { border-color: var(--cx-border); background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxm-close { background: transparent; color: var(--cx-text); }
  .cxm-close:hover { background: var(--cx-hover); color: var(--cx-text); }
  .cxm-action:hover:not(:disabled), .cxm-mini-action:hover:not(:disabled) { border-color: var(--cx-primary); background: var(--cx-hover); color: var(--cx-text); }
  .cxm-breadcrumb-menu { border-color: var(--cx-border); background: var(--cx-surface-raised); box-shadow: 0 12px 32px var(--cx-shadow); }
  .cxm-authorization-dialog > p, .cxm-authorization-reason, .cxm-authorization-choice { color: var(--cx-text); }
  .cxm-action[data-tone="danger"] { color: var(--cx-danger); }
  .cxm-notice { border-color: var(--cx-border); background: var(--cx-hover); color: var(--cx-muted); }
  .cxm-catalog-status[data-tone="pending"] { color: var(--cx-primary); }
  .cxm-catalog-status[data-tone="unavailable"], .cxm-catalog-status[data-tone="error"] { color: var(--cx-danger); }
  .cxm-required-badge { background: var(--cx-hover); color: var(--cx-primary); }
  .cxm-nav-button:focus-visible, .cxm-close:focus-visible, .cxm-tab:focus-visible, .cxm-action:focus-visible, .cxm-mini-action:focus-visible, .cxm-search:focus-visible, .cxm-source-input:focus-visible, .cxm-authorization-actions button:focus-visible { outline-color: var(--cx-focus); }
  .cxm-authorization-item, .cxm-authorization-actions button { border-color: var(--cx-border); }
  .cxm-authorization-actions button { background: var(--cx-surface-raised); color: var(--cx-text); }
  .cxm-authorization-actions button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); }
`
