# dsh-mimo-context

MiMo Code 风格的「无限上下文」移植插件（DeepSeek Harness 0.2.2-rc.1）。

第二轮实现已按 MiMo Code v0.1.16/main 源码逐项对齐：checkpoint 触发阶梯、writer 覆盖边界与 watermark、11 段 checkpoint / 4 段 MEMORY、rebuild-context 的注入顺序与 caps、recent user / activity digest / unanswered messages、rebuild-first + ordinary compaction fallback、session/project/global 记忆布局、dream/distill 的 opt-in 与首次运行 gate。逐项对照与不可移植差异见 [MIMO-FIDELITY.md](docs/MIMO-FIDELITY.md)。

## 它做什么

1. **提前写结构化状态**：按 MiMo 的窗口阶梯（≤200K 为 20/40/60/80%；≤500K 每 10%；>500K 每 5%）在后台写 `checkpoint.md`（11 段）和项目 `MEMORY.md`（4 段），并维护 `notes.md`、`tasks/<id>/progress.md`。
2. **重建窗口**：在 DSH 原生 compaction 之前，用真实 compaction 事务把整个可见窗口替换为一份 MiMo `renderRebuildContext` dump（tasks / checkpoint / recent user / 项目+全局 memory / notes / memory index / recent activity / seam framing / tail reminder），并把未回复用户消息原文复制到 boundary。
3. **重建优先，压缩兜底**：只有「没有可用 checkpoint 且 writer 失败 / 写入被禁用」时才走 MiMo 五段式 ordinary compaction；有 checkpoint 但插入失败时禁止 compaction（与 MiMo 一致）。原生 DSH compaction 仍是最后兜底。

## 安装

```powershell
# 用该 DSH 安装自带的 0.2.2 CLI（不要用全局旧版 dsh）
dsh plugin --profile desktop add file:D:\path\to\dsh-mimo-context\plugin
```

`dsh plugin add` 会同时写入依赖与 bundle 行（本包的 `dsh.bundle.patch` 自动挂载 `mimo-context` 行）。重启 DSH 后生效。`dsh --profile <p> --dump-config | Select-String mimo-context` 可确认组合。

## 配置

在 profile 的 `cordis.patch.yml` 中用同名 id 覆盖：

```yaml
- id: mimo-context
  config:
    # MiMo 开关
    checkpointEnabled: true        # false = 不 checkpoint/rebuild，直接 compaction
    memoryWrite: true              # false = 不写任何新 memory，rebuild 短路为 compaction
    injectOnStart: false           # MiMo 默认不自动注入 memory 内容；仅调试/迁移用
    injectMemoryInstructions: true # 注入 MiMo 的 memory system 说明（DSH 无 system-prompt 接缝，用一次性 reminder 代替）
    fallbackCompaction: true       # 无 checkpoint + writer 失败时执行 MiMo 五段式 compaction

    # checkpoint 阶梯（MiMo prune.ts）
    checkpoints: null              # null = 动态阶梯；也可 ["10%", ...] / [50000, ...]
    checkpointDensity: mimo        # mimo | simple(20/40/60/80)
    checkpointReserved: 13000      # 阈值 clamp/drop 的 reserved

    # rebuild 触发（DSH 原生触发线 - margin）
    rebuildTriggerTokens: null     # null = auto
    rebuildMarginTokens: null      # null = max(8192, 1% window)
    rebuildCooldownMs: 30000

    # writer 覆盖边界（MiMo computeBoundary）
    tailMinTokens: 10000
    tailMaxTokens: 20000
    tailMinTextBlockMessages: 5

    # 等待边界（MiMo 30s / 5min / 180s / 300s）
    existingCheckpointWaitMs: 30000
    firstCheckpointWaitMs: 300000
    writerWaitMs: 180000
    manualRebuildWaitMs: 300000

    # 重建注入 caps（MiMo checkpoint.push_caps）
    pushCaps:
      tasksLedger: 2000
      actorLedger: 500
      memoryTitles: 500
      global: 6000
      checkpoint: 11000
      memory: 10000
      notes: 6000
      recentUser: 16000
      recentUserPerMsg: 2000

    # writer 模型/预算/后端
    writerProvider: ''             # 空 = 跟随当前路由
    writerModel: ''
    writerBackend: direct          # direct(默认) | tools | auto | subagent
    writerToolRounds: 6            # tools：插件内 writer read/write/edit 循环的最大轮次
    writerSubagentProvider: fork   # auto/subagent 时用 fork | spawn
    writerSubagentPreset: ''       # 可选：spawn 专用 writer preset（读工具即可，禁止写工具）
    writerSubagentFallback: true   # auto：子代理失败时回退单次直连 writer
    writerMaxTokens: 24000
    writerTimeoutMs: 300000
    writerInputTokenLimit: 120000

    # 存储
    storageDir: ''                 # 默认 <DSH_HOME>/mimo-context
    storage:
      layout: mimo                 # mimo(session/project/global) | workspace(旧版单目录)
      workspace: false
      maxCheckpointBytes: 200000
      maxMemoryBytes: 120000
      maxNotesBytes: 200000

    # dream/distill（MiMo 默认 opt-in）
    dreamAuto: false
    dreamIntervalDays: 7
    distillAuto: false
    distillIntervalDays: 30

    debug: false
```

