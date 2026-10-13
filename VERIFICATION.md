# 插件验证记录

## 0.2.2：插件配置页的协议默认模式

日期：2026-10-13（Asia/Shanghai）。平台与开发依赖沿用下方 0.2.1 基线。

新增插件自己的 `plugins.bundle.config` 面板，以 `@oheco/dsh-service-tier` 为键，读取固定 Host 条目 `oheco-service-tier` 的公共 `configForms` 控制器。OpenAI 默认标准/快速/超快速，Anthropic 默认标准/快速；初始值都是标准。只有保存才一次提交两个字段，带编辑开始时的修订号；只读连接禁用编辑，失败保留草稿。没有新增全局设置页、配置保存 RPC、提供方、模型或凭据。

Host 导出原生 Schemastery Config，两个字段均为 `.volatile()`，并声明自有页面。模式解析实时读取引用，已有会话记录优先，缺记录时按实际协议选默认值。读取默认值不落会话记录；菜单再次点选当前默认模式会将其保存为显式选择。标准模式的设置不需要成功解析连接，即使配置了速度默认值而当前模型已移除，工具/命令仍可切回标准。

子会话在创建和补齐时复制父会话的有效模式，包含插件默认值；已有子记录不被默认修改、恢复或重载覆盖。离线父会话没有记录时，通过公共只读 Persistence handle 与 `foldRequestHeader` 重建最后连接，句柄在 finally 中关闭；两个默认均为标准时跳过该读取。

### 本次验证

`npm run check`、`npm test`、`git diff --check` 均通过，18 项测试全部通过。原有回归测试保留，新增/扩展内容包括：

- Config 合法档位、初始标准、本地化字段/选项以及 volatile schema 序列化。
- 两类实际协议默认、未知协议回到标准、默认读取不写记录、明确选择优先，包括显式标准与点选当前默认值。
- 同一请求对象保留快照；标题/压缩调用保持标准。
- 真实 AgentRegistry 的普通/fork 子会话继承父协议默认；子会话改协议仍保留继承档位；离线无记录父会话读取最后请求头，关闭只读句柄。
- 实际工具/命令在模型已移除且存在速度默认值时仍能保存标准。
- 安装版 Settings 服务投影两个字段；一次原子修改更新 live references，拒绝过期修订号与无效 Anthropic 超快速，并验证无部分提交、子记录和显式标准不被改写。
- OpenAI Responses、Chat Completions、Anthropic 的本地 HTTP/SSE 请求，验证未选择根会话按默认发送 wire 参数、辅助调用与明确标准没有速度字段。

Settings 服务和 AgentRegistry 使用安装版实现；配置编辑器、Session/Tools/Commands 使用隔离 fixture。Settings 写入测试验证服务边界与 live reference 更新，未实际写入用户 profile。服务器和临时目录在测试结束时清理，无付费模型调用。

### 交付边界

仅更新、提交和推送普通源码仓库。本次没有生成发行包、打标签、创建 Release、修改软件目录或升级当前插件安装，没有修改 DSH 核心。新增插件配置页的实际浏览器显示与保存交互尚未安装验收；远端账号权限、速度及计费未验证。

## 0.2.1：历史验证与安装记录

日期：2026-10-07（Asia/Shanghai）。平台：HarmonyOS aarch64，Node 24.21.0-ohos.1。DSH CLI 基线 `0.2.0-rc.2-ohos.1`，库 `0.2.0-rc.2`，pi-ai `0.87.1`。

### 问题及修复

0.2.0 只按 sessionId 存储模式。子 agent 创建新的会话，而 DSH 内建继承只复制模型等请求配置，不包含插件私有状态；因此缺少模式记录的子会话回到标准。

0.2.1 在真实 serial `agent/created` 生命周期中，通过子会话 header 的 `origin: subagent` 和 `parentSession` 复制父模式，等待持久化后才完成初始化。继承与用户切换共用队列，保存标准/快速/超快速的创建时选择，保留所有既有子记录。已存在的缺记录子会话在插件加载时补齐，Host 就绪等待补齐完成。父子之后分别操作，恢复和重载不会覆盖子模式；普通聊天分支不自动继承。

按用户要求恢复 OpenAI 超快速档。OpenAI Responses/Completions 的菜单和后端支持 `ultrafast`，最终 payload 使用 `service_tier: ultrafast`；Anthropic 只有标准/快速。若子会话继承 ultrafast 但改用 Anthropic，明确返回 `UNSUPPORTED_TIER`，不发送模型请求、不伪造 speed 参数、不自动降档。工具和命令从请求头的 config 读取当前 provider/model，可独立设置子会话模式。

