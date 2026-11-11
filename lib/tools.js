// Model-facing tools. Every tool returns a single text result; the model uses
// them to inspect or maintain its own MiMo memory between turns.

import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { measure, resolveRoute, resolveWindow } from './compaction.js'
import { startCheckpointWriter, awaitWriter } from './checkpoint.js'
import { buildMemoryInjection, runDistill, runDream, searchMemory } from './memory.js'
import { resolveCheckpointLadder } from './config.js'
import { estimateTokens, truncateTokens } from './util.js'

function textResult(text) {
  return [{ type: 'text', text: String(text) }]
}

function toolOutput() {
  return { schema: { type: 'string' }, render: (_args, value) => textResult(value) }
}

function contextLine(runtime, agent) {
  const state = runtime.states.for(agent.session.id)
  return {
    session: agent.session.id,
    pressure: state.lastPressure ?? 0,
  }
}

async function memoryStats(runtime, agent) {
  const cwd = await runtime.ensureCwd(agent)
  const scope = { cwd, sessionId: agent.session.id }
  const stats = runtime.store.stats(scope)
  const state = runtime.states.for(agent.session.id)
  let window
  try {
    window = await runtime.getWindow(agent)
  } catch (error) {
    window = { error: String(error && error.message || error) }
  }
  return { cwd, stats, window, state, context: contextLine(runtime, agent) }
}