### 触发数学

DSH 原生 compaction 触发 `N = floor(min(0.8W, W − O − 65536))`，本插件 rebuild 线 `R = N − margin`（默认 margin=`max(8192, 1%W)`）。MiMo 的所有 checkpoint 阶梯/百分比都基于这个 `R`（等价于 MiMo 的 `usable()`），但必须比 DSH 原生早一步，否则原生会先触发。显式 `rebuildTriggerTokens` 高于 `N` 时可能被原生抢占，建议保持默认。

## 记忆布局

```
<root>/sessions/<sessionID>/checkpoint.md    # writer-only
<root>/sessions/<sessionID>/notes.md         # main agent 可写
<root>/sessions/<sessionID>/tasks/<TID>/progress.md
<root>/sessions/<sessionID>/.prev/           # 上一版 checkpoint/MEMORY
<root>/sessions/<sessionID>/meta.json        # generation / writerCalls / rebuilds / watermark
<root>/projects/<sha1(cwd)[:16]>/MEMORY.md   # 项目级，跨 session
<root>/projects/<sha1(cwd)[:16]>/skills/     # distill 产物
<root>/global/MEMORY.md                      # 全局，只读，不自动创建
```

`storage.layout: workspace` 可恢复旧版单目录布局；首次使用新布局时会把旧 `workspaces/<hash>` 数据复制到 session/project 目录。

## 工具

| 工具 | 作用 |
|---|---|
| `mimo_context_status` | 压力、窗口、原生/rebuild 线、MiMo 阈值、session/project 目录、watermark、writer/rebuild 计数、开关 |
| `mimo_memory_read` | 读 checkpoint / project MEMORY / global MEMORY / notes / tasks |
| `mimo_memory_write` | 写 notes（replace/append；`memoryWrite=false` 时拒绝） |
| `mimo_memory_search` | FTS5 搜索（+0.15 relative floor；失败回退关键词） |
| `mimo_history_search` | 用 DSH `ctx.sessionQuery`（SQLite FTS5）搜索持久的 session 历史，对应 MiMo 的 history/trajectory 检索 |
| `mimo_task_progress` | 写 tasks/<id>/progress.md |
| `mimo_checkpoint` | 立即跑 writer |
| `mimo_rebuild` | 排队 rebuild（下一次 pre-step 执行） |
| `mimo_dream` | 合并项目 MEMORY |
| `mimo_distill` | 生成项目 skill |

## 命令

