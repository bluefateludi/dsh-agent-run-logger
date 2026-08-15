# Agent Run Logger

中文 | [English](README.md)

Agent Run Logger 是一个 DeepSeek Harness 插件，为每个正在运行的 Session 写入一份精简的本地 JSONL trace。它把底层 Session 事件整理成 run、step、模型和工具的计时记录，比直接阅读完整会话日志更方便。

默认情况下，每个 Session 分别写入 `<session cwd>/.dsh/traces/`。记录会在 Agent 运行期间持续追加；同一 Session 内严格保持源事件顺序，不同 Session 的写入队列相互独立，可以并行落盘。

默认只记录元数据、标识符、耗时、结果状态和 token 用量，不记录提示词、回复、工具参数或工具结果。设置 `includeContent: true` 后才会记录这些内容。每项内容默认最多保留 64 KiB；超限 JSON 会转换为 UTF-8 安全的头尾预览，原始 Session 日志不会被修改。

事件处理不会等待磁盘 I/O。每个 Session 默认拥有上限为 4 MiB 的独立队列。队列满时会丢弃新 trace 记录，并在之后通过 `trace.gap` 记录报告缺失的源事件序号范围。目录创建、写入或同步失败时，插件只警告一次并停用对应 Session 的 writer，不会影响 Agent 和其他 Session。

## 从 tarball 安装

构建并打包插件，然后把生成的压缩包安装到一个 profile：

```sh
pnpm install
pnpm pack
dsh plugin --profile trace-demo add ./dsh-agent-run-logger-0.1.0.tgz
dsh --profile trace-demo --dump-config
dsh --profile trace-demo
```

组合包会加入下面的配置行，用户可在 profile patch 中完整覆盖它：

```yaml
- id: agent-run-logger
  name: dsh-agent-run-logger
  config:
    outputDir: .dsh/traces
    includeContent: false
    maxContentBytes: 65536
    maxPendingBytes: 4194304
```

`outputDir` 可以是绝对路径，也可以是相对于每个 Session 工作目录的路径。`maxContentBytes` 和 `maxPendingBytes` 必须是正整数，单位为字节。

## 记录类型

当前 schema 版本为 `1`。插件写入 `session.meta`、`run.start`、`run.end`、`step.start`、`step.end`、`llm.first_token`、`llm.end`、`tool.start`、`tool.end` 和 `trace.gap`。每条记录都包含 `sessionId`、`sourceSeq` 和 `time`。

## 限制

- 只观察插件启用后新提交的事件，不回填已有 Session 历史。
- 一个 turn 对应一个 run。Subagent Session 保持独立文件；`parentSessionId` 记录父子关系，但插件不会生成跨 Session 的完整调用树。
- 不提供查看器、查询 API、远程导出、OpenTelemetry 集成、文件轮转或保留策略。
- `includeContent: true` 可能把敏感信息写入磁盘。截断限制针对每项捕获内容，不限制整个 trace 文件大小。
- `run.end` 和插件卸载会请求文件系统同步，但操作系统崩溃或断电仍可能丢失尚未同步的尾部记录。
- trace 只用于诊断，不能替代 DeepSeek Harness 的权威 Session 日志。
