# MiMo Code → dsh-mimo-context 行为对照

本文是源码对照 + 功能移植的产物：逐项对照 `XiaomiMiMo/MiMo-Code`（main ≈ v0.1.16）的实现，说明插件现在**做了什么、为什么这样做、哪些差异是 DSH 0.2.2 接缝限制，哪些差异是用户确认可接受的功能等价取舍**。所有 MiMo 侧结论均来自 `research/_src/` 中保存的源码（路径在每节标注）；DSH 侧来自本仓库插件与真实 0.2.2 e2e。

## 1. 触发线：checkpoint 阶梯 + reserved

| MiMo（`packages/cli/src/session/prune.ts`、`overflow.ts`） | 插件 |
|---|---|
| `usable() = floor(effective × 0.9)`（`MIMOCODE_COMPACTION_TRIGGER_RATIO`，v0.1.16 起不再减 reserved） | 用 DSH 原生触发线的前一步 `R = N − margin`（`N=min(0.8W, W−O−65536)`）作为 MiMo `usable` 的等价物；因为插件必须比 DSH 原生 compaction 早一步，否则会被原生抢占 |
| 默认阶梯：`window<25K→[]`；`≤200K→20/40/60/80%`；`≤500K→10..90%`；`>500K→5..90%`（18 个） | 完全相同的 `defaultThresholdsFor()`，百分比乘 `R` |
| `CHECKPOINT_RESERVED=13000`；`maxAllowed=window−reserved`；第一个超限项 clamp、后续丢弃；`maxAllowed<=0` 报错 | 完全移植：`resolveThresholds()` + `checkpointReserved`（默认 13000），保留用户输入顺序（顺序影响 clamp 哪一个） |
| `crossed` 集合按 session；writer 正在跑时**不消费** crossed，下一次迭代可重试 | 同样：writerRunning 时 `fireCheckpoints` 直接返回，不标记 crossed |
| 只有**最后一档**允许在可重试失败后二次触发；gate = `min(firedAt + step, maxAllowed)`，按 token 位置而非失败计数 | 已实现：writer settled 且 `retryable` 才 arm `finalRetryAt`；下一次压力越过 gate 才重发最后一档 |
| 重建后 `resetThresholds()` 清空 crossed + finalRetryAt | 每次 successful rebuild/fallback 后 `resetLadder()` |
| 只对 main/peer 生效；子代理走 per-actor compaction，system writer 不触发 | `mainOnly` 默认跳过带 `parentAgent` 的子代理；子代理由 DSH 原生 compaction 处理（等价于 per-actor compaction） |
| 阈值在每次 runLoop **完成后**按最新 assistant usage 触发 | 插件在每次 `agent/pre-step` 按 token meter 压力触发（效果相同：mid-turn 增长即可触发） |

> 差异：MiMo 的 `usable` 是 compaction 触发点；DSH 里我们让 rebuild 点在原生 compaction 前 `margin`。为了让 checkpoint 阶梯仍有“远低于上限”的语义，阶梯基于 `R` 而不是原始窗口。默认 margin≈1% 窗口（大窗口约 10K），对阶梯影响 <2%。

## 2. Writer：覆盖范围、成功语义、模板与规则

