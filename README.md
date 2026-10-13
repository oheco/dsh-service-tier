# DSH 快速模式插件

源码仓库：[oheco/dsh-service-tier](https://github.com/oheco/dsh-service-tier)。本仓库记录源码、测试和文档，不配置自动打包或发布流程。

独立 DSH bundle，为**已有连接和已有模型**提供按会话保存的处理速度菜单：OpenAI 协议支持标准 / 快速 / 超快速，Anthropic 支持标准 / 快速。无需新增提供方、重新添加模型、重新填写 API Key 或逐模型配置能力。插件不改 DSH 核心源码和安装文件。

## 使用

安装后重启当前 DSH，再刷新 Web GUI。在原有模型选择器附近选择模式，从下一次模型请求生效。已有会话选择保留；尚未保存选择的会话使用插件配置页为其连接协议设置的默认模式，初始值均为标准。

参数由连接实际使用的协议决定，与模型名称无关：

| 连接协议 | 快速模式 | 超快速模式 |
| --- | --- | --- |
| OpenAI Responses | `service_tier: "fast"` | `service_tier: "ultrafast"` |
| OpenAI Chat Completions | `service_tier: "fast"` | `service_tier: "ultrafast"` |
| Anthropic Messages | `speed: "fast"`，合并 `anthropic-beta: fast-mode-2026-02-01` | 不提供 |

例如 Claude 模型通过 OpenAI 兼容中转连接使用时，发送 OpenAI 的参数。标准模式走原版处理链，不添加本插件的速度字段；其他协议走正常请求链且不显示速度菜单。

兼容协议不能证明具体模型、账号或中转站支持所选模式。对方拒绝参数时显示原有请求错误，插件不会自动降档或用标准模式重发；用户自行选择标准或其他支持的模式。OpenAI 官方 ultrafast 文档目前主要描述 Responses 接口；本插件也按相同字段给兼容 Chat Completions 连接提供该选项，是否接受由端点决定。快速和超快速可能采用更高价格。标题、压缩等标记为辅助用途的调用保持标准。

0.2.1 修复子 agent 继承：普通委派和 fork 委派创建的子会话，在首次运行前持久化父会话当时的模式。孙级会话同样继承。之后父、子分别保存自己的选择，父会话改档不追改已创建子会话；子会话可独立切换。恢复和插件重载不覆盖已有记录。旧版创建但从未设置过模式的子会话，会在加载或恢复时按父会话当前模式补齐；父 agent 离线时读取其持久化记录。普通聊天分支不属于委派子 agent，不自动复制模式。

子 agent 覆盖模型或协议时仍遵循它自己的连接协议。如果继承 ultrafast 后使用 Anthropic，会明确报不支持，并保留选择；请切为快速或标准，不会发送虚构的 Anthropic ultrafast 参数。

原来的独立连接配置卡片和独立模型目录已移除。旧 `ultrafast` 记录现在保留为超快速，修订号不变。旧插件专属连接配置不参与请求；原有 DSH 连接、凭据和模型配置不被改写。

## 插件默认配置

0.2.2 在侧栏 **插件 → 快速模式** 的插件详情页提供两个默认模式下拉框：

| 配置项 | 可选模式 | 初始值 |
| --- | --- | --- |
| OpenAI 默认模式 | 标准 / 快速 / 超快速 | 标准 |
| Anthropic 默认模式 | 标准 / 快速 | 标准 |

编辑后点击 **保存** 才写入。取消修改或离开页面会丢弃草稿。两个值通过 DSH 公共 `configForms` 服务一次提交，以编辑开始时的修订号检查并发修改；被拒绝时保留草稿并提示取消后重新编辑。只读连接不允许保存。配置归属本插件的 `Config`，持久化由 DSH 原生插件配置编辑器写入 profile 的 Cordis patch。

默认值按已有连接的实际协议解析，不依赖模型名称。保存后实时生效，无需重启插件；同一个已经开始的请求对象仍保留自己的模式快照。仅尚未保存模式的会话跟随默认配置，包括以前创建但一直没有选择模式的根会话。读取默认值不生成会话记录。通过菜单、工具或命令明确选择的模式优先，选择标准也会保存为覆盖；在菜单中再次点击当前默认模式同样会保存选择。

委派子 agent 在创建时保存父会话的**有效模式**，父会话没有明确选择时也包括其协议默认值。之后修改默认值或父模式，不覆盖子会话已保存的继承记录。父 agent 离线且没有模式记录时，通过公开的只读 Session Persistence 接口读取其最后请求头中的连接与模型；两个默认值均为标准时不需要读取父会话日志。

## 安装和卸载

仓库不提供发行包。以下为已有安装包的通用安装命令示例：

```zsh
dsh plugin --profile web add /absolute/path/to/oheco-dsh-service-tier.tgz
dsh plugin --profile web remove @oheco/dsh-service-tier
```

安装器成功表示包已安装到 profile；同名更新需要重启 DSH 和刷新现有 GUI。无需启动新的 GUI 服务器。

## 实现与兼容性

开发基线：DSH CLI `0.2.0-rc.2-ohos.1`、DSH 库 `0.2.0-rc.2`、pi-ai `0.87.1`。

- 用公共提供方目录和 settings 描述读取已有 pi-ai 路由配置，不注册任何 Host 提供方、目录或模型，不写入连接设置和密钥。
- `llm/stream` 标准分支直接调用 `next()`。快速和超快速分支复用原版 `PiAiAdapter` 和请求私有的 `LlmRuntime`，保留配置解析、附件投影、工具处理、错误转换和同一适配器族的回放归属。私有运行时的路由不会进入 Host 的模型目录。
- 模型配置继承安装版目录，保留 `modelOverrides`、`reasoningEfforts` 映射、headers、协议适用的 compat、缓存、传输和图片预算。认证沿用原有凭据引用和 pi-ai 凭据记录，包括原有授权刷新路径。
- pi-ai 原生 `onPayload` 在最终请求体中加入所选参数；Anthropic beta 标头与已有标头合并。不会修改冻结的 DSH 请求。
- `WeakMap` 固定同一请求对象的选择和配置；`AsyncLocalStorage` 隔离并发请求。会话选择由 `storageDomain` 持久化，并检查修订号。继承操作与用户切换共用写入队列，在 serial `agent/created` 监听器中等待持久化完成后才允许子 agent 开始运行；插件就绪也等待已存在子会话补齐。
- Client 只通过 React/ReactDOM 模块和公开插槽、语言、连接、`configForms` 服务工作。插件自己的配置表单注册于 `plugins.bundle.config`，只编辑两个 `.volatile()` 默认模式引用；不注册全局设置页面。菜单采用 DSH ModelSelect/MenuSurface 的布局、主题颜色、菜单材质和键盘模式，包含单选勾选、方向键、Home/End、Escape、Tab、焦点恢复、外部点击和视口定位；没有导入 DSH Client 控件包。
- RPC 使用 `/api/oheco-service-tier/*` 精确认证 POST 路由，保留唯一的 DSH `/api` 网关拦截器。Host 按协议返回可选档位，Client 使用该列表渲染。
- `/service-tier` 查询选择，`/service-tier fast`、`/service-tier ultrafast` 设置对应模式，`/service-tier standard` 或 `default` 切回标准。`service_tier` 工具与菜单调用同一后端操作，只操作当前会话，从会话请求头的 `config` 读取已有连接和模型，也允许显式指定。

## 验证

测试使用已安装 DSH runtime 提供的依赖，无需在本仓库下载依赖。需要支持 `node:module.registerHooks` 的 Node.js（验证使用 Node 24），并设置可写的 `TMPDIR`。测试 loader 默认引用开发机的 DSH 路径；在其他机器上，通过 `DSH_TEST_RUNTIME` 指定实际 runtime 目录：

```zsh
npm run check
DSH_TEST_RUNTIME=/absolute/path/to/dsh/runtime npm test
```

在原开发机上可直接运行 `npm test`。

18 项测试覆盖真实 Connection 插件和签名认证、严格服务注入、已有目录读取、会话隔离与冲突、旧记录兼容、真实 JSON 存储重开、三种协议的实际本地 HTTP/SSE 请求、原版标准请求对照、文件/图片降级投影、工具参数、助手消息回放、并发、请求快照、beta 标头合并和中转拒绝时不降档。

新增真实 AgentRegistry 生命周期测试验证普通/fork 子会话、孙级继承、初次加载补齐、恢复/重载保留覆盖、父 agent 离线时继承持久化选择，以及工具/命令独立切换。Session、Tools、Commands 使用隔离 fixture；未启动付费模型 agent。OpenAI HTTP 测试验证 fast/ultrafast 并发隔离、子会话 ultrafast、重试快照和拒绝后不降档；Anthropic 拒绝 ultrafast且不发请求。

默认配置测试验证本地化 schema、合法选项与初始值、实际协议的默认 payload、读取默认值不写会话记录、显式标准覆盖、实时修改后的请求快照，以及父模式来自默认值时的普通/fork/离线继承。安装版 Settings 服务测试验证两个字段出现在描述中、一次原子修改生效、过期修订号拒绝、无效 Anthropic 超快速不导致部分修改，以及保存记录不受默认更新影响；配置编辑器使用隔离 fixture，不写用户 profile。

测试服务器只在测试期间运行，使用系统分配端口；临时目录位于 `$TMPDIR`，结束后清理。测试不发送付费模型请求。本次 0.2.2 仅更新源码，未打包、发布或升级当前安装，新增配置页的实际浏览器显示与保存交互需安装该源码后验收；用户远端账号权限、实际速度和计费未验证。

协议来源：[OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)、[OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)、[Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode)。许可证：MIT。
