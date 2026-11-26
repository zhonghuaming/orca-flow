# Orca Flow

中文敏捷看板与 **Orca 原生四角色 Bot** 工作流。源码仓库：<https://github.com/zhonghuaming/orca-flow>。

## 工作方式

```text
工作区 + 看板目标 + 明确的验收标准
                 ↓ 单次原生 handoff
产品 Bot：需求、验收标准、原生 Run 与依赖任务
                 ↓
架构 Bot：方案与接口边界
                 ↓
开发 Bot：实现及测试证据
                 ↓
测试 Bot：对同一版本独立验收
```

产品 Bot 负责原生任务生命周期及跨角色交接。插件不启动供应商 CLI、不读取账号或凭据、不查询模型额度、不设置工具免确认，也不会创建或更改机器人。模型与工具权限由各个 Orca Bot 自身配置管理。

### 状态真实性

- **已投递**仅说明 Orca 返回了消息回执，不代表模型已执行。
- 产品 Bot 创建原生 Run，目标名称必须包含本次唯一 `Flow <id>:` 标记；四个原生任务名为 `[Flow product]`、`[Flow architect]`、`[Flow developer]`、`[Flow tester]`。
- “核对原生任务”只读原生运行与任务记录。四阶段均标记完成且附结果，才显示“已完成”；结果报告仍可独立复核，不保证自然语言报告本身正确。
- 超时、崩溃和缺失回执均保留**结果未知**；不会自动重发。请在原生运行中核对，不要新建流程冒充重试。正文写入等确定发生于投递前的失败会标为“失败”，不会永久占用工作区。
- 已结束运行可点“归档详细记录”：先将原始目标与当前证据记录保存到本机插件目录的 JSON 文件，再缩减面板历史；未知或未结束运行不能借归档解除占用。原生任务保留完整报告，面板结果按 UTF-8 字节预算展示摘要，避免长中文报告撑爆消息容量。
- 本插件的业务看板保存在独立插件存储中，任务状态由用户明确调整。打开原生看板不是把业务任务伪装成原生终端卡片。

## 首次使用

1. 在 Orca 打开目标项目/工作区。
2. 从插件侧栏打开 **Orca Flow**。顶部默认开启“自动跟随当前工作区”，切换项目或工作区时会自动定位；无法唯一匹配时不猜测、不默认选择列表第一项。手动选择目标会暂停跟随，可再次勾选恢复。编辑未提交表单时遇到上下文切换，会固定原目标保护草稿。
3. 在“原生机器人”中点击“发现本机机器人”。这只读取 Orca Bot 列表，不启动模型。
4. 将产品、架构、开发、测试绑定到**四个不同的已有 Bot**，保存绑定。暂停或缺失的 Bot 会阻止启动，不会轮转替换。
5. 按需创建迭代、史诗、任务与工作流模板；自定义名称、任务目标和说明保持原文。
6. 在“团队工作流”点击“准备启动”，核对路径、分支、角色与目标，再点击“发送给产品 Bot”。**这会启动真实 Bot 工作，可能消耗其所配置模型额度。**
7. 查看产品 Bot 的原生聊天及运行；在“运行记录”点击“核对原生任务”。自动发现只查最近 100 个 Run，如找不到，请输入产品 Bot 回报的准确 `runId`。

当前只支持本机四 Bot，非本机工作区会明确拒绝。启动时冻结宿主、工作区 ID、路径、分支和项目。产品 Bot 必须在真实目标位置操作，不能把提示词中的路径当作实际目录绑定；不确定位置就阻塞。插件刷新时会拒绝目标路径/分支/项目已变化的运行。四角色之间使用原生消息，不建立私有文件队列，不消费其他会话邮箱。

## 本地开发与离线验证

不需要前端构建或网络依赖。需要已安装的 Orca、Node.js；类型检查另需本机 TypeScript。

```text
orca plugin types E:/workspace/orca-flow --json
node --test E:/workspace/orca-flow/tests/*.test.mjs
node --test --experimental-test-coverage E:/workspace/orca-flow/tests/*.test.mjs
orca plugin test E:/workspace/orca-flow --json
orca plugin check E:/workspace/orca-flow --json
orca plugin validate E:/workspace/orca-flow --json
tsc -p E:/workspace/orca-flow --noEmit
```

- `plugin test` 运行本地假宿主/假 CLI，不发真实任务。
- `plugin check` 的 `empty` 和 `populated` 场景只使用假工作区与内存存储，不运行原生 CLI。
- `.orca/types` 由 Orca 生成，不应修改或提交。
- `artifacts/` 用于离线日志与截图，默认不提交，避免带出本机项目信息。
- `node --test` 的缺省临时探针在系统临时目录下创建并清理，不访问真实账号。

### 安全截图

窗口隐藏或最小化时，可使用离线场景截图，不触碰真实插件面板、存储或机器人：

```text
orca plugin shot E:/workspace/orca-flow --scenario populated --width 900 --out E:/workspace/orca-flow/artifacts/flow-wide.png --json
orca plugin shot E:/workspace/orca-flow --scenario populated --width 360 --out E:/workspace/orca-flow/artifacts/flow-narrow.png --json
```

### 加载

`orca plugin dev load E:/workspace/orca-flow --json` 会显示插件访问授权。首次加载须由用户确认本插件的 `trusted-worker` 执行与 `storage:own`、`workspace:read`、`workspace:write` 能力。Node worker 在本机用户身份运行，声明能力并不构成 Node 文件系统/进程沙箱。CLI 调用采用固定命令、参数数组、无 shell、超时限制，并清除继承的会话身份及远端选择环境。

Windows 默认使用当前安装的 `.../Programs/orca/resources/bin/orca.exe`；Orca 管理的环境优先使用 `ORCA_CLI_COMMAND`。其他系统默认 `/usr/local/bin/orca`，可由宿主环境提供准确的 `ORCA_CLI_COMMAND`，不要把它设置为 shell 命令串。

## 迁移边界

这是独立插件 ID `flow-native`、发布者 `zhonghuaming`，不会接管旧插件存储或复制旧账号信息。旧插件和保全快照不变；若需迁移既有业务任务，应单独提供可审查的显式导入流程，而不是静默搬迁凭据或改写已存任务。

旧版的账号隔离、供应商额度、自由 CLI flags、终端状态推测成功、五角色示例团队、私有团队聊天脚本均已从当前运行源码移除。保留并重新实现中文看板、迭代/史诗、任务关联、工作流目标与模板、原生看板入口和运行证据查询。未保留原供应商的账号和磁盘使用统计。

## 许可证与来源

MIT。Fork 自 [mqnoy/orca-antigravity-flow](https://github.com/mqnoy/orca-antigravity-flow)，保留原 LICENSE 和上游 Git 历史；2.0 起运行实现只使用 Orca 原生 Bots，不依赖原项目对应的供应商。历史版本说明仅为来源记录，不代表当前功能。
