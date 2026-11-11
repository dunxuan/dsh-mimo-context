# dsh-mimo-context — 实施与验证报告（第二轮：MiMo 行为对齐）

日期：2026-11-08
目标：在已可用的插件基础上，按 MiMo Code v0.1.16/main 源码逐项重新分析，把行为逻辑对齐到 MiMo，并在隔离环境重新端到端验证。
状态：**完成**。未改动用户的 `~/.dsh/profiles/desktop` 或运行中的 GUI。

逐项源码对照见 [MIMO-FIDELITY.md](MIMO-FIDELITY.md)；安装/配置见 [plugin/README.md](plugin/README.md)。

## 1. 本轮分析结论（MiMo 源码 → 实际改动）

| 行为 | MiMo 源码 | 本轮插件改动 |
|---|---|---|
| checkpoint 阶梯 + reserved clamp/drop | `session/prune.ts` `defaultThresholdsFor/resolveThresholds/CHECKPOINT_RESERVED=13K` | 完整移植：动态阶梯、`checkpointReserved`、第一个超限 clamp、后续 drop、保留输入顺序；窗口过小报错 |
| 最后一档恢复 gate | `prune.ts` `finalRetryAt`（token 位置，非失败计数） | 已实现：writer settled 且 retryable 才 arm `min(firedAt+step, maxAllowed)`，下一次压力越过才重发 |
| crossed 语义 + rebuild 后 reset | `prune.ts` 单飞锁、`resetThresholds` | writer 正在跑时不消费 crossed；successful rebuild/fallback 后清空 crossed + gate |
| writer 覆盖边界 10–20K tail | `checkpoint.ts` `computeBoundary` / `TAIL_MIN/MAX` / 5 条文本消息 | 新增 `computeWriterWatermark()`，writer 输入裁到 watermark 之前；tool-pair 平衡 |
| watermark 成功推进 | `checkpoint.ts` `last_checkpoint_message_id` 仅成功推进；模板≠可用 | `meta.lastCheckpointSeq` 仅成功写；`hasUsableCheckpoint` 区分模板/可用；writer 失败保留旧值 |
| 11 段 checkpoint / 4 段 MEMORY / NOTES 模板 | `checkpoint-templates.ts` | 逐字采用模板、段落 budgets、`# Session checkpoint` 标题 |
| writer prompt 硬规则 | `agent/prompt/checkpoint-writer.txt` | 保留 §1 verbatim、commitment/inspection、exact-form literals、§4 只能来自 ledger、notes drain、spillover、禁止 invent 等规则（工具轮次改为输出完整文件体） |
| rebuild dump 顺序/caps | `checkpoint.ts` `renderRebuildContext`；`budgeted-read.ts`；`tail-digest.ts` | 新增 `lib/rebuild-context.js`：F17 header、Tasks ledger 2K、checkpoint 11K + `File:`、recent user 16K/2K、project MEMORY 10K、global MEMORY 6K、notes 6K、memory index 500、activity digest、seam framing、tail reminder；section-aware 截断 |
| recent user 只取真实 user prose | `checkpoint.ts` `userMsgText/truncateVerbatimUserMsg` | 用 DSH `source.kind === 'user'` 精确过滤 runtime-context / skill-catalog / plugin 注入；head 60% + tail 30% + messageID elision |
| activity digest 只列 tool 名+参数 | `tail-digest.ts` | 逐字移植（240/80 字符，200 行，跳过 user/boundary/synthetic） |
| unanswered user 全文复制 | `checkpoint.ts` `insertRebuildBoundary` | tail 中最后一条非 user 之后的真实 user content blocks 追加到 boundary，并从 recent-user 中排除 |
| 不递归吸收旧 boundary | `tail-digest.ts` `isBoundaryUser` | `compact-checkpoint` source 跳过；digest 从 writer watermark 后开始 |
| rebuild-first / compaction 五态 | `prompt.ts` `rebuildEnsuringCheckpoint` | 五态实现：`rebuilt` / `writer-failed` / `memory-write-off` / `checkpoint-off` / `insert-failed`；只有前三种允许 compaction，insert-failed 禁止 |
| ordinary compaction 五段摘要 + manifest | `prompt/compaction.txt`；`compaction.ts` `buildSummaryMessage/buildFileManifest/buildTail` | 新增 `lib/fallback-compaction.js`：5 段摘要、`<conversation-summary trigger=...>`、5 文件 `<files-touched>`、replaceAll 事务；`/mimo-compact` 手动入口；auto/overflow 共用 |
| 等待边界 | `checkpoint.ts` 30s/5min/180s/300s | 新增 `existingCheckpointWaitMs/firstCheckpointWaitMs/writerWaitMs/manualRebuildWaitMs` |
| session/project/global layout + notes reset | `checkpoint-paths.ts`；notes 写回 | Store 重构：session/project/global；旧 workspace 自动迁移；writer 成功后重置 NOTES 模板 |
| `MIMOCODE_DISABLE_CHECKPOINT` / `memory.disable_write` | `flag.ts` / `write-gate.ts` | `checkpointEnabled` / `memoryWrite` 开关，覆盖 writer、模板、工具、rebuild、fallback、dream/distill |
| 默认不自动注入 memory 内容 | `checkpoint.ts` rebuild 注入；README 不精确 | `injectOnStart` 默认 **false**（需要旧行为可显式开启） |
| prune 已移除 | `config.ts` v0.1.16 警告 | 插件不 prune |
| dream/distill opt-in + 首次 gate + 10s gap | `auto-dream.ts` | 默认 false，interval 7/30 天，项目 `createdAt` 首次 gate，10s 间隔 |

