// DSH 0.2.2 compaction-seam bridge for the MiMo rebuild.
//
// The transaction below mirrors @deepseek-ai/dsh-compaction-basic@0.2.2's
// durable region transaction (lock, open-turn ownership, summary record,
// replacement user message, single close attempt) but the replacement body is
// a MiMo checkpoint bundle supplied by the caller instead of a model summary.

import { CompactionId, ManualCompactionError, compactCheckpointSource, toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'

export const DSH_COMPACTION_HEADROOM = 65536

/** The `system/message` at surface node 0, if the surface starts with one. */
export function systemHead(session, headSeq) {
  const head = session.eventAt(headSeq)
  return head && head.type === 'system/message' ? head : undefined
}

/** Resolve the route of the latest durable request, falling back to agent options. */
export function resolveRoute(session, agent) {
  const config = session.requestHeader()?.config
  if (config && typeof config.provider === 'string' && config.provider.length > 0 && typeof config.model === 'string' && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const options = agent?.options
  if (options && typeof options.provider === 'string' && options.provider.length > 0 && typeof options.model === 'string' && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return undefined
}

/**
 * Resolve window, request output reservation, DSH native compaction trigger and
 * the MiMo rebuild trigger for the current route.
 */
export async function resolveWindow(ctx, session, agent, config, signal) {
  const route = resolveRoute(session, agent)
  if (!route) throw new Error('dsh-mimo-context: no routed provider/model available yet')
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  const window = info?.context?.contextWindow
  if (!Number.isFinite(window) || window <= 0) {
    throw new Error(`dsh-mimo-context: adapter did not report a context window for ${route.provider}/${route.model}`)
  }
  const header = session.requestHeader()
  const output = header?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0
  const native = Math.floor(Math.min(window * 0.8, window - output - DSH_COMPACTION_HEADROOM))
  const margin = config.rebuildMarginTokens ?? Math.max(8192, Math.floor(window * 0.01))
  let rebuildAt = Number.isFinite(config.rebuildTriggerTokens) && config.rebuildTriggerTokens > 0
    ? config.rebuildTriggerTokens
    : native - margin
  if (!(rebuildAt > 0)) rebuildAt = Math.floor(window * 0.75)
  return {
    route,
    window,
    output,
    nativeTrigger: native > 0 ? native : null,
    margin,
    rebuildAt: Math.floor(rebuildAt),
    dummy: false,
  }
}

/** Measure current pressure; returns the token-meter measurement. */
export function measure(ctx, session) {
  const header = session.requestHeader()
  return header === undefined ? ctx.tokenMeter.measure(session) : ctx.tokenMeter.measure(session, header)
}

/**
 * Port of compaction-basic's retention selection. `retainTokens` keeps a priced
 * tail; MiMo rebuilds do not keep an arbitrary tail, so `replaceAll` selects the
 * whole non-system surface (the boundary dump carries the digest instead).
 */
export function selectRebuildRange(session, measurement, retainTokens, options = {}) {
  const pricedNodes = measurement.nodes
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('dsh-mimo-context: token-meter surface does not match the current session surface')
  }
  const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1
  if (options.replaceAll) {
    if (surfaceNodes.length - 1 <= firstIdx) return null
    return { start: surfaceNodes[firstIdx], end: surfaceNodes[surfaceNodes.length - 1] }
  }
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
}

function hasTextContent(event) {
  try {
    const message = event?.data?.message ?? event?.data
    const content = message?.content
    if (!Array.isArray(content)) return false
    return content.some((block) => block && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string' && block.text.trim().length > 0)
  } catch {
    return false
  }
}

/**
 * MiMo computeBoundary: choose the first message the checkpoint writer preserves
 * verbatim (the writer covers everything strictly before it). The tail is
 * token-budgeted: start at last finished assistant - 1; expand backwards while
 * below tailMinTokens or tailMinTextBlockMessages, up to tailMaxTokens; a
 * naturally larger tail is never truncated. `null` means there is nothing before
 * the tail for the writer to cover.
 *
 * DSH surface nodes are event seqs; priced node tokens come from the token meter.
 */
export function computeWriterWatermark(session, measurement, config) {
  const surfaceNodes = session.surface.nodes
  const priced = measurement?.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) return null
  if (!Array.isArray(priced) || priced.length !== surfaceNodes.length) return null
  const events = surfaceNodes.map((seq) => session.eventAt(seq))
  const firstIdx = systemHead(session, surfaceNodes[0]) === undefined ? 0 : 1
  let lastAssistantIdx = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'assistant/message') {
      lastAssistantIdx = index
      break
    }
  }
  if (lastAssistantIdx <= 0) return null
  const tailMin = config.tailMinTokens ?? 10000
  const tailMax = config.tailMaxTokens ?? 20000
  const minText = config.tailMinTextBlockMessages ?? 5
  const tokenAt = (index) => priced[index]?.tokens ?? priced[index]?.heuristicTokens ?? 0
  let startIdx = lastAssistantIdx - 1
  let tailSum = 0
  let textBlocks = 0
  for (let index = startIdx; index < events.length; index += 1) {
    tailSum += tokenAt(index)
    if (hasTextContent(events[index])) textBlocks += 1
  }
  if (tailSum < tailMax) {
    while (startIdx > firstIdx && tailSum < tailMax && (tailSum < tailMin || textBlocks < minText)) {
      startIdx -= 1
      tailSum += tokenAt(startIdx)
      if (hasTextContent(events[startIdx])) textBlocks += 1
    }
  }
  // Tool pairing: walk the candidate boundary back until balanced.
  while (startIdx > firstIdx && !toolPairingBalancedBefore(session, surfaceNodes[startIdx])) startIdx -= 1
  if (startIdx <= firstIdx) return null
  return {
    startSeq: surfaceNodes[startIdx],
    startIdx,
    tailTokens: tailSum,
    textBlocks,
    tailMessageCount: events.length - startIdx,
  }
}

