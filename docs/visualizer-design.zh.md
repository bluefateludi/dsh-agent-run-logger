# 本地追踪可视化设计

中文 | [English](visualizer-design.md)

状态：已批准用于 `v0.2.0`

## 目标

Agent Run Logger 保持为一个 DeepSeek Harness 插件和一个 npm 包。`0.2.0` 增加本地只读 Web Viewer，但不会让日志记录依赖浏览器进程。Cordis 插件继续写入 JSONL，包内 CLI 读取这些文件并提供内置前端。

Viewer 回答四个问题：运行了什么、时间花在哪里、哪里失败以及子 Session 与父 Session 的关系。它用于诊断，不替代规范 Session 日志，也不是远程可观测平台。

## 用户体验

用户安装插件后，在项目目录启动 Viewer：

```sh
npx dsh-agent-run-logger view
```

命令读取 `.dsh/traces`，监听 `127.0.0.1`，从 `4318` 开始选择可用端口并打开浏览器。`--trace-dir`、`--port`、`--no-open` 和可选保留参数覆盖非默认用法。CLI 在开始服务前输出准确网址和追踪目录。

页面采用高密度“飞行记录台”风格：左侧 Session 导航，中间时间瀑布，右侧事件详情。顶部摘要显示运行数、失败数、模型耗时、工具耗时、Token、记录缺口和截断值。键盘导航和窄屏详情抽屉保证不依赖鼠标也能获得相同信息。

## 单包结构

npm 包提供两个入口：

- 现有默认导出继续作为 Cordis Logger 插件。
- `dsh-agent-run-logger` 命令提供 `view`、帮助和版本功能。

同一实现包含四个深模块：

1. `RunTraceProjector` 将 Session 事件转换为带版本的追踪记录。
2. `TraceRepository` 增量索引追踪文件，并响应摘要或分页记录查询。
3. `ViewerServer` 负责回环 HTTP、静态资源、Server-Sent Events 和完整清理。
4. 浏览器应用呈现仓库查询结果，不直接访问文件系统。

只有 `TraceRepository` 了解文件名、字节偏移、未完成行、异常行和追加检测。只有 `ViewerServer` 了解路由、响应头、Host 校验和 SSE 客户端。前端只依赖 JSON 响应字段，不依赖 Node 模块。

## TraceRepository 接口

外部接口保持精简：

```ts
interface TraceRepository {
  refresh(): Promise<TraceChangeSet>
  list(query?: SessionQuery): readonly SessionSummary[]
  detail(key: string): SessionDetail | undefined
  records(key: string, page: RecordPageRequest): Promise<RecordPage>
}
```

`refresh()` 检查目录元数据并只读取新增字节。内存仅保存摘要和各行的字节偏移，不保存全部完整记录。`records()` 只打开选中的一个文件，并读取请求范围内的记录。末尾不完整行保留到换行符出现。文件缩短或身份改变时重新索引。完整但格式错误的行生成诊断，不会遮蔽后续有效记录。

稳定 Viewer Key 使用经过校验的 base64url 文件名主体，不使用用户提供的路径。仓库绝不把未校验的请求值拼接到追踪目录。

Viewer 继续读取 Schema `1`。未知记录类型和新增字段保留在原始详情中，并显示为通用时间线事件。无法支持的 Schema 显示为不兼容 Session，不猜测其含义。

## 本地 HTTP 接口

服务只提供幂等读取：

- `GET /api/sessions` 返回过滤后的摘要和聚合统计。
- `GET /api/sessions/:key` 返回元数据、父子关系、诊断和 Run 摘要。
- `GET /api/sessions/:key/records?cursor=0&limit=500` 返回有界记录页。
- `GET /api/events` 推送 `snapshot`、`trace.changed` 和心跳事件。
- `GET /`、`/app.js` 和 `/styles.css` 返回内置前端资源。

JSON 错误包含稳定错误码和简短修正方法。记录页大小限制在配置上限内。实时数据禁用缓存，只有带版本的静态资源使用不可变缓存。

服务采用有界轮询，而不依赖跨平台行为不同的 `fs.watch`。同一时刻最多进行一次轮询，慢刷新不会与下次轮询重叠。SSE 分发隔离订阅者异常，浏览器断开不会影响索引和其他客户端。

停止时先关闭轮询和 SSE 注册表，再等待 HTTP Server 退出。CLI 只注册一次 `SIGINT` 和 `SIGTERM`，所有资源停止后才退出。

## 可视化模型