## 2. 验证结果

| # | 验证 | 结果 | 证据 |
|---|---|---|---|
| 1 | 单元/组件测试（阈值 clamp、computeBoundary、dump sections、surface+watermark 口径、tool-call digest、fallback manifest、storage/watermark、writer 三档 + legacy 键容忍、writer 工具白名单、`previewRebuildFit`、lock/CAS、tools、search、dream/distill） | **17/17 通过** | `node --test tests/unit.test.mjs` |
| 2 | compaction 事务合约 spike（真实 0.2.2 append 校验、v4 reload、锁/补偿/负例） | **30/30 通过** | `spike/selftest.mjs` |
| 3 | canonical e2e（**默认 `writerBackend=direct`**，最终 0.6.0 代码；真实 0.2.2 CLI + fake LLM；15 main turns；原生 compaction 同时启用） | PASS：backend=direct 6/6 | `e2e-final25/summary.json` |
| 4 | session reload / bracket / ownership / dump / watermark | 全部 PASS：101 events、2 transactions、replaceGeneration=2、watermark=7、writerCalls=6、rebuilds=2 | `e2e/verify-e2e.mjs` |
| 5 | rebuild 压力回落 + dump 信息集 | 触发点 16302 / 17512；`activityLines=7/7`、`recentUserEntries=1/0`、`unanswered=0` | `e2e-final25-trace.log` |
| 6 | **writer 内工具循环（`writerBackend:tools`）** | PASS：6/6 `backend=tools`、零 direct 回退；`writerToolsCalls=12`（6 writer × 2 轮），reload 101 events/2 transactions | `e2e-final24/` |
| 7 | fallback ordinary compaction（`checkpointEnabled=false`，prepend 后重跑） | PASS：2 次 `fallback-compaction-ok`，`compactionCalls=2`，exit 0 | `e2e-fallback4/` |
| 8 | overflow 恢复（新 runner：fake + 注入 400 的代理） | PASS：`overflow-rebuild-ok`，pressure 16302→10733，`meta.rebuilds=1 reason=provider overflow`，reload 85 events/1 transaction | `test-harness/run-overflow.mjs`、`e2e-overflow-final/` |
| 9 | 安装路径 | 0.6.0 在全新隔离 profile `dsh plugin add file:...` 成功；`--dump-config` 显示 `id: mimo-context` / `name: dsh-mimo-context` | `dsh-home/profiles/mimo-install-fresh3` |
| 10 | npm 打包 | `npm pack --dry-run` 18 files / 64.6 kB（含 README/LICENSE） | plugin 目录 |
| 11 | DSH 原生接缝整合 | `ctx.systemPrompt.section` 的 memory-system 段出现在真实 assembled system message（final25：6150 chars，“Memory system”/“Active recall protocol”）；`todo/write` ledger / `ctx.agents.list()` actors / `ctx.sessionQuery` history | final25 system/message 解码 |
| 12 | **prepend listener** | `agent/pre-step` / `agent/request-error` `{prepend:true}`，先于原生 compaction-basic（先 compact 再 next，非 prepend），rebuild-first 真实生效 | `plugin/index.js`、`e2e-final25` |
| 13 | **surface 口径 + tool-call digest** | recent/activity 只读 surface 且 `seq >= watermark`；`tool/call` 非 surface 节点 → 从 assistant `tool-call` blocks 提取（`activityLines` 0→7）；shadowed 用户被单测排除 | `e2e-final25`、unit |
| 14 | **tagged-text 子代理** | 显式 `auto`+fork：6/6 `backend=subagent`，prompt 含 never-write hard rule 并裁到 `writerInputTokenLimit`（≤108K chars），107 events reload PASS | `e2e-final20` |
| 15 | **shrink guard 预检 + 自适应降级** | `previewRebuildFit`（与原生同口径）+ 非 checkpoint caps 缩放 ≤2 次；单测证明 fits/too-large 两个方向 | unit、`plugin/index.js` |
| 16 | **死配置清理 + legacy 容忍** | 5 个无调用点字段移除；`{...DEFAULTS,...raw}` 使旧 profile 携带的 `rebuildRetainRatio` 等键静默通过 | unit |
| 17 | auto fallback on missing provider | `auto` + 不存在的 provider：6 次 writer 全部回退 direct，exit 0 | `e2e-final12` |

