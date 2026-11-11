// MiMo ordinary compaction fallback.
//
// MiMo only degrades to compaction when no usable checkpoint exists and the
// on-the-spot writer failed (or checkpoint/memory writing is disabled). Its
// compaction is lossy by construction: a 5-part continuation summary, a 5-file
// manifest, and whole API rounds that arrived during summarization. DSH native
// compaction is the ultimate fallback; this module implements MiMo's own path so
// the plugin's rebuild-vs-compact decision matches MiMo.

import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import { resolveRoute, runRebuildTransaction } from './compaction.js'
import {
  COMPACTION_INSTRUCTION,
  buildCompactionSummaryMessage,
  buildFilesTouchedManifest,
} from './prompts.js'
import { estimateTokens } from './util.js'

const FILE_MANIFEST_LIMIT = 5
const COMPACTION_INPUT_TOKEN_LIMIT = 120000

function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': {
      const error = new Error('dsh-mimo-context: compaction summary truncated at the token cap')
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function stripMediaBlocks(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    const content = message.content.filter((block) => block?.type !== 'image' && block?.type !== 'file')
    return { ...message, content }
  })
}

function trimMessages(messages, budgetTokens) {
  if (messages.length === 0) return []
  let total = 0
  let keepFrom = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = estimateTokens(messageText(messages[index])) + 8
    if (total + cost > budgetTokens && index < messages.length - 1) break
    total += cost
    keepFrom = index
  }
  const system = messages[0]?.role === 'system' ? messages[0] : undefined
  const suffix = messages.slice(keepFrom)
  return system !== undefined && keepFrom > 0 ? [system, ...suffix] : suffix
}

function visibleMessages(session) {
  const messages = []
  for (const seq of session.surface.nodes) {
    try {
      const message = session.deriveEventMessage(session.eventAt(seq))
      if (message !== null && message !== undefined) messages.push(message)
    } catch {}
  }
  return messages
}

/** MiMo buildFileManifest: last 5 files touched by read/write/edit tool calls. */
export function buildFilesTouched(session) {
  const touched = new Map()
  const add = (file) => {
    if (typeof file !== 'string' || file.trim().length === 0) return
    const normalized = file.replaceAll('\\', '/')
    touched.delete(normalized)
    touched.set(normalized, true)
  }
  let events = []
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    events = []
  }
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    let args
    try {
      args = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments
    } catch {
      continue
    }
    if (!args || typeof args !== 'object') continue
    add(args.file_path ?? args.filePath ?? args.path ?? args.notebook_path)
  }
  return [...touched.keys()].slice(-FILE_MANIFEST_LIMIT)
}

async function summarize(ctx, { agent, config, signal }) {
  const session = agent.session
  const route = config.writerProvider.length > 0 && config.writerModel.length > 0
    ? { provider: config.writerProvider, model: config.writerModel }
    : resolveRoute(session, agent)
  if (!route) throw new Error('dsh-mimo-context: no provider/model for fallback compaction')
  const messages = trimMessages(visibleMessages(session), COMPACTION_INPUT_TOKEN_LIMIT)
  const instruction = { role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }] }
  const assembler = new BlockAssembler()
  const options = {
    provider: route.provider,
    model: route.model,
    messages: stripMediaBlocks([...messages, instruction]),
    maxTokens: Math.min(config.writerMaxTokens, 16000),
    sessionId: session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const blocks = assembler.blocks()
  if (contentHasImage(blocks)) throw new Error('dsh-mimo-context: compaction summary returned image content')
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(text)
  const summary = (match ? match[1] : text).trim()
  if (summary.length === 0) throw new Error('dsh-mimo-context: compaction produced no usable summary')
  return summary
}

/**
 * Run MiMo ordinary compaction: summarize, then replace the whole visible
 * window with the `<conversation-summary>` boundary + files-touched manifest.
 *
 * @returns {{compactionId, summary, files, shadowedTokenCount}} or throws.
 */
export async function runFallbackCompaction(ctx, options) {
  const { agent, config, signal, trigger = 'automatic' } = options
  const session = agent.session
  const summary = await summarize(ctx, { agent, config, signal })
  const files = buildFilesTouched(session)
  const blocks = [
    { type: 'text', text: buildCompactionSummaryMessage(summary, trigger, false) },
  ]
  const manifest = buildFilesTouchedManifest(files)
  if (manifest) blocks.push({ type: 'text', text: manifest })
  const result = await runRebuildTransaction(ctx, agent, {
    blocks,
    replaceAll: true,
    signal,
    stage: `mimo ${trigger} compaction`,
    maxTokens: config.writerMaxTokens,
  })
  return { ...result, summary, files, trigger }
}