当父子追踪都存在时，Session 列表将子 Session 放在父 Session 下。缺失父级显示为明确的外部父级链接。Viewer 不合并文件，也不会捏造跨 Session 时间，只展示关系并允许在独立时间线间导航。

瀑布图根据稳定标识构建：

- `run.start` 和 `run.end` 形成 Run 区间。
- `step.start` 和 `step.end` 形成 Step 区间。
- `llm.first_token` 和 `llm.end` 显示首 Token 延迟和模型耗时。
- `tool.start` 和 `tool.end` 形成 Tool 区间，并独立显示并行调用。
- `trace.gap`、异常行、不完整事件对和截断内容显示警告标记。

未结束区间延伸到最新追踪时间并显示实时状态。缺失或负数耗时不会产生负几何尺寸。原始时间戳和已记录耗时保持可见，使派生图形可以核对。

## 隐私与安全

Viewer 只监听 IPv4 或 IPv6 回环地址，`v0.2.0` 不支持远程监听。服务校验 Host 必须匹配回环名称和实际端口，不发送宽松 CORS 响应头，并设置严格 Content Security Policy。

静态文件路由使用封闭资源表。Trace Key 只接受 base64url 字符。浏览器使用文本节点呈现追踪值，不把追踪内容写入 HTML。

内容采集默认关闭。存在内容时，详情默认折叠并显示敏感信息提示。脱敏发生在持久化之前，而不是只在界面隐藏。默认脱敏凭证类对象键和常见授权 Token 字符串，部署可以增加键名；截断在脱敏之后执行。

保留策略为显式开启。`--retention-days` 只删除已解析追踪目录中超过期限、类型为普通文件的 `.jsonl`；命令报告每次删除，拒绝符号链接和 Junction，并且不递归删除目录。没有保留参数时，Viewer 严格只读。

## 配置

Logger 新增：

- `redactSensitiveContent`：内容采集开启时默认 `true`。
- `redactKeys`：额外的不区分大小写对象键名。

Viewer CLI 提供：

- `--trace-dir <path>`：默认为当前目录下 `.dsh/traces`。
- `--port <number>`：默认从 `4318` 开始查找。
- `--poll-ms <number>`：默认 `750`，并设置安全下限。
- `--page-size <number>`：默认 `500`，并设置硬上限。
- `--no-open`：禁止启动浏览器。
- `--retention-days <number>`：默认不存在。

能够在启动前判断的错误配置必须在监听端口前失败。

## 失败行为

追踪目录不存在时显示空面板，并持续轮询等待目录创建。权限错误和异常追踪文件同时显示在 CLI 与面板诊断中，不终止健康 Session。端口冲突会在一个小而确定的范围内继续选择，再给出包含修正方式的错误。浏览器启动失败时输出网址并保持服务运行。

Viewer 永远不改变 Agent 的执行。Logger 写入失败仍然只隔离对应 Session；Viewer 的读取或渲染失败不能禁用记录。

## 验证

单元测试覆盖增量 UTF-8 读取、不完整行、文件缩短和替换、异常行、Schema 拒绝、分页、父子关系、脱敏、路由校验、Host 校验、SSE 上限和断开、启动竞态及幂等清理。静态 UI 检查确保 JavaScript 引用的 DOM 节点都存在于打包 HTML 中、资源保持本地自包含，并且追踪呈现不使用 HTML 注入 API。

发布冒烟检查从已安装的 tarball 启动构建后 CLI，请求真实 HTTP 路由，并在终止后确认没有遗留监听端口。交互式浏览器 QA 验证 Session 列表、瀑布图、筛选、键盘选择、警告状态、响应式详情抽屉以及类 HTML 内容的安全呈现。

打包验证在空目录安装生成的 tarball，运行 `dsh-agent-run-logger view --no-open`，请求面板，并确认原有 Cordis Logger 测试仍能记录完整追踪。正式发布后，对 npm 版本重复相同的冒烟检查。

## 交付和验收

实现继续位于 `dsh-agent-run-logger`，版本发布为 `0.2.0`。本版本不包含配套 npm 包、远程采集器、认证系统、数据库、追踪上传或 OpenTelemetry 导出。

满足以下条件即完成：空环境通过 npm 安装后可以记录追踪并启动 Viewer；历史和新增记录无需完整重读文件即可显示；父子 Session 可以导航；敏感内容默认折叠并在落盘前脱敏；非回环 Host 无法访问服务；停止时所有自有进程和连接全部退出；GitHub 与 npm 产物通过相同的全新安装冒烟测试。
