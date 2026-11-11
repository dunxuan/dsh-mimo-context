// dsh-mimo-context — MiMo Code "infinite context" port for DeepSeek Harness.
//
// Behaviour mirrors MiMo Code (v0.1.16/main) as closely as DSH's 0.2.2 seams
// allow:
//   - checkpoint writer ladder on the compaction-trigger window, with
//     CHECKPOINT_RESERVED clamping and a final-rung recovery gate;
//   - writer coverage stops at a token-budgeted 10K-20K tail (computeBoundary),
//     watermark advances only on success;
//   - rebuild replaces the whole visible window with a MiMo renderRebuildContext
//     dump (tasks / checkpoint / recent user / project+global memory / notes /
//     memory index / activity digest / seam framing / tail reminder) and copies
//     unanswered user messages in full;
//   - rebuild-first decision, ordinary compaction only when no usable checkpoint
//     exists and the writer failed / writing is disabled;
//   - MiMo memory layout (session / project / global), notes draining, dream and
//     distill opt-in intervals.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  normalizeConfig,
  resolveCheckpointLadder,
  maxAllowedFor,
} from './lib/config.js'
import { Store } from './lib/storage.js'
import { SessionState, WindowCache } from './lib/state.js'
import { awaitWriter, startCheckpointWriter, classifyWriterFailure } from './lib/checkpoint.js'
import { buildMemoryInjection, buildRebuildBlocks, runDream, runDistill } from './lib/memory.js'
import { measure, previewRebuildFit, resolveRoute, resolveWindow, runRebuildTransaction } from './lib/compaction.js'
import { runFallbackCompaction } from './lib/fallback-compaction.js'
import { registerTools } from './lib/tools.js'
import { registerCommands } from './lib/commands.js'
import { buildMemoryInstructions } from './lib/prompts.js'
import { planThresholdFires, armFinalRetry } from './lib/thresholds.js'
import { estimateTokens, nowIso } from './lib/util.js'

export const name = 'dsh-mimo-context'

export const inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'commands']

function makeLogger(ctx, config) {
  const emit = (level) => (message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](String(message))
    } catch {}
  }
  return {
    info: emit('info'),
    warn: emit('warn'),
    debug: (message) => {
      if (config.debug) emit('info')(`[debug] ${String(message)}`)
    },
  }
}