协议参考：[OpenAI Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)。本机经代理成功读取官方 Markdown，确认 `service_tier: ultrafast` 和 Responses HTTP 支持。官方该指南主要描述 Responses；兼容 Chat Completions 连接是否接受相同字段，由其端点决定，未扩大为所有 OpenAI 模型均有 ultrafast 权限。

### 已验证

`npm run check` 通过，`npm test` 13 项全部通过：

- 安装版 AgentRegistry 的真实 serial 创建事件：普通/fork 子会话、孙级继承，announce 返回前模式已保存。
- 恢复子会话、插件卸载/重载、初次加载补齐、父 agent 离线时继承其持久化模式；子会话显式标准选择不会被父快速覆盖。
- 初始补齐完成后才报告插件就绪；测试曾发现此时序问题，已通过等待 optional agents 注入的初始化完成修复。
- 初始化和用户模式修改串行；注入延迟存储，验证持久化完成前继承操作不返回。
- 实际调用插件注册的工具和命令处理器，验证无需重新提供模型 ID 的子会话独立切换 fast/ultrafast，以及卸载清理。Session、Tools、Commands 是隔离 fixture，AgentRegistry 是安装版真实服务。
- 安装版 Connection 插件真实启动，服务由独立 sibling fiber 提供；真实签名 Cookie 和官方 HTTP bridge。未认证 401、不可信 Origin 403、错误 envelope 400；原 `/api/session/modelCatalog` 网关正常。
- Host 返回 OpenAI 三档列表，认证 RPC 保存 ultrafast；已有目录/配置、凭据引用不被改写。
- 真实 DSH JSON 数据域关闭/重开保留子会话创建时选择和修订号；旧 ultrafast 记录保持可读。
- OpenAI Responses/Completions 实际本地 HTTP/SSE 请求验证 fast、ultrafast、并发隔离、子会话 ultrafast、同请求重试快照。
- Anthropic 实际本地 HTTP/SSE 请求验证 speed fast、已有 beta 合并；ultrafast 明确拒绝且不发请求，手动改 fast 后正常。
- 原版 llm-pi-ai + LlmRuntime 标准请求对照，文件/图片降级投影、工具参数、助手消息 durable replay：去掉速度字段后请求体一致。
- 本地中转 HTTP 400 拒绝 fast/ultrafast 后，仅一次请求、选择保留，无标准重发。
- 测试上下文、服务器及 `$TMPDIR` 下自有目录在结束后清理，无用户配置/日志改写，无付费模型请求。

### 安装结果

安装包：`/data/storage/el2/base/haps/entry/cache/dsh-service-tier/oheco-dsh-service-tier-0.2.1.tgz`。

大小：17258 bytes。

SHA-256：`2920d7413e756bcd7fc3237267fd218dc9d191cfa897574e1d0043e0a56bb69b`。

已通过官方命令安装到当前 web profile：

```zsh
HTTPS_PROXY=socks5://127.0.0.1:10808 HTTP_PROXY=socks5://127.0.0.1:10808 dsh plugin --profile web add /data/storage/el2/base/haps/entry/cache/dsh-service-tier/oheco-dsh-service-tier-0.2.1.tgz
```

安装清单版本为 `0.2.1`；全部 10 个安装文件逐一核对，与已验证源码完全一致。安装器只提示一般 peer-dependency 警告，未报告失败。没有修改 DSH 核心源码或安装文件，没有启动替代 GUI。

### 2026-10-07 安装后的运行状态及边界

以下为该次安装时采样的状态，不代表后续进程状态。安装后的进程数据域仍为 `hostVersion: 0.2.0`、`hostReady: true`。须重启当前 DSH 并刷新原 GUI 才能载入 0.2.1；磁盘安装成功不代表 Host 已切换。

没有浏览器控制工具，菜单显示和真实浏览器操作待重启后验收。未发送用户付费模型请求，远端模型/账号/中转的 ultrafast 权限、价格和实际速度未验证。生命周期测试使用真实 AgentRegistry 与 Session-shaped fixture，没有启动真实付费 AgentLoop；已验证创建事件、持久化与各协议 wire 参数，未将其表述为用户真实子任务已验收。
