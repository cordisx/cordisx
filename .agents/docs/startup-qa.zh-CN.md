# CordisX 启动问题自助排查

## 怎么知道 CordisX 为什么没有启动？

运行只读诊断：

```bash
npx cordisx@beta doctor
```

`ready` 表示 CordisX 已找到可用宿主并生成启动方案。`unavailable` 会说明缺少
什么，或哪一步无法解析。

## 需要先运行 setup 吗？

不需要。首次正常启动时，CordisX 会在需要时自动创建配置。

## 为什么命令里有 `@beta`？

当前可用的预发布版本位于 `beta` 通道。首个稳定版发布前，不带通道的 npm
包仍是包名占位版。

## Node.js 版本不支持怎么办？

CordisX 当前需要 Node.js 22.19 或更高版本。更新 Node.js 后重新运行启动命令。

## CordisX 找不到 Codex Desktop 怎么办？

请先安装 Codex Desktop。CordisX 会自动检查受支持的 macOS 应用位置。如果安装在
非标准位置，可使用[完整公测指南](getting-started.md#npm-beta-installation)中的高级启动选项。

## 升级后提示存在旧版启动锁怎么办？

先确认所选 app 和 profile 的所有旧版 CordisX `start`、`stop` 或 `restart`
命令都已退出，然后为本次变更命令添加一次 `--recover-startup`，例如：

```bash
npx cordisx@beta start codex default --recover-startup
```

该选项只会把所选 profile 的旧版锁转换为当前内核锁使用的启动隔离标记。CordisX
不会因为锁文件为空或创建时间较早就认定它已被遗弃，因为旧版 detached 启动进程
可能尚未写入状态。旧版 CordisX 命令仍在运行时不要使用该选项。

## 启动时提示 Codex profile 启动锁（launch lock）怎么办？

每个独立 Chromium profile 旁都有一个启动锁目录 `<profile>.cordisx-launch-lock`，
其中的 `owner.json` 记录持有它的启动器进程及其启动时间。正常的 `stop`、
`restart` 或启动器退出都会释放它。

如果该启动器已不存在（例如被 `kill -9`、崩溃或重启机器），且没有存活宿主、进程参数
可明确识别，下次启动会自动回收 v2 锁，并在 `host.log` 中写入 `reclaimed stale Codex profile launch lock`；
这种情况不需要手工清理。`--recover-startup` 与它无关：该选项只转换
`~/.cordisx/run/<app>/<profile>/` 下的旧版 `start.lock`。

出现以下提示时，启动仍会拒绝并保持现场不动、不删除任何内容：

- `in use by launcher process <pid>`：该启动器仍在运行。先停止它——后台实例
  用 `cordisx stop`，前台 `cordisx run` 直接结束——不要删除锁。
- `still used by process <pid>`：启动器已退出，但用该 profile 启动的宿主进程树
  仍在运行。先停止这些进程，再重新启动。
- `unrecognized launch lock` 或 `requires inspection`：owner 记录缺失、指向其他
  profile 路径，或进程身份无法核实。请检查提示中的锁目录，确认没有任何进程在
  使用该 profile 后再删除。
- `Legacy v1 locks require manual cleanup`：旧版回收器不遵守新互斥锁，必须先停止
  所有旧版 CordisX 启动器及使用此 profile 的宿主，再手工删除提示中的锁目录。
- `another launch or release operation`：等待当前启动或释放操作完成后重试。

不要删除 `<profile>.cordisx-launch-mutex`。包含空格、引号或后续参数等无法可靠还原的
进程参数会保守地阻止回收，即使该进程可能使用其他 profile；请先检查再手工清理。

回收规则见[启动器运行时参考](launcher-runtime.md#host-profiles-cleanup-and-skill-deployment)。
后台启动因上述任一原因失败时，`cordisx start` 和 `cordisx status` 会直接报告
该原因，而不是笼统的 supervisor 退出信息。

## 启动后需要重新登录吗？

默认启动会打开独立的 Codex 窗口，同时沿用已有账号、会话、项目和模型配置。
完全隔离宿主数据属于高级 profile 选项。

## CordisX 会覆盖我原来的 Skills 吗？

不会。默认启动使用 `shared` 数据模式，继续读取用户原有的个人 Skills 和当前
仓库中的 Skills。包含托管 Skills 的 CordisX 版本只会更新带有有效管理标记且
内容仍匹配的 CordisX 自有副本；未托管或被用户修改的目录会被保留并报告，不会
被静默覆盖。判断某个内置入口是否可用时，应以实际安装版本为准。

## `shared` 和 `host-isolated` 有什么区别？

默认的 `shared` 模式使用独立的 CordisX 窗口和 Chromium profile，但沿用当前
用户的 Codex 数据与个人 Skills。

`host-isolated` 会为这个 CordisX profile 使用独立的 Host home，因此不会读取
真实用户 home 中的个人 Skills；当前仓库中的 Skills 和实际安装版本内置的兼容
CordisX Skills 仍然可用。只有需要隔离账号、会话或其他宿主数据时才使用它：

```bash
npx cordisx@beta codex work --data host-isolated
```

## 启动后可以直接让 Codex 开发插件吗？

可以。直接用自然语言描述你想加入的功能即可，例如“我要发送按钮在点击时
全屏放礼花”。如果安装版本包含 `cordisx` 入口，从这个入口开始即可；它会选择
插件开发指导，不要求你手动挑选底层 Skill。它会按实际需求选择验证方式，不会
仅因文档或静态改动而启动原生 App。

## 在哪里查看常见使用疑惑和已知踩坑？

参见[用户经验 Q&A](user-experience-qa.md)。其中记录有适用条件和依据的经验，
并链接对应的规范文档，不会把单次事件直接写成通用产品规则。

## 在哪里查看完整启动选项？

profile、诊断、全局安装、外部 Provider 和高级启动模式见
[完整公测指南](getting-started.md#npm-beta-installation)。
