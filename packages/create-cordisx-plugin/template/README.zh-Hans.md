# {{packageName}}

一个最小的 CordisX 本地可信插件。插件清单由
`src/{{pluginId}}.tsx` 导出；该文件同时也是 CordisX 使用的运行时入口。

```bash
npm install
npm run check
npm run dev:dry-run
npm run dev
```

`npm run dev:dry-run` 会在不启动 Codex Desktop 的情况下打包插件；
`npm run dev` 会启动独立的 CordisX 开发宿主。

这个生成项目属于 [CordisX 独立插件例外](https://github.com/cordisx/cordisx/blob/main/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md)
定义的“已标记模板材料”。只要它保持为独立插件，并且只使用有文档、带版本的
CordisX 公共插件接口，就可以用于商业用途并采用你选择的许可证。发布前请将
`package.json` 中的 `UNLICENSED` 替换为所选许可证。该例外不包括复制或修改
CordisX Host、Runtime、CLI 代码，也不包括使用私有接口。