`/mimo-status`、`/mimo-checkpoint`、`/mimo-rebuild`、`/mimo-compact`、`/mimo-memory [search <q>]`、`/mimo-history [all] <q>`、`/mimo-dream`、`/mimo-distill [focus]`。

## 行为摘要

- **memory system prompt**：首次 `agent/created` 时通过 DSH `ctx.systemPrompt.section` 注册 scoped 的 MiMo memory-system 段（真实路径、active-recall protocol）；DSH 无接缝的旧版本回退为一次性 user reminder（`injectMemoryInstructions`）。
- **任务 ledger**：优先读取 DSH 的 `todo/write` 会话投影（content+status，最接近 MiMo task DB），无 todo 时回退 `tasks/<id>/progress.md`。
- **Active actors**：用 `ctx.agents.list()` 过滤当前 session 的直接子代理，渲染 MiMo 的 Active actors 段。
- **history recall**：`mimo_history_search` / `/mimo-history` 调用 DSH `ctx.sessionQuery` 的持久 SQLite FTS5，覆盖 rebuild 后旧消息的逐字召回。
- **writer**：默认 `writerBackend=direct` —— 单次 `ctx.llm.stream()`，输入是 `computeWriterWatermark` 之前的对话（`trimWriterMessages` 裁到 `writerInputTokenLimit`，最近 10–20K 尾部留给 rebuild dump）+ 当前记忆文件，输出 tagged `<mimo-checkpoint>`/`<mimo-memory>` blocks。`writerBackend=tools` —— **插件内受限工具循环**：`writer_read`/`writer_write`/`writer_edit` 只作用于内存里的 checkpoint/MEMORY/notes 三个 buffer（任何其他 path 拒绝），最多 `writerToolRounds` 轮，循环结束校验后仍由 `store.writeCheckpoint` 唯一写盘；用 `touched` 记录真实成功的写操作，所以「重写为相同内容」也算 writer 成功（仍推进 watermark），失败回退 direct。`writerBackend=auto|subagent` —— fork/spawn **tagged-text 子代理**：只读、**禁止 write/edit/bash**（插件是唯一写盘者，负责 lock/CAS 和 `.prev`），fork 分支序列化当前 in-flight turn，spawn 分支再加 covered prefix，两者都裁到 `writerInputTokenLimit`；`auto` 下子代理失败/服务缺失回退 direct。所有 writer 成功后 notes.md 无条件重置为模板（MiMo drain 语义）。硬约束：§1 verbatim、exact-form literals、§4 只能用 ledger 中 ID。
- **rebuild listener 顺序**：`agent/pre-step` 与 `agent/request-error` 都用 `{ prepend: true }` 注册，抢在原生 `dsh-compaction-basic`（先 compact 再 next）之前，保证 rebuild-first 语义真实生效。
- **dump 信息口径**：recent user / activity 只扫当前 surface，且限定 `seq >= watermark`；shadowed（被 replace 的）旧历史和 inbox splice 不会重新进入 dump。activity digest 从 surface 上的 `assistant/message` 里提取 `tool-call` blocks（DSH 的 `tool/call` 行不是 surface 节点）。
- **pending inbox**：pre-step claim 的消息会在 rebuild 完成**之后**由 agent loop append 到新 boundary 之后，因此**不**拷进 dump（避免双份）。
- **watermark**：writer 成功才推进 `lastCheckpointSeq`；失败保留旧 checkpoint（staler, never missing）。
- **rebuild**：`compaction/start → summary → user/message(surfaceOp.replace, replaceAll) → end`；dump 顺序/caps 与 MiMo 一致；unanswered user 全文复制；recent activity 从 watermark 之后统计；不递归吸收旧 boundary。
- **decisions**：`rebuilt` / `writer-failed` / `memory-write-off` / `checkpoint-off` / `insert-failed` 五态与 MiMo 一一对应；只有前三种允许 fallback compaction，`insert-failed` 禁止。
- **ordinary compaction**：MiMo 五段 continuation summary + `<conversation-summary trigger=...>` + 5 文件 `<files-touched>` manifest；手动 `/mimo-compact`、自动阈值、provider overflow 三种 trigger。
- **overflow**：`CONTEXT_WINDOW_EXCEEDED` → rebuild-first；无可用 checkpoint 才 fallback compaction；成功后 retry。
- **switch**：`checkpointEnabled` / `memoryWrite` 与 MiMo `MIMOCODE_DISABLE_CHECKPOINT` / `memory.disable_write` 对齐。
- **dream/distill**：默认不自动；auto 时首次运行按项目年龄 gate、10s 最小间隔；`memoryWrite=false` 时全部跳过。

