# 表单结构展示

这是一个仅用于开发环境的插件，通过 `cordisx.config.ui-demos.json` 加载。
它不注册导航项、路由、插槽、命令或插件自有 DOM。打开 CordisX 管理器，
选择 **Form Schema Gallery**，再进入 **配置管理**，即可查看由 Host 渲染的
TDesign 表单。

启动方式：

```bash
npm run dev -- dev --config cordisx.config.ui-demos.json
```

这个 Schema 覆盖输入框、多行文本、URL 与目录输入、必填与可选字段、数字步进器、
滑块、复选框、开关、Select、普通与分段 Radio、多选、TagInput、日期、时间和颜色。
它还覆盖对象数组的紧凑行、共享草稿对话框与页面模式请求、本地化标签与帮助文本、
校验边界、语义图标及禁用态说明。

该插件只使用隐私安全的演示数据，并声明 `plugin-restart`。它不声称拥有密钥、
凭据、外部连接或自定义渲染器。暂不支持的 Schema 形状由 Host 显示诊断信息，
不会被伪装成可用编辑器。
