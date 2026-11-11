// Human-facing slash commands. They never become model messages; they run
// against the invoking agent and render their result in the command surface.

import { startCheckpointWriter } from './checkpoint.js'
import { runDistill, runDream, searchMemory } from './memory.js'
import { runFallbackCompaction } from './fallback-compaction.js'
import { resolveCheckpointLadder } from './config.js'
import { estimateTokens } from './util.js'

function success(text) {
  return { kind: 'success', text: String(text) }
}

function failure(text) {
  return { kind: 'error', text: String(text) }
}

export function registerCommands(runtime) {
  const commands = runtime.ctx.get('commands')
  if (!commands) {
    runtime.logger.warn('dsh-mimo-context: commands service unavailable; slash commands not registered')
    return
  }

  const scopeFor = async (agent) => ({ cwd: await runtime.ensureCwd(agent), sessionId: agent.session.id })

  commands.register({
    name: 'mimo-status',
    description: 'Show MiMo infinite-context status (pressure, triggers, memory files, rebuild count).',
    handler: async ({ agent }) => {
      if (!agent) return failure('no agent')
      const scope = await scopeFor(agent)
      const stats = runtime.store.stats(scope)
      const state = runtime.states.for(agent.session.id)
      let windowLine = 'window: unavailable'
      let thresholdLine = 'thresholds: n/a'
      try {
        const window = await runtime.getWindow(agent)
        windowLine = `window=${window.window} outputReserve=${window.output} nativeTrigger=${window.nativeTrigger ?? 'n/a'} rebuildAt=${window.rebuildAt}`
        thresholdLine = `thresholds: ${resolveCheckpointLadder(runtime.config, window.rebuildAt).join(', ')}`
      } catch (error) {
        windowLine = `window: ${String(error && error.message || error)}`
      }
      return success([
        `session: ${agent.session.id}`,
        `pressure: ${state.lastPressure ?? 0} tokens`,
        windowLine,
        thresholdLine,
        `session dir: ${stats.dir}; project dir: ${stats.projectDir}; watermark: ${stats.watermark ?? 'none'}`,
        `checkpoint=${stats.checkpointTokens} tok projectMemory=${stats.memoryTokens} tok globalMemory=${stats.globalMemoryTokens} tok notes=${stats.notesTokens} tok tasks=${stats.tasks} skills=${stats.skills}`,
        `writerCalls=${stats.writerCalls} rebuilds=${stats.rebuilds} generation=${stats.generation.slice(0, 12)}`,
      ].join('\n'))
    },
  })

  commands.register({
    name: 'mimo-checkpoint',
    description: 'Force a checkpoint write now.',
    handler: async ({ agent, rawInput }) => {
      if (!agent) return failure('no agent')
      if (!runtime.config.checkpointEnabled) return failure('checkpointing is disabled (checkpointEnabled=false)')
      if (!runtime.config.memoryWrite) return failure('memory writing is disabled (memoryWrite=false)')
      const scope = await scopeFor(agent)
      try {
        const result = await startCheckpointWriter(runtime.ctx, {
          agent,
          store: runtime.store,
          scope,
          config: runtime.config,
          state: runtime.states.for(agent.session.id),
          reason: String(rawInput ?? '').trim() || 'manual command',
        })
        return success(`checkpoint written (generation ${result.generation.slice(0, 12)}); checkpoint=${estimateTokens(result.checkpoint)} tok, memory=${estimateTokens(result.memory)} tok`)
      } catch (error) {
        return failure(`checkpoint failed: ${String(error && error.message || error)}`)
      }
    },
  })

  commands.register({
    name: 'mimo-rebuild',
    description: 'Queue a context rebuild for the next model request.',
    handler: ({ agent, rawInput }) => {
      if (!agent) return failure('no agent')
      const state = runtime.states.for(agent.session.id)
      state.pendingRebuild = true
      state.pendingRebuildReason = String(rawInput ?? '').trim() || 'command'
      return success('rebuild queued; it runs at the next pre-step before the next model request')
    },
  })

  commands.register({
    name: 'mimo-memory',
    description: 'Show MiMo memory files, or search: /mimo-memory search <query>.',
    handler: async ({ agent, rawInput }) => {
      if (!agent) return failure('no agent')
      const scope = await scopeFor(agent)
      const input = String(rawInput ?? '').trim()
      if (input.toLowerCase().startsWith('search ')) {
        const query = input.slice(7).trim()
        if (!query) return failure('usage: /mimo-memory search <query>')
        try {
          const hits = await searchMemory(runtime.store, scope, query, { limit: 12 })
          return success(hits.length === 0 ? 'no hits' : hits.map((hit, index) => `${index + 1}. ${hit.label}:${hit.line} — ${hit.text.trim()}`).join('\n'))
        } catch (error) {
          return failure(`search failed: ${String(error && error.message || error)}`)
        }
      }
      const stats = runtime.store.stats(scope)
      return success([
        `session dir: ${stats.dir}; project dir: ${stats.projectDir}`,
        `checkpoint.md: ${stats.checkpointTokens} tokens`,
        `MEMORY.md: ${stats.memoryTokens} tokens`,
        `notes.md: ${stats.notesTokens} tokens`,
        `tasks: ${stats.tasks}; skills: ${stats.skills}`,
        'usage: /mimo-memory search <query>',
      ].join('\n'))
    },
  })

  commands.register({
    name: 'mimo-compact',
    description: 'Run MiMo ordinary compaction now (5-part continuation summary + files-touched manifest; lossy by construction).',
    handler: async ({ agent }) => {
      if (!agent) return failure('no agent')
      const scope = await scopeFor(agent)
      const state = runtime.states.for(agent.session.id)
      try {
        const result = await runFallbackCompaction(runtime.ctx, { agent, config: runtime.config, trigger: 'manual' })
        state.rebuildCount += 1
        state.lastRebuildAt = Date.now()
        state.crossed?.clear?.()
        return success(`ordinary compaction committed (${result.shadowedTokenCount} tokens shadowed, ${result.files.length} files in manifest)`)
      } catch (error) {
        return failure(`compaction failed: ${String(error && error.message || error)}`)
      }
    },
  })

  commands.register({
    name: 'mimo-history',
    description: 'Search durable DSH session history: /mimo-history [all] <query>.',
    handler: async ({ agent, rawInput }) => {
      if (!agent) return failure('no agent')
      const input = String(rawInput ?? '').trim()
      if (!input) return failure('usage: /mimo-history [all] <query>')
      const sessionQuery = runtime.ctx.get('sessionQuery')
      if (!sessionQuery) return failure('session query service unavailable in this profile')
      const all = input.startsWith('all ') || input === 'all'
      const query = all ? input.slice(3).trim() : input
      if (!query) return failure('usage: /mimo-history [all] <query>')
      try {
        if (all) {
          const page = await sessionQuery.searchSessions({ query, limit: 10 })
          return success(page.items?.length
            ? page.items.map((hit, index) => `${index + 1}. session=${hit.id}: ${hit.bestMatch?.snippet ?? ''}`).join('\n')
            : 'no history matches')
        }
        const page = await sessionQuery.searchEvents({ sessionId: agent.session.id, query, limit: 10 })
        return success(page.items?.length
          ? page.items.map((hit, index) => `${index + 1}. seq=${hit.seq} ${hit.type}: ${hit.snippet ?? ''}`).join('\n')
          : 'no history matches')
      } catch (error) {
        return failure(`history search failed: ${String(error && error.message || error)}`)
      }
    },
  })

  commands.register({
    name: 'mimo-dream',
    description: 'Consolidate MEMORY.md from the current checkpoint, notes and tasks.',
    handler: async ({ agent }) => {
      if (!agent) return failure('no agent')
      if (!runtime.config.memoryWrite) return failure('memory writing is disabled (memoryWrite=false)')
      const scope = await scopeFor(agent)
      try {
        const result = await runDream(runtime.ctx, { agent, store: runtime.store, scope, config: runtime.config })
        return success(`MEMORY.md consolidated (${estimateTokens(result.memory)} tokens)`)
      } catch (error) {
        return failure(`dream failed: ${String(error && error.message || error)}`)
      }
    },
  })

  commands.register({
    name: 'mimo-distill',
    description: 'Distill a repeated workflow into a skill file: /mimo-distill [focus].',
    handler: async ({ agent, rawInput }) => {
      if (!agent) return failure('no agent')
      if (!runtime.config.memoryWrite) return failure('memory writing is disabled (memoryWrite=false)')
      const scope = await scopeFor(agent)
      try {
        const result = await runDistill(runtime.ctx, { agent, store: runtime.store, scope, config: runtime.config, focus: String(rawInput ?? '').trim() || undefined })
        return success(`skill written: ${result.file}`)
      } catch (error) {
        return failure(`distill failed: ${String(error && error.message || error)}`)
      }
    },
  })

  runtime.logger.info?.('dsh-mimo-context: slash commands registered (/mimo-status, /mimo-checkpoint, /mimo-rebuild, /mimo-compact, /mimo-memory, /mimo-history, /mimo-dream, /mimo-distill)')
}