function isSubagentAgent(agent) {
  try {
    if (agent?.parentAgent !== undefined && agent?.parentAgent !== null) return true
    const header = agent?.session?.header
    if (header?.parentSession !== undefined) return true
    if (header?.origin === 'subagent') return true
    if (Number.isFinite(header?.delegationDepth) && header.delegationDepth > 0) return true
    return false
  } catch {
    return false
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = makeLogger(ctx, config)
  const store = new Store(config, logger)
  const states = new SessionState()
  const windowCache = new WindowCache()
  const warningOnce = (state, key, message) => {
    if (state.warned.has(key)) return
    state.warned.add(key)
    logger.warn(message)
  }

  async function ensureCwd(agent, signal) {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.ensure === 'function') {
        const cwd = await workingDirectory.ensure(agent, signal)
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      }
    } catch {}
    try {
      const cwd = agent?.session?.header?.cwd ?? agent?.session?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {}
    return process.cwd()
  }

  function routeKey(agent) {
    const session = agent?.session
    if (!session) return 'unknown'
    const route = resolveRoute(session, agent)
    const header = session.requestHeader?.()
    return `${route?.provider ?? '?'}/${route?.model ?? '?'}:${header?.config?.maxTokens ?? 'default'}`
  }

  async function getWindow(agent) {
    const key = routeKey(agent)
    const cached = windowCache.get(key)
    if (cached !== undefined) return cached
    const value = await resolveWindow(ctx, agent.session, agent, config)
    windowCache.set(key, value)
    return value
  }

  const debugEnabled = process.env.DSH_MIMO_DEBUG === '1' || config.debug
  const tracePath = process.env.DSH_MIMO_TRACE || join(tmpdir(), 'dsh-mimo-context-trace.log')
  const trace = (phase, data) => {
    if (!debugEnabled) return
    try {
      appendFileSync(tracePath, `${JSON.stringify({ at: nowIso(), phase, ...data })}\n`)
    } catch {}
  }

  const runtime = { ctx, config, store, states, windowCache, logger, ensureCwd, getWindow, routeKey, trace }

  function scopeFor(cwd, session) {
    return { cwd, sessionId: session?.id }
  }

  /**
   * MiMo teaches the memory system in the system prompt. DSH exposes a scoped
   * prompt-section registry (dsh-system-prompt), so register a real section on
   * each fresh main agent instead of the fallback user reminder.
   */
  function onAgentCreated(payload) {
    const agent = payload?.agent
    if (!agent || !agent.ctx) return
    const header = agent.session?.header
    if (header?.parentSession !== undefined || header?.origin === 'subagent') return
    if (!config.injectMemoryInstructions) return
    try {
      const prompt = agent.ctx.get?.('systemPrompt') ?? agent.ctx.systemPrompt
      if (!prompt || typeof prompt.section !== 'function') return
      const cwd = header?.cwd ?? process.cwd()
      const paths = store.paths({ cwd, sessionId: agent.id })
      const text = buildMemoryInstructions(paths, { checkpointEnabled: config.checkpointEnabled })
      prompt.section({ name: 'mimo:memory-system', order: 9000, text, interpolate: false })
      states.for(agent.id).memorySectionRegistered = true
    } catch (error) {
      logger.debug(`dsh-mimo-context: system prompt section unavailable: ${String(error && error.message || error)}`)
    }
  }

  ctx.on('agent/created', onAgentCreated)

  registerTools(runtime)
  registerCommands(runtime)

  function thresholdsFor(window, state) {
    try {
      return resolveCheckpointLadder(config, window.rebuildAt)
    } catch (error) {
      warningOnce(state, 'thresholds', `dsh-mimo-context: checkpoint thresholds disabled: ${String(error && error.message || error)}`)
      return []
    }
  }

  function maybeStartWriter(agent, scope, state, reason) {
    if (state.writerRunning) return state.writerPromise
    try {
      const promise = startCheckpointWriter(ctx, { agent, store, scope, config, state, reason })
      promise.then((result) => trace('writer-ok', {
        session: agent.session.id,
        reason,
        backend: result.backend,
        provider: result.subagentProvider || undefined,
        checkpointTokens: estimateTokens(result.checkpoint),
        memoryTokens: estimateTokens(result.memory),
        ...(result.auxFailure === undefined ? {} : { fallback: `${result.auxFailure.backend}: ${result.auxFailure.message}` }),
      })).catch((error) => logger.warn(`dsh-mimo-context: checkpoint writer failed: ${String(error && error.message || error)}`))
      state.lastWriterStartedAt = Date.now()
      return promise
    } catch (error) {
      logger.warn(`dsh-mimo-context: checkpoint writer failed to start: ${String(error && error.message || error)}`)
      return undefined
    }
  }

  async function awaitWriterBounded(state, ms) {
    if (!state.writerRunning || state.writerPromise === null) return 'no-writer'
    let timer
    try {
      return await Promise.race([
        state.writerPromise.then(() => 'success', () => 'failure'),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  function resetLadder(state) {
    state.crossed.clear()
    state.finalRetryAt = undefined
  }

  /** Fire checkpoint writers for newly-crossed thresholds (MiMo fireCheckpoints). */
  async function fireCheckpoints(agent, scope, state, pressure, window) {
    if (!config.checkpointEnabled || !config.memoryWrite || !config.autoCheckpoint) return
    const thresholds = thresholdsFor(window, state)
    if (thresholds.length === 0) return
    if (pressure < thresholds[0]) return
    // MiMo skips the whole invocation while a writer is running and does not
    // consume crossed thresholds (the next invocation can re-fire them).
    if (state.writerRunning) return

    const maxAllowed = maxAllowedFor(window.rebuildAt, config.checkpointReserved)
    const plan = planThresholdFires({
      thresholds,
      crossed: state.crossed,
      pressure,
      finalRetryAt: state.finalRetryAt,
    })
    const { newlyCrossed, finalReady, maxThreshold, step } = plan
    if (newlyCrossed.length === 0 && !finalReady) return
    if (finalReady) state.finalRetryAt = undefined
    const started = maybeStartWriter(agent, scope, state, `threshold ${finalReady ? maxThreshold : newlyCrossed[newlyCrossed.length - 1]} tokens`)
    if (started === undefined) return
    if (finalReady) {
      // The gate is consumed by the attempt; a further retryable failure arms a
      // new one step higher.
      state.crossed.add(maxThreshold)
    } else {
      for (const threshold of newlyCrossed) state.crossed.add(threshold)
    }
    const firedAt = pressure
    started.catch(() => {})
    const settle = started.then(
      () => undefined,
      () => {
        const failure = state.writerFailure
        if (!failure?.classification?.retryable) return
        if (!state.crossed.has(maxThreshold)) return
        const gate = armFinalRetry({ firedAt, step, maxAllowed })
        if (gate !== undefined) state.finalRetryAt = gate
      },
    )
    settle.catch(() => {})
    trace('checkpoint-fired', { session: agent.session.id, pressure, thresholds: newlyCrossed, finalReady })
  }

  async function fallbackCompaction(agent, scope, state, reason, trigger = 'automatic') {
    if (!config.fallbackCompaction) return false
    try {
      const result = await runFallbackCompaction(ctx, { agent, config, trigger })
      state.rebuildCount += 1
      state.lastRebuildAt = Date.now()
      resetLadder(state)
      store.setMeta(scope, {
        fallbackCompactions: (store.meta(scope).fallbackCompactions ?? 0) + 1,
        lastFallbackAt: nowIso(),
        lastFallbackReason: reason,
        lastShadowedTokens: result.shadowedTokenCount,
      })
      trace('fallback-compaction-ok', { session: agent.session.id, reason, trigger, shadowed: result.shadowedTokenCount })
      logger.info(`dsh-mimo-context: ordinary compaction fallback (${trigger}) shadowed ~${result.shadowedTokenCount} tokens`)
      return true
    } catch (error) {
      trace('fallback-compaction-failed', { session: agent.session.id, reason, error: String(error && error.message || error) })
      logger.warn(`dsh-mimo-context: ordinary compaction fallback failed; native compaction remains available: ${String(error && error.message || error)}`)
      return false
    }
  }

  /**
   * MiMo rebuildEnsuringCheckpoint: rebuild from whatever is on disk; if no
   * usable checkpoint exists, start/await a writer (bounded); only when that
   * fails may the caller fall back to ordinary compaction. When a checkpoint
   * exists but the insert fails the plugin adds no summary of its own; with
   * {prepend:true} the already-registered native compaction listener still
   * runs on next() as DSH's last-resort path (there is no veto seam).
   */
  /**
   * Render the rebuild dump and, when the DSH shrink guard would reject it
   * (replacement >= shadowed route tokens), rescale only the non-checkpoint
   * caps and re-render — up to two passes. The checkpoint section is never
   * scaled, so its § structure is preserved; if it alone cannot fit, the
   * returned rendered.fitError sends the caller to insert-failed.
   */
  function renderFittingBlocks(agent, scope, watermark) {
    const build = (caps) => buildRebuildBlocks(
      ctx,
      store,
      scope,
      caps === undefined ? config : { ...config, pushCaps: caps },
      { agent, boundarySeq: watermark },
    )
    const SCALED_KEYS = ['focusTask', 'tasksLedger', 'actorLedger', 'memoryTitles', 'global', 'memory', 'notes', 'recentUser', 'recentUserPerMsg']
    let rendered = build(undefined)
    if (rendered === null) return null
    let fit = previewRebuildFit(ctx, agent, rendered.blocks, { replaceAll: true })
    for (let pass = 0; pass < 2 && !fit.fits && fit.reason === 'too-large'; pass += 1) {
      const scale = Math.max(0.05, Math.min(0.75, (fit.shadowedRoute * 0.9) / Math.max(1, fit.replacementTokens)))
      const caps = { ...config.pushCaps }
      for (const key of SCALED_KEYS) {
        if (typeof caps[key] === 'number') caps[key] = Math.max(0, Math.floor(caps[key] * scale))
      }
      rendered = build(caps)
      if (rendered === null) return null
      fit = previewRebuildFit(ctx, agent, rendered.blocks, { replaceAll: true })
    }
    rendered.fit = fit
    if (!fit.fits) {
      const error = new Error(`dsh-mimo-context: rebuild body cannot shrink the surface (replacement ${fit.replacementTokens} >= shadowed ${fit.shadowedRoute} route tokens; reason=${fit.reason})`)
      error.code = 'REBUILD_DID_NOT_FIT'
      rendered.fitError = error
    }
    return rendered
  }

  async function rebuildEnsuringCheckpoint(agent, scope, state, options = {}) {
    if (!config.checkpointEnabled) return { attempt: 'checkpoint-off' }
    if (!config.memoryWrite) return { attempt: 'memory-write-off' }
    const manual = options.manual === true
    const read = () => store.read(scope)

    // 1. Existing usable checkpoint: optionally wait briefly for a fresher one.
    let current = read()
    if (current.hasUsableCheckpoint) {
      if (state.writerRunning) await awaitWriterBounded(state, config.existingCheckpointWaitMs)
      current = read()
      const rendered = renderFittingBlocks(agent, scope, current.watermark)
      if (rendered === null) return { attempt: 'insert-failed', reason: 'nothing-to-render' }
      if (rendered.fitError) return { attempt: 'insert-failed', error: rendered.fitError }
      try {
        const result = await runRebuildTransaction(ctx, agent, {
          blocks: rendered.blocks,
          replaceAll: true,
          signal: options.signal,
          stage: 'mimo rebuild',
          maxTokens: options.maxTokens,
        })
        return { attempt: 'rebuilt', result, rendered }
      } catch (error) {
        // Plugin-owned compaction is not attempted here (MiMo insert-failed);
        // DSH native compaction may still run after next() as last resort.
        return { attempt: 'insert-failed', error }
      }
    }

    // 2. No usable checkpoint: start a writer and wait (bounded), then rebuild.
    if (!state.writerRunning) {
      maybeStartWriter(agent, scope, state, 'pre-rebuild checkpoint')
    }
    const wait = manual
      ? config.manualRebuildWaitMs
      : config.firstCheckpointWaitMs
    if (state.writerRunning) await awaitWriterBounded(state, wait)
    current = read()
    if (!current.hasUsableCheckpoint) return { attempt: 'writer-failed' }
    const rendered = renderFittingBlocks(agent, scope, current.watermark)
    if (rendered === null) return { attempt: 'insert-failed', reason: 'nothing-to-render' }
    if (rendered.fitError) return { attempt: 'insert-failed', error: rendered.fitError }
    try {
      const result = await runRebuildTransaction(ctx, agent, {
        blocks: rendered.blocks,
        replaceAll: true,
        signal: options.signal,
        stage: 'mimo rebuild',
        maxTokens: options.maxTokens,
      })
      return { attempt: 'rebuilt', result, rendered }
    } catch (error) {
      return { attempt: 'insert-failed', error }
    }
  }

  async function onPreStep(payload, next) {
    const agent = payload?.agent
    if (!agent || !agent.session) return next()
    if (config.mainOnly && isSubagentAgent(agent)) return next()

    const session = agent.session
    const state = states.for(session.id)
    if (Number.isFinite(payload.turn)) state.lastTurn = payload.turn
    let cwd
    try {
      cwd = await ensureCwd(agent, payload.signal)
      store.ensure(scopeFor(cwd, session))
    } catch (error) {
      warningOnce(state, 'storage', `dsh-mimo-context: memory storage unavailable: ${String(error && error.message || error)}`)
      return next()
    }
    const scope = scopeFor(cwd, session)

    let window
    try {
      window = await getWindow(agent)
    } catch (error) {
      warningOnce(state, 'window', `dsh-mimo-context: window resolution failed: ${String(error && error.message || error)}`)
      window = undefined
    }

    if (window !== undefined) {
      let measurement
      try {
        measurement = measure(ctx, session)
        state.lastPressure = measurement.totalTokens
        trace('pre-step', {
          session: session.id,
          step: payload.step,
          pressure: measurement.totalTokens,
          rebuildAt: window.rebuildAt,
          nativeTrigger: window.nativeTrigger,
          thresholds: thresholdsFor(window, state),
          pendingRebuild: state.pendingRebuild,
          checkpointEnabled: config.checkpointEnabled,
          memoryWrite: config.memoryWrite,
        })
      } catch (error) {
        warningOnce(state, 'meter', `dsh-mimo-context: token measurement failed: ${String(error && error.message || error)}`)
      }

      if (measurement !== undefined) {
        await fireCheckpoints(agent, scope, state, measurement.totalTokens, window)

        const cooldownActive = Date.now() - state.lastRebuildAt < config.rebuildCooldownMs
        const shouldRebuild = config.autoRebuild && (
          state.pendingRebuild ||
          (measurement.totalTokens >= window.rebuildAt && !cooldownActive)
        )
        if (shouldRebuild) {
          const manual = state.pendingRebuild
          const reason = manual
            ? (state.pendingRebuildReason ?? 'queued rebuild')
            : `pressure ${measurement.totalTokens} >= rebuildAt ${window.rebuildAt}`
          state.pendingRebuild = false
          state.pendingRebuildReason = undefined
          const outcome = await rebuildEnsuringCheckpoint(agent, scope, state, {
            manual,
            signal: payload.signal,
            maxTokens: window.output,
          })
          if (outcome.attempt === 'rebuilt') {
            state.rebuildCount += 1
            state.lastRebuildAt = Date.now()
            resetLadder(state)
            state.lastInjectedGeneration = store.read(scope).generation
            const meta = store.meta(scope)
            store.setMeta(scope, {
              rebuilds: (meta.rebuilds ?? 0) + 1,
              lastRebuildAt: nowIso(),
              lastRebuildReason: reason,
              lastShadowedTokens: outcome.result.shadowedTokenCount,
            })
            logger.info(`dsh-mimo-context: rebuild replaced the window (~${outcome.result.shadowedTokenCount} tokens) with a checkpoint dump (~${outcome.result.replacementTokens} tokens)`)
            trace('rebuild-ok', { session: session.id, reason, shadowed: outcome.result.shadowedTokenCount, replacement: outcome.result.replacementTokens, diagnostics: outcome.rendered.diagnostics })
          } else if (outcome.attempt === 'writer-failed' || outcome.attempt === 'memory-write-off' || outcome.attempt === 'checkpoint-off') {
            // The single MiMo state in which compaction is allowed.
            await fallbackCompaction(agent, scope, state, reason, 'automatic')
          } else if (outcome.attempt === 'insert-failed') {
            // MiMo: a usable checkpoint exists but the insert failed — NEVER
            // amputate the history we hold a checkpoint for. Let the request
            // proceed; provider overflow is the backstop.
            logger.warn(`dsh-mimo-context: rebuild insert failed with a usable checkpoint; plugin compaction skipped (the prepended native DSH listener may still act after next()): ${String(outcome.error?.message ?? outcome.reason ?? 'unknown')}`)
            trace('rebuild-insert-failed', { session: session.id, reason, error: String(outcome.error?.message ?? outcome.reason ?? '') })
          }
        }
      }
    }

    const decision = await next()
    if (decision === undefined || decision.kind === 'reject') return decision

    try {
      // MiMo's system prompt always teaches the memory system; DSH exposes
      // ctx.systemPrompt.section (registered on agent/created). This reminder
      // is the fallback for profiles where that service is unavailable.
      if (config.injectMemoryInstructions && !state.memoryInstructionsInjected && !state.memorySectionRegistered) {
        const instruction = buildMemoryInstructions(store.paths(scope), { checkpointEnabled: config.checkpointEnabled })
        state.memoryInstructionsInjected = true
        const message = createUserMessage({
          content: [{ type: 'text', text: `<system-reminder>\n${instruction}\n</system-reminder>` }],
          source: { kind: 'plugin:dsh-mimo-context' },
        })
        trace('memory-instructions-injected', { session: session.id, tokens: estimateTokens(instruction) })
        return { ...decision, messages: [...decision.messages, message] }
      }

      if (config.injectOnStart && state.lastInjectedGeneration === undefined) {
        const current = store.read(scope)
        if (current.hasCheckpoint || current.hasMemory) {
          const injection = buildMemoryInjection(store, scope, config)
          if (injection !== null && estimateTokens(injection.text) > 20) {
            state.lastInjectedGeneration = injection.generation
            const message = createUserMessage({
              content: [{ type: 'text', text: injection.text }],
              source: { kind: 'plugin:dsh-mimo-context' },
            })
            trace('memory-injected', { session: session.id, tokens: estimateTokens(injection.text) })
            return { ...decision, messages: [...decision.messages, message] }
          }
        }
      }
    } catch (error) {
      warningOnce(state, 'inject', `dsh-mimo-context: memory injection skipped: ${String(error && error.message || error)}`)
    }

    // Auto dream/distill: MiMo checks on new session start only, opt-in, first
    // run gated by project age, 10s minimum spawn gap.
    if (state.lastAutoCheckAt === undefined && (config.dreamAuto || config.distillAuto)) {
      state.lastAutoCheckAt = Date.now()
      autoConsolidate(agent, scope, state).catch(() => {})
    }

    return decision
  }

  async function autoConsolidate(agent, scope, state) {
    if (!config.memoryWrite) return
    const now = Date.now()
    const meta = store.meta(scope)
    let projectCreatedAt = now
    try {
      projectCreatedAt = Date.parse(JSON.parse(readFileSync(store.paths(scope).projectMeta, 'utf8')).createdAt) || now
    } catch {}
    const due = (lastAt, intervalDays) => {
      const interval = intervalDays * 86400000
      const last = lastAt === undefined ? undefined : Date.parse(lastAt)
      if (last === undefined) return now - projectCreatedAt >= interval
      return now - last >= interval
    }
    if (config.dreamAuto && due(meta.dreamAt, config.dreamIntervalDays) && now - (state.lastDreamAt ?? 0) > 10000) {
      state.lastDreamAt = now
      try {
        const result = await runDream(ctx, { agent, store, scope, config, signal: undefined })
        store.setMeta(scope, { dreamAt: nowIso() })
        logger.info(`dsh-mimo-context: auto dream consolidated project memory (${estimateTokens(result.memory)} tokens)`)
      } catch (error) {
        logger.warn(`dsh-mimo-context: auto dream failed: ${String(error && error.message || error)}`)
      }
    }
    if (config.distillAuto && due(meta.distillAt, config.distillIntervalDays) && now - (state.lastDistillAt ?? 0) > 10000) {
      state.lastDistillAt = now
      try {
        const result = await runDistill(ctx, { agent, store, scope, config })
        store.setMeta(scope, { distillAt: nowIso() })
        logger.info(`dsh-mimo-context: auto distill wrote ${result.name}`)
      } catch (error) {
        logger.warn(`dsh-mimo-context: auto distill failed: ${String(error && error.message || error)}`)
      }
    }
  }

  async function onRequestError(payload, next) {
    const { agent, failure, signal } = payload ?? {}
    if (!config.overflowRebuild || failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal?.aborted) return next()
    if (!agent || !agent.session) return next()
    if (config.mainOnly && isSubagentAgent(agent)) return next()
    const session = agent.session
    const state = states.for(session.id)
    const generation = session.surface.replaceGeneration
    try {
      const cwd = await ensureCwd(agent, signal)
      const scope = scopeFor(cwd, session)
      store.ensure(scope)
      let outcome = await rebuildEnsuringCheckpoint(agent, scope, state, { manual: false, signal })
      if (outcome.attempt === 'rebuilt') {
        state.rebuildCount += 1
        state.lastRebuildAt = Date.now()
        resetLadder(state)
        state.lastInjectedGeneration = store.read(scope).generation
        const meta = store.meta(scope)
        store.setMeta(scope, {
          rebuilds: (meta.rebuilds ?? 0) + 1,
          lastRebuildAt: nowIso(),
          lastRebuildReason: 'provider overflow',
          lastShadowedTokens: outcome.result.shadowedTokenCount,
        })
        if (session.surface.replaceGeneration > generation) {
          trace('overflow-rebuild-ok', { session: session.id })
          logger.info('dsh-mimo-context: rebuilt after context overflow; retrying the request')
          return { kind: 'retry' }
        }
      }
      if (outcome.attempt === 'writer-failed' || outcome.attempt === 'memory-write-off' || outcome.attempt === 'checkpoint-off') {
        const compacted = await fallbackCompaction(agent, scope, state, 'provider overflow', 'provider-overflow')
        if (compacted && session.surface.replaceGeneration > generation) return { kind: 'retry' }
      }
      if (outcome.attempt === 'insert-failed') {
        logger.warn(`dsh-mimo-context: overflow rebuild failed with a usable checkpoint; plugin compaction skipped (the prepended native DSH listener may still act after next()): ${String(outcome.error?.message ?? outcome.reason ?? '')}`)
      }
    } catch (error) {
      logger.warn(`dsh-mimo-context: overflow rebuild failed: ${String(error && error.message || error)}`)
    }
    return next()
  }

  ctx.on('agent/pre-step', onPreStep)
  ctx.on('agent/request-error', onRequestError, { prepend: true })
  logger.info('dsh-mimo-context: mounted (MiMo checkpoints + rebuild dump + memory)')

  if (debugEnabled) {
    try {
      const services = {}
      for (const serviceName of ['llm', 'tokenMeter', 'sessions', 'tools', 'commands', 'workingDirectory', 'compaction']) {
        try {
          services[serviceName] = typeof ctx.get(serviceName)
        } catch {
          services[serviceName] = 'error'
        }
      }
      writeFileSync(
        process.env.DSH_MIMO_MARKER || join(tmpdir(), 'dsh-mimo-context-loaded.json'),
        JSON.stringify({
          plugin: 'dsh-mimo-context',
          pid: process.pid,
          at: nowIso(),
          services,
          config: {
            checkpoints: config.checkpoints,
            checkpointDensity: config.checkpointDensity,
            checkpointReserved: config.checkpointReserved,
            rebuildAt: config.rebuildTriggerTokens,
            injectOnStart: config.injectOnStart,
            storageLayout: config.storage.layout,
          },
        }, null, 2),
      )
    } catch {}
  }
}