| MiMo（`checkpoint.ts`、`checkpoint-templates.ts`、`prompt/checkpoint-writer.txt`） | 插件 |
|---|---|
| writer 是独立 subagent；`checkpoint.fork` 默认 true，fork 父前缀做 prefix-cache | 默认 `writerBackend=direct`：单次 `ctx.llm.stream()`，watermark + `writerInputTokenLimit` 裁剪，tagged blocks，插件唯一写盘。显式 `auto|subagent` 才跑 fork/spawn tagged-text 子代理（只读、不写盘、序列化裁剪、失败回退 direct） |
| `computeBoundary()`：从最后一个 finished assistant − 1 开始保留尾部；tail 目标 10K–20K tokens、至少 5 条含文本消息；自然尾更大时不截断；工具配对调整 | 已移植 `computeWriterWatermark()`：用 DSH token-meter 的 surface 节点计价，同样的 10K/20K/5 规则；边界用真实 `toolPairingBalancedBefore` 对齐；writer 只看到 watermark 之前的对话，最近尾部留给 rebuild dump 的 recent-user/activity 段 |
| watermark `last_checkpoint_message_id` **只在 writer 成功后推进**；失败保持旧值，下一次阈值覆盖同一段 | 已实现：`writeCheckpoint(meta.lastCheckpointSeq=watermarkSeq)` 仅在成功路径执行；失败保留旧 meta；`hasUsableCheckpoint = watermark || writerCalls>0` |
| 模板：11 段 `# Session checkpoint` + 斜体结构行；MEMORY 4 段；NOTES 模板；精确 header 不可改 | `storage.js` 逐字采用 MiMo 模板；section budgets 与 MiMo 一致 |
| writer 提示词 167 行：§1 block quote、commitment vs inspection、exact-form literals、§4 只能来自 task DB、不得写 tasks/*/progress.md、溢出 spillover、只在 turn 2 编辑后停止 | `prompts.js` 保留这些硬规则（工具轮次由 fork/spawn 子代理执行；无工具时回退 tagged 完整文件体）；§1 保留/更新规则、exact-form、§4 不得发明、spillover 规则均保留 |
| 成功后 writer 用 `write` 把 notes.md 覆写回 NOTES_TEMPLATE | 成功后由插件 `resetNotes()`（无论 writer 是否输出 notes），语义一致 |
| 可用性要求 `checkpoint.md` 存在**且 watermark 已推进**；仅有模板不算 usable | 已实现；e2e 中第一次 writer 前的 template 不被当作可重建 checkpoint |
| writer 失败分 deterministic/transient；只有 transient 才允许 final-rung gate | `classifyWriterFailure()`：auth/invalid/context/max-tokens 类 deterministic，其余 transient |
| 失败不覆盖旧 checkpoint（模板只在缺失时写） | `store.writeCheckpoint` 只在成功时写；模板仅 `ensure` 时创建；失败路径不写 |

> 差异：MiMo writer 用 read/write/edit/task 工具**原地编辑**文件；插件默认让模型返回完整文件体再原子写（插件唯一写盘，保证 lock/CAS 与 `.prev` 正确）。DSH 已有 `ctx.subagents` 接缝，但 fork/spawn 均无法提供 watermark 切片前缀或 fork 工具白名单，因此子代理路径仅作为 tagged-text 隔离执行器；真正的原地编辑应由插件自建受限工具循环（read/write/edit + 路径白名单）。

## 3. Rebuild：MiMo 的窗口“种子” vs DSH 的 compaction 事务

| MiMo（`checkpoint.ts` `insertRebuildBoundary`/`renderRebuildContext`） | 插件 |
|---|---|
| 不删除 DB 消息；在最新消息后追加一条 synthetic checkpoint 用户消息；下一次窗口从 boundary 开始 | DSH 没有“追加 boundary + 过滤窗口”接缝，改用真实 `compaction` 事务：`compaction/start → summary → user/message(surfaceOp.replace, 覆盖整个非 system 窗口) → end`；DB 旧事件仍在，只是 surface 被替换 |
| 重建上下文 = **dump**（不是保留旧消息原文） | 同样：`replaceAll` 替换整个可见窗口，不保留任意 token 尾部 |
| 注入顺序/caps：Tasks ledger 2K → Session checkpoint 11K → Active actors 500 → Recent user 16K(2K/条) → Project MEMORY 10K → Global MEMORY 6K → Notes 6K → Memory keys index 500 → Recent activity digest → seam framing → tail reminder；总 caps ≈52K | 全部实现；Active actors 用 `ctx.agents.list()` 过滤当前 session 的直接子代理；`pushCaps` 默认值与 MiMo 一致 |
| F17 header：“The sections below are auto-loaded session context already in this message…” | 逐字采用 |
| 文件段是 `# Section` + `File: <abs path>` + H1-stripped body；section-aware budgeted read | 已实现 `pushSection` + `readBudgetedSectionAwareText`（同 MiMo 的 preamble/italic/index 保留算法与截断提示） |
| Recent user input：只取真实 user prose（跳过 synthetic），FIFO 16K，单条 head 60%+tail 30%+messageID elision | 用 DSH `source.kind === 'user'` 精确过滤 runtime-context/skill-catalog/plugin 注入；同样的 FIFO/截断 |
| Recent activity：只列 tool 名+参数（不列结果），跳过 user/boundary/synthetic，最多 200 行、240/80 字符 | `tail-digest.ts` 逐字移植到 `renderTailDigest()` |
| Unanswered user messages 在 boundary 上**全文**复制（不受 recent-user 预算） | 已实现：tail 中最后一条非 user 之后的真实 user 消息，按原 content blocks 追加到 replacement；同时从 recent-user 中排除 |
| 不递归吸收上一次 rebuild boundary（fractal bloat） | `isBoundaryEvent` 跳过 `compact-checkpoint` 消息；digest 从 watermark 之后开始 |
| 无可用 checkpoint 时返回空，caller 可回退 compaction | `renderRebuildContext` 返回 null；caller 走 fallback compaction |
| 插入失败（有 checkpoint）**禁止 compaction** | 同样：`attempt === 'insert-failed'` 只告警，不回退 |
| watermark 是 writer 覆盖点，digest 从 watermark 之后算 | `renderRebuildContext({boundarySeq: state.watermark})`；无 watermark 时回退到上一 boundary |

> 差异：MiMo 的 boundary 是“追加 + 新窗口”，旧消息对**后续**窗口不可见，但仍可被 history/memory 工具检索；DSH 的 replace 事务语义上等价，旧事件仍保存在 session 日志中，但插件没有 history 工具（DSH 自带 session 历史/搜索能力可替代）。普通 compaction 的 trigger 文案、manifest 5 文件、5 段摘要格式均已移植。

## 4. 决策：rebuild-first，compaction 只在唯一条件下

MiMo `rebuildEnsuringCheckpoint` 的 5 种结果与插件对应：

| MiMo attempt | 含义 | 插件 |
|---|---|---|
| `rebuilt` | boundary 插入成功 | `attempt: 'rebuilt'` |
| `writer-failed` | 无 checkpoint，writer 已启动并等待后失败/超时 | `writer-failed` → **fallback compaction** |
| `memory-write-off` | `memory.disable_write=true`，什么都不尝试 | `memoryWrite=false` → `memory-write-off` → fallback compaction |
| `checkpoint-off` | `MIMOCODE_DISABLE_CHECKPOINT` | `checkpointEnabled=false` → `checkpoint-off` → fallback compaction |
| `insert-failed` | 有可用 checkpoint 但插入被拒 | `insert-failed` → **不 compaction**，仅告警，让 provider overflow 兜底 |

等待边界：有 checkpoint 时 30s；首次 checkpoint 5min；auto 180s；manual 300s（`config.*WaitMs`，默认同 MiMo）。writer 超时不会取消后台 writer；watermark 仍可能在之后推进（我们只等待 promise，不 abort 已完成 writer；超时路径保留状态）。

**Fallback compaction** 已实现为 MiMo 的五段式摘要 + `<conversation-summary trigger="automatic|manual|provider-overflow">` + `files-touched` manifest（最后 5 个文件），替换整个窗口；失败则让 DSH 原生 compaction 在 N 处兜底。这样 `checkpointEnabled=false` / `memoryWrite=false` / 无 checkpoint 且 writer 失败三种情况的行为与 MiMo 一致。

## 5. 记忆布局、系统提示与可写性

| MiMo（`checkpoint-paths.ts`、`config.ts`） | 插件 |
|---|---|
| `<data>/memory/sessions/<sid>/checkpoint.md`、`notes.md`、`tasks/<TID>/progress.md` | `<root>/sessions/<sid>/...`；`root` 默认 `$DSH_HOME/mimo-context` |
| `<data>/memory/projects/<pid>/MEMORY.md` | `<root>/projects/<sha1(cwd)[:16]>/MEMORY.md` |
| `<data>/memory/global/MEMORY.md`，用户维护，agent 只读，不自动创建 | `<root>/global/MEMORY.md`；只读、不自动创建 |
| checkpoint / MEMORY / notes 单一 writer；main agent 只能写 notes；task progress 由 subagent 写 | writer 写 checkpoint/MEMORY/notes；工具只允许写 notes；任务进度工具/子代理写；没有 path-guard 强制（DSH 无 actor 文件权限接缝） |
| `memory.disable_write` 停止所有新 memory 写入、rebuild 短路为 compaction、dream/distill 跳过 | `memoryWrite=false` 完全对应：writer、模板 bootstrap、notes/task 写、dream/distill、rebuild 全部短路；已有文件仍可读/搜索 |
| 启动/resume 不自动注入 memory **内容**；内容只由 rebuild dump 注入，否则按需 search/read；但 memory system 的**说明**始终在 system prompt | `injectOnStart` 默认 false；`injectMemoryInstructions` 默认 true：在 `agent/created` 时用 DSH `ctx.systemPrompt.section` 注册 scoped 的 MiMo `buildMemoryInstructions` 段（真实路径 + active-recall）；服务不可用时才回退一次性 reminder |
| FTS5 外部内容表 + trigger + BM25 + relative score floor 0.15 | memory 文件每次检索用临时 FTS5（文档小）；session history 用 DSH 的持久 `ctx.sessionQuery`（`dsh-session-query-sqlite`，FTS5）并通过 `mimo_history_search` / `/mimo-history` 暴露；memory 文件没有持久 memory_fts 表 |
| task tool DB 是 §4 Task tree 的 source of truth | DSH `todo_write` 的 `todo/write` 事件是任务状态的 source of truth（content+status）；writer/dump 优先用它，缺失时回退 `tasks/<id>/progress.md` |
| dream/distill 默认 auto=false；interval 7/30 天；首次运行按项目年龄 gate；10s 最小 spawn gap | `dreamAuto/distillAuto=false`；`dreamIntervalDays/distillIntervalDays`；项目 `project.json.createdAt` 做首次 gate；10s 内存 gap；`memoryWrite` 时跳过 |

## 6. 功能等价下的有意差异（用户已确认不要求逐字节一致）

DSH 0.2.2 提供 `dsh-subagent` / `dsh-subagent-fork-in-process` / `dsh-agent-preset` / `dsh-system-prompt` / `dsh-tool-todo` / `dsh-session-query-sqlite` 等基础接缝（都在 `dsh-base/cordis.patch.yml`），所以本轮不再把它们叫“不能移植”：

- **writer 路径（三档，按评审收敛）**：① 默认 `writerBackend=direct` —— 单次 `ctx.llm.stream()`，输入经 `computeWriterWatermark` + `trimWriterMessages` 裁到 `writerInputTokenLimit`（最近 10–20K 尾部留给 rebuild dump），输出 tagged blocks，**插件是唯一写盘者**。② `writerBackend=tools` —— 插件内受限工具循环：`writer_read/write/edit` 只作用于内存里的 checkpoint/MEMORY/notes buffer（其他 path 拒绝），最多 `writerToolRounds` 轮，用 `touched` 记录真实成功的写（相同内容重写也算成功、仍推进 watermark），最终校验后仍由 `store.writeCheckpoint` 唯一写盘，失败回退 direct。③ `writerBackend=auto|subagent` —— fork/spawn **tagged-text 子代理**：只读、禁止 write/edit/bash（插件负责 lock/CAS 和 `.prev`），fork 分支序列化当前 in-flight turn，spawn 分支再加 covered prefix，两者都裁到 `writerInputTokenLimit`；`auto` 下失败回退 direct。所有 writer 成功后 `notes.md` 无条件重置为模板（MiMo drain）。实测 `e2e-final25` direct 6/6、`e2e-final24` tools 6/6、`e2e-final20` auto+fork 6/6。
- **writer fork 的真实收益（不夸大）**：DSH fork seed 只含父代理已完成 turns（长工具 turn 内常为空），无法按 watermark 切片、无法保证 system/tools 同构，所以它**不提供** MiMo `checkpoint.fork` 的 prefix-cache，只是「隔离上下文的 tagged-text 执行器」。`fork` 不支持 `agentPreset`，因此没有 runtime 工具白名单；要白名单只能 `spawn` + preset（插件不自动安装）。
- **rebuild 抢跑（已修）**：`agent/pre-step` / `agent/request-error` 均以 `{prepend:true}` 注册，先于原生 `dsh-compaction-basic`（其 handler 先 compact 再 next），rebuild-first 五态语义真实生效；`insert-failed` 时原生 compaction 仍可能作为最后兜底，不再宣称「绝对禁止 compaction」。
- **dump 信息口径（已修）**：recent user / activity 只读当前 surface 且 `seq >= watermark`；shadowed 旧历史与 inbox splice 不再重新进入 dump。DSH 的 `tool/call` 行不是 surface 节点，activity digest 改从 `assistant/message` 的 `tool-call` blocks 提取工具名+参数（否则 surface-only 扫描会丢掉全部工具名）。
- **pending inbox（查证时序后取消拷贝）**：pre-step claim 的消息在 rebuild 完成**之后**才由 agent loop append 到新 boundary 之后（先 `inbox.claim` → pre-step waterfall → `session.append`），拷进 dump 会双份，因此不拷。
- **project MEMORY 并发（已做轻量保护）**：`.MEMORY.lock`（O_EXCL，stale 60s 回收）+ 读改写 CAS；另一 session 已更新 MEMORY 时保留新 body、仍写本 session checkpoint，并标记 `memoryMergeSkipped`。不是单文件所有权系统。tagged-text-only 子代理保证 CAS 比较的是真实的上一版。
- **shrink guard 与窄窗口降级（已补）**：提交前 `previewRebuildFit` 预检，口径与 DSH 原生 compaction 一致（`estimateMessage` vs shadowed route tokens）；放不下时缩放**非 checkpoint** caps 重渲染（最多 2 次，checkpoint § 永不缩放），仍放不下才 insert-failed。既不伪造 append-boundary，也不让窄窗口白白丢弃 rebuild。
- **死配置清理（已做）**：`checkpointFork`、`writerMinIntervalMs`、`rebuildContextTokens`、`maxCheckpointAgeMs`、`rebuildRetainRatio` 无调用点，已从 DEFAULTS 与校验中移除；`normalizeConfig` 用 `{...DEFAULTS,...raw}` 展开，所以旧 profile 仍携带这些键时被静默容忍，不会加载失败。
- **append-boundary + 新窗口语义（不伪造）**：DSH 只有 surface replace 的 compaction 接缝；插件用 replaceAll 事务得到等价的**模型可见**新窗口，旧事件仍在 session log 且可由 `mimo_history_search` 检索。DB 行保留/窗口过滤机制本身仍需 DSH 上游 seam。
- **task DB 的 ID/树（有意不做精确版）**：DSH `todo_write` 只有 content+status；插件用 todo 作为 §4 状态源，`tasks/<id>/progress.md` 作为 journal，两者没有稳定映射。现有功能足够，不再造一套 task DB。
- **memory_fts 持久索引（低收益，不做）**：memory 文件量小，临时 FTS5 足够；session history 已由 DSH 持久 `sessionQuery` 覆盖。
- **prune**：MiMo v0.1.16 已删除；DSH base 自带 `dsh-compaction-tool-result-pruner`，无需移植。

## 7. 验证证据（本轮）

- `node --test tests/unit.test.mjs`：**17/17**（threshold clamp/drop、computeBoundary、rebuild dump sections、surface+watermark 信息口径、tool-call block digest、fallback manifest/classification、todo ledger、writerBackend 三档 + legacy 键容忍、writer 工具白名单、`previewRebuildFit`、project MEMORY lock/CAS）。
- `e2e-final25`（canonical，**默认 direct**，最终代码）：真实 0.2.2 CLI + fake LLM + 原生 compaction 并存，15 main turns，6 次 writer 全部 `backend=direct`，2 次 rebuild（`activityLines=7`、`recentUserEntries=1/0`），session reload 101 events/2 transactions 全部通过。
- `e2e-final24`（**`writerBackend:tools`**）：6 次 writer 全部 `backend=tools`、零 fallback（`writerToolsCalls=12`、`checkpointCalls=0`），reload 101 events/2 transactions 通过。
- `e2e-final20`（显式 `writerBackend:auto` + fork）：6 次 writer 全部 `backend=subagent`，prompt 含 tagged-text hard rule 且被 `writerInputTokenLimit` 裁剪（最大 108K chars），reload 107 events/2 transactions 通过。
- `e2e-fallback4`（`checkpointEnabled=false`，prepend 之后重跑）：2 次 `fallback-compaction-ok`，`compactionCalls=2`，exit 0。
- `e2e-overflow-final`（新 runner `test-harness/run-overflow.mjs`：fake + 注入 400 的代理）：`overflow-rebuild-ok`，pressure 16302→10733，reload 85 events/1 transaction/`rebuilds=1 reason=provider overflow` 全部通过。
- `e2e-final12`：`writerBackend=auto` + 不存在的 provider，6 次 writer 全部回退 `backend=direct`，exit 0。
- `spike/selftest.mjs`：0.2.2 compaction 事务 30/30 通过。

## 8. 仍需注意

- DSH 0.2.2 的 compaction payload 是私有 seam；升级 DSH 后必须重跑 `spike/selftest.mjs` + `e2e/verify-e2e.mjs`。
- fork 子代理会创建 durable child session（DSH 的 session 模型），主 session 不受影响；这是 writer 子代理的可见副作用。
- 默认 `writerBackend=direct`：无 prefix cache、无工具轮次，但输入经 watermark + `writerInputTokenLimit` 双重裁剪，是当前最稳的生产路径。`tools`（插件内循环，无 child session）和 `auto|subagent`（fork/spawn tagged-text）均为显式 opt-in。
- 默认阶梯在 1M 窗口是 18 个 writer/窗口；成本敏感时用 `checkpointDensity: simple` 或显式阈值。
- `storage.layout: workspace` 保留旧版单目录布局；默认已迁移到 MiMo session/project/global 布局，旧 workspace 数据会在首次 `ensure` 时复制过去。








## 9. 完成状态（0.6.0）

1. **writer 三档（完成）**：`writerBackend: direct|tools|auto|subagent`；`tools` = 插件内受限工具循环（内存 buffer、路径白名单、`touched` 幂等成功判定、`writerToolRounds`），`auto|subagent` = fork/spawn tagged-text 子代理（不写盘），均失败回退 direct；所有档位成功后 `notes.md` 无条件重置。`e2e-final25`/`final24`/`final20` 分别验证。
2. **project MEMORY 并发（完成轻量版）**：`.MEMORY.lock` + CAS；tagged-text/插件内写盘消除「子代理直写 + CAS」自误判与 `.prev` 损坏。
3. **pending inbox（完成，结论为不拷贝）**：查证 DSH 时序（claim → pre-step → append）后确认拷贝会双份。
4. **task ID/树（用户决定不做精确版）**：`todo_write` + `tasks/<id>/progress.md`；不新增 task DB。
5. **持久 memory_fts（用户决定不做）**：临时 FTS5 + DSH sessionQuery。
6. **append-boundary 语义（不做）**：replaceAll 等价 + 历史可检索；逐字节一致性留给上游。
7. **shrink guard 预检与降级（完成）**：`previewRebuildFit` + 非 checkpoint caps 自适应缩放（≤2 次），窄窗口不再直接 insert-failed。
8. **死配置清理（完成）**：5 个无调用点字段移除，旧 profile 键静默容忍。
9. **overflow 记账（完成）**：overflow rebuild 现在同步更新 `meta.rebuilds`/`lastRebuildReason='provider overflow'`；新增 `test-harness/run-overflow.mjs` 可复现 runner。