/** Validate one inclusive surface span for replacement. */
export function validateSurfaceRegion(session, start, end) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`dsh-mimo-context: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`dsh-mimo-context: end seq ${end} not found in surface`)
  if (startIdx > endIdx) throw new Error(`dsh-mimo-context: start seq ${start} is after end seq ${end}`)
  if (!toolPairingBalancedBefore(session, nodes[startIdx])) throw new Error(`dsh-mimo-context: start seq ${start} is not a balanced boundary`)
  if (!toolPairingBalancedAfter(session, nodes[endIdx])) throw new Error(`dsh-mimo-context: end seq ${end} is not a balanced boundary`)
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Inspect open turn, latest unmatched compaction start and latest seed boundary. */
export function inspectCompactionEntryState(session) {
  let openTurn = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart
  let compactionEntryStateKnown = false
  let latestEndSeedSeq
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') compactionEntryStateKnown = true
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') openTurnStateKnown = true
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

export function assertCompactionInactive(entryState, stage) {
  const { unmatchedCompactionStart, latestEndSeedSeq } = entryState
  if (unmatchedCompactionStart === undefined) return
  if (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq) return
  throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is active`)
}

/** Sum priced tokens for the selected surface nodes. */
function shadowedPrices(measurement, shadowedSeqs) {
  const bySeq = new Map(measurement.nodes.map((node) => [node.seq, node]))
  let heuristic = 0
  let route = 0
  for (const seq of shadowedSeqs) {
    const node = bySeq.get(seq)
    if (node === undefined) throw new Error(`dsh-mimo-context: priced surface node ${seq} disappeared`)
    heuristic += node.heuristicTokens ?? node.tokens ?? 0
    route += node.tokens ?? 0
  }
  return { heuristic, route }
}

/**
 * Pre-flight the shrink guard WITHOUT mutating the session.
 *
 * The guard itself (heuristic price of the replacement >= route price of the
 * shadowed span) is identical to dsh-compaction-basic 0.2.2's own check, so it
 * stays authoritative in runRebuildTransaction. This preview lets the caller
 * adapt the dump (scale non-checkpoint caps) before committing, turning a
 * would-be insert-failed into a smaller-but-valid rebuild on narrow windows.
 */