### canonical e2e 关键读数（e2e-final25，默认 direct）

- 15 main requests；6 次 writer（`backend=direct` 6/6）；2 次 rebuild；
- rebuild dump `diagnostics`: `recentUserEntries=1/0`、`activityLines=7/7`、`tokens≈1301/1204`；
- `meta.json`：writerCalls=6、rebuilds=2、watermark=7、checkpointTokens=638；
- session：101 events、2 组 balanced compaction、`replaceGeneration=2`，v4 reload 校验通过；
- system message：6150 chars，含 “Memory system” / “Active recall protocol”；
- activity digest 来自 surface 上 assistant 的 `tool-call` blocks，不含 tool results。

### tools-loop e2e 关键读数（e2e-final24，`writerBackend:tools`）

- 6 次 writer 全部 `backend=tools`、零 fallback：`writerToolsCalls=12`（每 writer 2 轮：writer_write → finish）、`checkpointCalls=0`；
- `touched` 幂等判定生效：第 2 次起 writer 重写相同 checkpoint 字节仍判成功并推进 watermark；
- reload 101 events / 2 transactions PASS。

### explicit subagent e2e 关键读数（e2e-final20，`writerBackend:auto`）

- 6 次 writer 全部 `backend=subagent`（fork）；prompt 含 never-write hard rule，序列化被 `writerInputTokenLimit` 裁剪（26.8K → 108.5K chars）；
- reload 107 events / 2 transactions PASS；子代理留下 durable child sessions（DSH 模型行为）。

### fallback e2e 关键读数（e2e-fallback4）

- `checkpointEnabled=false` → `checkpoint-off` → fallback compaction；prepend 后插件先跑、再放行原生 listener；
- 2 次 `<conversation-summary trigger="automatic">` + files manifest（`compactionCalls=2`），15 main turns，exit 0。

### overflow e2e 关键读数（e2e-overflow-final，`test-harness/run-overflow.mjs`）

- 代理在 chat 请求 #8 注入 `400 context_length_exceeded`，dsh exit 0、stderr 干净；
- `overflow-rebuild-ok`；pressure 16302 → 10733；`meta.rebuilds=1 reason=provider overflow`；
- reload 85 events / 1 balanced transaction / dump present 全部 PASS。

## 3. 当前能力

- 10 个模型工具 + 8 个 slash 命令（含 `/mimo-compact`、`/mimo-history`）。
- MiMo session/project/global 布局、watermark、notes drain、FTS5 搜索、dream/distill。
- checkpoint/rebuild/fallback/overflow 四条路径均用真实 0.2.2 会话验证；rebuild-first 通过 `{prepend:true}` 抢在原生 compaction 前。
- `checkpointEnabled` / `memoryWrite` 开关与 MiMo 语义对齐。
- writer 三档：`direct`（默认）、`tools`（插件内受限工具循环）、`auto|subagent`（fork/spawn tagged-text 子代理，不写盘）；全部失败回退 direct，成功后 notes 无条件重置。
- checkpoint/rebuild/fallback/overflow 四条路径均用真实 0.2.2 会话验证；rebuild-first 通过 `{prepend:true}` 抢在原生 compaction 前；窄窗口用 `previewRebuildFit` 自适应缩放降级。
- `checkpointEnabled` / `memoryWrite` 开关与 MiMo 语义对齐；5 个死配置字段已清理，旧 profile 键静默容忍。