## 与 MiMo 的已知差异

- writer 默认 `direct`；`tools` 是**插件内**受限工具循环（内存 buffer + 路径白名单，不建 child session）；fork/spawn 子代理是**显式 opt-in 的 tagged-text writer**，不写盘。fork 没有 runtime 工具白名单，且 DSH fork seed 只含父代理已完成 turns（长工具 turn 内常为空），也做不到 watermark 切片——所以它不提供 MiMo `checkpoint.fork` 的 prefix-cache 收益，只作为「隔离上下文执行器」。
- fork/spawn 子代理会留下 durable child session（DSH 的 session 模型如此）；它们是 subagent origin，主 session 不受影响。
- rebuild 的 shrink guard 与 DSH 原生 compaction 同口径（`estimateMessage` vs shadowed route tokens）；插件在提交前用 `previewRebuildFit` 预检，放不下时缩放**非 checkpoint** caps 重渲染（最多 2 次），仍放不下才 insert-failed，避免窄窗口直接丢弃 rebuild。
- rebuild 用 DSH compaction 事务替换整个窗口，而不是「追加 boundary + 过滤」；语义等价，旧事件仍保存在 session 日志，并可用 `mimo_history_search` 召回。
- task ledger 用 DSH `todo_write`（content+status，无 ID/树）或 progress 文件，不是 MiMo 的 task DB；无父/子 task 关系。
- memory 文件搜索仍是临时 FTS5；session history 搜索使用 DSH 的持久 `session-query-sqlite`。
- MiMo 的 prune 在 v0.1.16 已移除；DSH base 自带 `dsh-compaction-tool-result-pruner`，不需要插件复制。
- 没有 MiMo 的 actor 文件权限层；project MEMORY 用 `.MEMORY.lock` 串行化短写入 + 读改写 CAS（另一 session 已更新时保留新 body），不是所有权系统。
- claimed inbox 消息在 pre-step 后由 agent loop append 到新 boundary 之后，dump 不拷贝它们（否则双份）；dump 的 recent user / activity 只读 surface 且 `seq >= watermark`。
- 默认阶梯在 1M 窗口有 18 个 writer/窗口；成本敏感时用 `checkpointDensity: simple` 或显式阈值。

## 验证

```powershell
cd dsh-mimo-context
node --test tests/unit.test.mjs
cd test-harness
node run-headless.mjs --profile mimo-e2e --tool-turns 14 --log-dir ..\e2e-final25
# tools-loop writer：在 profile cordis.patch.yml 临时设 writerBackend: tools
node run-headless.mjs --profile mimo-e2e --tool-turns 14 --log-dir ..\e2e-final24
# provider overflow（fake + 注入 400 的代理）
node run-overflow.mjs --profile mimo-overflow --trigger-at 8 --log-dir ..\e2e-overflow-final
cd ..\e2e
node verify-e2e.mjs <session.v4.jsonl.zstd> --memory <session dir> --log ..\e2e-final25
```

见 [REPORT.md](docs/REPORT.md) 与 [MIMO-FIDELITY.md](docs/MIMO-FIDELITY.md)。

## License

MIT。