export function registerTools(runtime) {
  const tools = runtime.ctx.get('tools')
  if (!tools) {
    runtime.logger.warn('dsh-mimo-context: tools service unavailable; model tools not registered')
    return
  }
  const definitions = []
  const register = (definition) => {
    definitions.push(definition)
    tools.register(definition)
  }
  runtime.toolDefinitions = definitions

  register({
    name: 'mimo_context_status',
    description: 'Report MiMo infinite-context status: token pressure, checkpoint thresholds, rebuild trigger, memory files and counts.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_context_status: no agent in this execution context'
      const info = await memoryStats(runtime, agent)
      const window = info.window
      let thresholdLine = ''
      if (!window.error) {
        try {
          thresholdLine = `checkpoint thresholds: ${resolveCheckpointLadder(runtime.config, window.rebuildAt).join(', ')}`
        } catch (error) {
          thresholdLine = `checkpoint thresholds: disabled (${String(error && error.message || error)})`
        }
      }
      const lines = [
        `session: ${info.context.session}`,
        `pressure: ${info.context.pressure} tokens`,
        window.error ? `window: unavailable (${window.error})` : `window: ${window.window} tokens; output reserve: ${window.output}; native compaction trigger: ${window.nativeTrigger ?? 'n/a'}; MiMo rebuild trigger: ${window.rebuildAt}`,
        thresholdLine,
        `session dir: ${info.stats.dir}; project dir: ${info.stats.projectDir}; watermark: ${info.stats.watermark ?? 'none'}`,
        `checkpoint: ${info.stats.checkpointTokens} tok; MEMORY: ${info.stats.memoryTokens} tok; global MEMORY: ${info.stats.globalMemoryTokens} tok; notes: ${info.stats.notesTokens} tok; tasks: ${info.stats.tasks}; skills: ${info.stats.skills}`,
        `writer calls: ${info.stats.writerCalls}; rebuilds: ${info.stats.rebuilds}; last writer: ${info.state.lastWriterAt ? new Date(info.state.lastWriterAt).toISOString() : 'never'}`,
        `writer backend: configured=${runtime.config.writerBackend}; last=${info.state.writerBackend ?? 'never'}${info.state.writerSubagentProvider ? ` (${info.state.writerSubagentProvider})` : ''}`,
        `generation: ${info.stats.generation.slice(0, 12)}; updated: ${info.stats.updatedAt ?? 'never'}`,
        `flags: checkpointEnabled=${runtime.config.checkpointEnabled} memoryWrite=${runtime.config.memoryWrite} autoCheckpoint=${runtime.config.autoCheckpoint} autoRebuild=${runtime.config.autoRebuild} fallbackCompaction=${runtime.config.fallbackCompaction}`,
      ].filter(Boolean)
      return lines.join('\n')
    },
  })

  register({
    name: 'mimo_memory_read',
    description: 'Read a MiMo memory file: checkpoint (the 11-section session checkpoint), memory (project MEMORY.md), global (global/MEMORY.md), notes (notes.md), or tasks (task progress summaries).',
    parameters: {
      file: { type: 'string', required: true, description: 'checkpoint | memory | global | notes | tasks' },
      offset: { type: 'number', description: 'Optional 0-based character offset' },
      limit: { type: 'number', description: 'Optional max characters (default 12000, max 40000)' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_memory_read: no agent in this execution context'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      const state = runtime.store.read(scope)
      const file = String(args?.file ?? 'checkpoint').toLowerCase()
      let body
      if (file === 'checkpoint') body = state.checkpoint
      else if (file === 'memory') body = state.memory
      else if (file === 'notes') body = state.notes
      else if (file === 'global') body = state.globalMemory
      else if (file === 'tasks') body = runtime.store.taskSummaries(scope, 4000).map((task) => `## ${task.id}\n${task.text}`).join('\n\n')
      else return `mimo_memory_read: unknown file "${file}" (use checkpoint|memory|global|notes|tasks)`
      const offset = Math.max(0, Math.floor(Number(args?.offset) || 0))
      const limit = Math.min(Math.max(1, Math.floor(Number(args?.limit) || 12000)), 40000)
      const slice = body.slice(offset, offset + limit)
      return `${file} (${estimateTokens(body)} tokens, showing ${offset}..${offset + slice.length}):\n\n${slice}${offset + slice.length < body.length ? '\n\n[... use offset to continue ...]' : ''}`
    },
  })

  register({
    name: 'mimo_memory_write',
    description: 'Write the MiMo notes.md scratchpad, or append a note. Checkpoint and MEMORY.md are writer-owned; use mimo_checkpoint or /mimo-dream for those.',
    parameters: {
      file: { type: 'string', required: true, description: 'notes' },
      content: { type: 'string', required: true },
      mode: { type: 'string', description: 'replace | append (default append)' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_memory_write: no agent in this execution context'
      if (!runtime.config.memoryWrite) return 'mimo_memory_write: memory writing is disabled (memoryWrite=false)'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      const file = String(args?.file ?? 'notes').toLowerCase()
      if (file !== 'notes') return 'mimo_memory_write: only "notes" is writable here; use mimo_checkpoint / /mimo-dream for writer-owned files'
      const content = String(args?.content ?? '')
      if (content.length === 0) return 'mimo_memory_write: empty content'
      const mode = String(args?.mode ?? 'append').toLowerCase()
      const turn = runtime.states.for(agent.session.id).lastTurn
      const result = mode === 'replace'
        ? runtime.store.writeNotes(scope, truncateTokens(content, 20000))
        : runtime.store.appendNotes(scope, truncateTokens(content, 20000), turn)
      return `notes.md updated (${estimateTokens(result)} tokens)`
    },
  })

  register({
    name: 'mimo_task_progress',
    description: 'Maintain a per-task progress file (tasks/<id>/progress.md) used by checkpoints and rebuilds.',
    parameters: {
      task_id: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_task_progress: no agent in this execution context'
      if (!runtime.config.memoryWrite) return 'mimo_task_progress: memory writing is disabled (memoryWrite=false)'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      const file = runtime.store.writeTaskProgress(scope, String(args?.task_id ?? 'task'), truncateTokens(String(args?.content ?? ''), 8000))
      return `task progress written: ${file}`
    },
  })

  register({
    name: 'mimo_memory_search',
    description: 'Search MiMo memory files (checkpoint, MEMORY.md, notes, task progress) by keyword. Uses SQLite FTS5 when available, with a deterministic fallback.',
    parameters: {
      query: { type: 'string', required: true },
      scope: { type: 'string', description: 'all | checkpoint | memory | notes | tasks (default all)' },
      limit: { type: 'number', description: 'Max hits (default 10)' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_memory_search: no agent in this execution context'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      const hits = await searchMemory(runtime.store, scope, String(args?.query ?? ''), {
        scope: args?.scope,
        limit: args?.limit,
      })
      if (hits.length === 0) return 'mimo_memory_search: no hits'
      return hits.map((hit, index) => `${index + 1}. ${hit.label}:${hit.line} — ${hit.text.trim()}`).join('\n')
    },
  })

  register({
    name: 'mimo_history_search',
    description: 'Search durable DSH session history (SQLite FTS5 via ctx.sessionQuery) for exact past content. MiMo Code uses its trajectory DB + history tool for the same verbatim-recall purpose.',
    parameters: {
      query: { type: 'string', required: true, description: 'Full-text query' },
      scope: { type: 'string', description: 'session (default) | all (cross-session)' },
      limit: { type: 'number', description: 'Max hits (default 10, max 30)' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_history_search: no agent in this execution context'
      const sessionQuery = runtime.ctx.get('sessionQuery')
      if (!sessionQuery) return 'mimo_history_search: session query service unavailable in this profile'
      const query = String(args?.query ?? '').trim()
      if (!query) return 'mimo_history_search: empty query'
      const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 30)
      const all = String(args?.scope ?? 'session').toLowerCase() === 'all'
      try {
        if (all) {
          const page = await sessionQuery.searchSessions({ query, limit })
          if (!page.items?.length) return `no history matches for "${query}"`
          return page.items.map((hit, index) => {
            const best = hit.bestMatch
            return `${index + 1}. session=${hit.id} seq=${best?.seq ?? '?'} type=${best?.type ?? '?'}\n${best?.snippet ?? ''}`
          }).join('\n')
        }
        const page = await sessionQuery.searchEvents({ sessionId: agent.session.id, query, limit })
        if (!page.items?.length) return `no history matches for "${query}"`
        return page.items.map((hit, index) => `${index + 1}. seq=${hit.seq} type=${hit.type}\n${hit.snippet ?? ''}`).join('\n')
      } catch (error) {
        return `mimo_history_search failed: ${String(error && error.message || error)}`
      }
    },
  })

  register({
    name: 'mimo_checkpoint',
    description: 'Force a MiMo checkpoint write now (checkpoint.md + MEMORY.md) from the current session, then report the result.',
    parameters: {
      focus: { type: 'string', description: 'Optional focus hint for the writer' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_checkpoint: no agent in this execution context'
      if (!runtime.config.checkpointEnabled) return 'mimo_checkpoint: checkpointing is disabled (checkpointEnabled=false)'
      if (!runtime.config.memoryWrite) return 'mimo_checkpoint: memory writing is disabled (memoryWrite=false)'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      const state = runtime.states.for(agent.session.id)
      try {
        const writer = startCheckpointWriter(runtime.ctx, {
          agent,
          store: runtime.store,
          scope,
          config: runtime.config,
          state,
          reason: args?.focus ? `manual: ${String(args.focus).slice(0, 120)}` : 'manual',
        })
        const result = await writer
        return `checkpoint written (generation ${result.generation.slice(0, 12)}); checkpoint=${estimateTokens(result.checkpoint)} tok, memory=${estimateTokens(result.memory)} tok; backend=${result.backend ?? 'direct'}; writer prompt messages=${result.writerMessages}`
      } catch (error) {
        return `mimo_checkpoint failed: ${String(error && error.message || error)}`
      }
    },
  })

  register({
    name: 'mimo_rebuild',
    description: 'Queue a MiMo rebuild at the next pre-step: replaces the whole visible window with the checkpoint dump (tasks/checkpoint/recent user/memory/notes/activity) and copies unanswered user messages. Returns immediately; the rebuild happens before the next model request.',
    parameters: {
      reason: { type: 'string', description: 'Optional reason recorded in the boundary message' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_rebuild: no agent in this execution context'
      const state = runtime.states.for(agent.session.id)
      state.pendingRebuild = true
      state.pendingRebuildReason = String(args?.reason ?? 'requested by model')
      return 'mimo_rebuild: queued; the rebuild runs at the next pre-step before the next model request'
    },
  })

  register({
    name: 'mimo_dream',
    description: 'Consolidate MEMORY.md from the session checkpoint, notes and task progress (dream). Writes MEMORY.md after a backup.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_dream: no agent in this execution context'
      if (!runtime.config.memoryWrite) return 'mimo_dream: memory writing is disabled (memoryWrite=false)'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      try {
        const result = await runDream(runtime.ctx, { agent, store: runtime.store, scope, config: runtime.config, signal: exec?.signal })
        return `MEMORY.md consolidated (${estimateTokens(result.memory)} tokens)`
      } catch (error) {
        return `mimo_dream failed: ${String(error && error.message || error)}`
      }
    },
  })

  register({
    name: 'mimo_distill',
    description: 'Distill a repeated workflow into a reusable skill file under the MiMo skills directory.',
    parameters: {
      focus: { type: 'string', description: 'Optional workflow focus' },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return 'mimo_distill: no agent in this execution context'
      if (!runtime.config.memoryWrite) return 'mimo_distill: memory writing is disabled (memoryWrite=false)'
      const cwd = await runtime.ensureCwd(agent)
      const scope = { cwd, sessionId: agent.session.id }
      try {
        const result = await runDistill(runtime.ctx, { agent, store: runtime.store, scope, config: runtime.config, signal: exec?.signal, focus: args?.focus })
        return `skill written: ${result.file}`
      } catch (error) {
        return `mimo_distill failed: ${String(error && error.message || error)}`
      }
    },
  })

  runtime.logger.info?.('dsh-mimo-context: model tools registered (mimo_context_status, mimo_memory_read/write/search, mimo_history_search, mimo_task_progress, mimo_checkpoint, mimo_rebuild, mimo_dream, mimo_distill)')
}

export { memoryStats, measure, resolveRoute, resolveWindow, CONTEXT_WINDOW_EXCEEDED_CODE }