## 4. 功能等价下的已知差异

1. writer 默认 `direct`（单次补全 + watermark/input cap，插件唯一写盘）；`tools` 是插件内内存-buffer 工具循环（无 child session、路径白名单，非 MiMo 的磁盘文件工具）；fork/spawn 是显式 opt-in 的 tagged-text 执行器，无 MiMo `checkpoint.fork` 的 prefix-cache（seed 只含 completed turns、无法 watermark 切片），fork 也无 runtime 工具白名单。
2. fork/spawn 子代理会留下 durable child session（DSH session 模型），主 session 不受影响。
3. 没有 MiMo 的 actor 文件权限层；project MEMORY 用 `.MEMORY.lock` + CAS 做轻量并发保护，不是单文件所有权。
4. rebuild 用 replaceAll 事务；MiMo 的 append-boundary/window-filter 需要 DSH 上游 seam，当前模型可见窗口等价、历史可检索。`insert-failed` 时插件不追加摘要，但原生 compaction 仍可能作为最后兜底（prepend 只保证插件先跑，无法 veto 原生）；窄窗口先经 `previewRebuildFit` 缩放非 checkpoint caps，最多 2 次。
5. dump 的 recent/activity 只读 surface 且 `seq >= watermark`；claimed inbox 消息由 loop 在 rebuild 后 append，不拷进 dump。DSH `tool/call` 非 surface 节点，digest 从 assistant `tool-call` blocks 提取。
6. task ledger 用 `todo_write` + `tasks/<id>/progress.md`，不是 MiMo task DB（用户确认不要求精确 ID/树）。
7. memory 文件搜索用临时 FTS5；session history 用 DSH 持久 `sessionQuery`。MiMo prune 在 v0.1.16 已移除，DSH 自带 tool-result-pruner。
8. 默认 MiMo 密集阶梯在 1M 窗口约 18 次 writer/窗口；可用 `checkpointDensity: simple` 降本。
9. DSH 0.2.2 compaction payload 是私有 seam；升级 DSH 后必须重跑 spike + e2e。

## 5. 复现

```powershell
cd D:\Documents\deepseek-harness\default-workspace\dsh-mimo-context
node --test tests/unit.test.mjs
node spike/selftest.mjs
cd test-harness
# canonical direct
node run-headless.mjs --profile mimo-e2e --tool-turns 14 --log-dir ..\e2e-final25
# tools-loop writer（profile cordis.patch.yml 临时设 writerBackend: tools）
node run-headless.mjs --profile mimo-e2e --tool-turns 14 --log-dir ..\e2e-final24
# fallback ordinary compaction
node run-headless.mjs --profile mimo-fallback --tool-turns 14 --log-dir ..\e2e-fallback4
# provider overflow（fake + 注入 400 的代理）
node run-overflow.mjs --profile mimo-overflow --trigger-at 8 --log-dir ..\e2e-overflow-final
cd ..\e2e
node verify-e2e.mjs <session.v4.jsonl.zstd> --memory <session dir> --log ..\e2e-final25
```

## 6. 结论

0.6.0 在评审 P0 基础上补齐全部剩余项：**writer 三档**（direct 默认 / 插件内受限工具循环 `tools` / fork-spawn tagged-text 子代理）、**project MEMORY 锁+CAS**、**prepend 抢跑**、**surface+watermark dump 口径与 tool-call block digest**、**pending inbox 去重**、**shrink guard 预检与自适应降级**、**死配置清理（旧 profile 键容忍）**、**notes 无条件重置**、**overflow 记账修复 + 可复现 runner**。验证：单元 **17/17**、事务 spike **30/30**、canonical direct（final25）、tools（final24）、auto+fork（final20）、fallback（fallback4）、overflow（overflow-final）全部在真实 0.2.2 CLI 上 reload 通过。有意不做的（用户确认）：actor path guard/所有权、task DB ID 树、持久 memory_fts、append-boundary/window-filter、prune——均为功能等价取舍，已逐项记录于 [MIMO-FIDELITY.md](MIMO-FIDELITY.md)。安装：`dsh plugin --profile <p> add file:D:\Documents\deepseek-harness\default-workspace\dsh-mimo-context\plugin`（0.6.0，18 files / 64.6 kB）。