export function previewRebuildFit(ctx, agent, blocks, options = {}) {
  const session = agent?.session
  const empty = { fits: false, replacementTokens: 0, shadowedRoute: 0, shadowedHeuristic: 0, shadowedCount: 0 }
  if (!session) return { ...empty, reason: 'no-session' }
  try {
    const measurement = measure(ctx, session)
    const range = options.range
      ?? selectRebuildRange(session, measurement, options.retainTokens ?? 0, { replaceAll: options.replaceAll !== false })
    if (range === null) return { ...empty, reason: 'no-range' }
    const selection = validateSurfaceRegion(session, range.start, range.end)
    const prices = shadowedPrices(measurement, selection.shadowedSeqs)
    const probe = createUserMessage({ content: blocks, source: { kind: 'user' } })
    const replacementTokens = ctx.tokenMeter.estimateMessage(probe)
    const fits = !(prices.route > 0 && replacementTokens >= prices.route)
    return {
      fits,
      reason: fits ? 'fits' : 'too-large',
      replacementTokens,
      shadowedRoute: prices.route,
      shadowedHeuristic: prices.heuristic,
      shadowedCount: selection.shadowedSeqs.length,
    }
  } catch (error) {
    return { ...empty, reason: 'measure-failed', error }
  }
}

/**
 * Run one rebuild transaction.
 * @param ctx plugin context (tokenMeter/sessions/llm services)
 * @param agent owning agent (open turn)
 * @param options {blocks, retainTokens, provider, model, signal, stage, sourceCommandId}
 */
export async function runRebuildTransaction(ctx, agent, options) {
  const { blocks, retainTokens = 0, signal } = options
  const session = agent.session
  const measurement = measure(ctx, session)
  const range = options.range ?? selectRebuildRange(session, measurement, retainTokens, { replaceAll: options.replaceAll !== false })
  if (range === null) throw new Error('dsh-mimo-context: no balanced range can be rebuilt')
  const selection = validateSurfaceRegion(session, range.start, range.end)
  const entry = inspectCompactionEntryState(session)
  assertCompactionInactive(entry, options.stage ?? 'mimo rebuild')
  if (entry.openTurn === null) throw new Error('dsh-mimo-context: rebuild requires an open turn')
  const route = options.provider !== undefined && options.model !== undefined
    ? { provider: options.provider, model: options.model }
    : resolveRoute(session, agent)
  if (!route) throw new Error('dsh-mimo-context: no routed provider/model for the summary record')

  const compactionId = CompactionId(randomUUID())
  const checkpointMessage = createUserMessage({
    content: blocks,
    source: compactCheckpointSource(compactionId, options.sourceCommandId),
  })
  const prices = shadowedPrices(measurement, selection.shadowedSeqs)
  const replacementTokens = ctx.tokenMeter.estimateMessage(checkpointMessage)
  if (replacementTokens >= prices.route && prices.route > 0) {
    throw new Error(`dsh-mimo-context: rebuild body is not smaller than the shadowed history (${replacementTokens} >= ${prices.route} route tokens)`)
  }

  const lifecycle = { compactionId, turn: entry.openTurn, ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }) }
  let startEvent
  let summaryEvent
  let endEvent
  try {
    startEvent = session.append('compaction/start', lifecycle)
    summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      summary: blocks,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount: prices.heuristic,
      provider: route.provider,
      model: route.model,
      ...(typeof options.maxTokens === 'number' ? { maxTokens: options.maxTokens } : {}),
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq: selection.start, endSeq: selection.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
    })
    endEvent = session.append('compaction/end', lifecycle)
  } catch (error) {
    try {
      if (startEvent !== undefined && endEvent === undefined) {
        // A failed close intentionally leaves the unmatched start in place; the
        // error field is a string in the 0.2.2 log schema (not an ErrorChain).
        session.append('compaction/end', { ...lifecycle, error: String(error && error.message || error) })
      }
    } catch (compensationError) {
      ctx.logger?.warn?.(`dsh-mimo-context: failed to compensate a rebuild transaction: ${String(compensationError)}`)
    }
    throw error
  }

  if (typeof ctx.sessions?.flush === 'function') {
    try {
      await ctx.sessions.flush(session)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-mimo-context: rebuild flush failed: ${String(error)}`)
    }
  }
  const shadowedSet = new Set(selection.shadowedSeqs)
  const retainedTailTokens = measurement.nodes
    .filter((node) => !shadowedSet.has(node.seq))
    .reduce((total, node) => total + (node.tokens ?? 0), 0)
  return {
    compactionId: String(compactionId),
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    endSeq: endEvent.seq,
    shadowedRange: { start: selection.start, end: selection.end },
    shadowedSeqs: [...selection.shadowedSeqs],
    shadowedTokenCount: prices.heuristic,
    replacementTokens,
    retainedTailTokens,
  }
}
