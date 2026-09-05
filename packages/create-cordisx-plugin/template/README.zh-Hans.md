# {{packageName}}

一个最小的 CordisX 本地可信插件。插件清单由
`src/{{pluginId}}.tsx` 导出；该文件同时也是 CordisX 本地开发使用的入口。

```bash
{{packageManager}} install
{{packageManager}} run check
{{packageManager}} run dev:dry-run
{{packageManager}} run dev
```

`{{packageManager}} run dev:dry-run` 会在不启动 Codex Desktop 的情况下打包插件；
`{{packageManager}} run dev` 会启动独立的 CordisX 开发宿主。

`{{packageManager}} run build` 会在 `dist/` 中生成生产用 Vite ESM graph。固定入口
`module.js` 可以在 `import()` 实际触发后再加载带内容摘要的 JavaScript chunk、
CSS 和静态资源；Vite manifest 会记录完整产物图，`package.json#files` 会将
整个 `dist/` 纳入打包。生产 generation 仍是不可变包产物，不使用开发 HMR
连接。

`dist/manifest.json` 只是作者侧构建的 Vite 元数据，并不是正式的 CordisX
`artifact.json`，也不会复制到不可变存储根目录。可移植 CordisX package manifest
应把浏览器入口指向预构建的 `dist/module.js`；Host 验证相邻的完整 graph 后，会在
存储层生成自己独立的 `artifact.json`。

这个生成项目属于 [CordisX 独立插件例外](https://github.com/cordisx/cordisx/blob/main/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
定义的“已标记模板材料”。只要它保持为独立插件，并且只使用有文档、带版本的
CordisX 公共插件接口，就可以用于商业用途并采用你选择的许可证。发布前请将
`package.json` 中的 `UNLICENSED` 替换为所选许可证。该例外不包括复制或修改
CordisX Host、Runtime、CLI 代码，也不包括使用私有接口。
