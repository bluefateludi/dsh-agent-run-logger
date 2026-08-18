# Agent Run Logger

中文 | [English](README.md)

Agent Run Logger 是一个 DeepSeek Harness 插件，用于写入精简的本地 JSONL 追踪并提供实时只读 Viewer。它把 Session 事件转换为 Run、Step、模型和工具计时记录，但不替代规范 Session 日志。

默认情况下，每个 Session 分别写入 `<session cwd>/.dsh/traces/`。同一 Session 内保持源事件顺序，不同 Session 的写入队列独立并行。Viewer 增量索引这些文件，并展示 Session 父子关系、时间瀑布、事件详情、失败、Token 用量、记录缺口和截断值。

内容采集默认关闭。启用后，提示词、回复、工具参数和工具结果会先脱敏凭证类值，再按照配置的 UTF-8 字节上限截断并写入。

## 安装

直接从 npm 安装：

```sh
npm install dsh-agent-run-logger
```

把插件加入 DeepSeek Harness Profile：

```sh
dsh plugin --profile trace-demo add dsh-agent-run-logger
dsh --profile trace-demo --dump-config
dsh --profile trace-demo
```

组合包会加入下面的配置，用户可在 Profile Patch 中覆盖：

```yaml
- id: agent-run-logger
  name: dsh-agent-run-logger
  config:
    outputDir: .dsh/traces
    includeContent: false
    maxContentBytes: 65536
    maxPendingBytes: 4194304
    redactSensitiveContent: true
    redactKeys: []
```

`outputDir` 可以是绝对路径，也可以相对于每个 Session 工作目录。字节上限必须为正整数。`redactKeys` 可以向内置凭证键列表增加不区分大小写的对象键名。

## 查看追踪

在包含 `.dsh/traces` 的项目目录运行：

```sh
npx dsh-agent-run-logger view
```

命令监听 `127.0.0.1`，从 `4318` 开始选择端口并打开面板，不接受远程连接。

```text
用法：dsh-agent-run-logger view [参数]

  --trace-dir <path>       追踪目录，默认 .dsh/traces
  --port <number>          首选回环端口，默认 4318
  --poll-ms <number>       刷新间隔，默认 750
  --page-size <number>     每页记录数，默认 500
  --no-open                只输出网址，不打开浏览器
  --retention-days <days>  启动时删除过期的普通 JSONL 文件
```

未传入 `--retention-days` 时保留策略关闭，Viewer 的文件系统访问严格只读。数据、生命周期、隐私和 HTTP 行为见[可视化设计](docs/visualizer-design.zh.md)。

## 记录行为

Trace Schema 版本为 `1`。插件写入 `session.meta`、`run.start`、`run.end`、`step.start`、`step.end`、`llm.first_token`、`llm.end`、`tool.start`、`tool.end` 和 `trace.gap`。每条记录都包含 `sessionId`、`sourceSeq` 和 `time`。

Session 事件处理不会等待磁盘 I/O。每个 Session 默认拥有 4 MiB 的有界队列。队列溢出时丢弃新记录，并在之后用 `trace.gap` 报告缺失的源事件序号范围。目录、写入或同步失败只警告一次，并仅停用对应 Session Writer。

## 限制

- Logger 只观察启用后提交的事件，不回填规范 Session 历史。
- Subagent Session 保持独立文件。父子文件同时存在时 Viewer 可以根据 `parentSessionId` 导航，但不合并时间线。
- Viewer 只允许本地访问，不提供认证、远程导出、追踪上传、数据库或 OpenTelemetry 集成。
- 内容脱敏可以减少凭证意外落盘，但不能识别所有秘密；不需要内容时应保持 `includeContent: false`。
- `run.end` 和插件卸载会请求文件系统同步，但操作系统崩溃或断电仍可能丢失尚未同步的尾部记录。
- Trace 只用于诊断，不能替代 DeepSeek Harness 的规范 Session 日志。
