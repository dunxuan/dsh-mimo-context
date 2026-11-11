// Checkpoint writer: turns the conversation prefix into checkpoint.md +
// project MEMORY.md.
//
// MiMo Code runs this as a subagent with read/write/edit/task tools. DSH 0.2.2
// exposes a subagent seam (ctx.subagents fork/spawn), but fork cannot whitelist
// tools or seed a watermark slice, so the DEFAULT is `writerBackend: direct` —
// one text-only `ctx.llm.stream()` call over the watermark-capped prefix that
// returns tagged `<mimo-checkpoint>`/`<mimo-memory>` blocks. Setting
// `writerBackend: auto|subagent` additionally runs a fork/spawn child as an
// ISOLATED TAGGED-TEXT writer (it must not touch disk; the plugin persists
// under lock+CAS), falling back to direct when the seam is absent or the child
// fails.

import { BlockAssembler, LlmError, contentHasImage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { computeWriterWatermark, measure, resolveRoute } from './compaction.js'
import { CHECKPOINT_INSTRUCTION, CHECKPOINT_TOOL_LOOP_INSTRUCTION, CHECKPOINT_WRITER_MARKER } from './prompts.js'
import { CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, NOTES_TEMPLATE } from './storage.js'
import { latestTodoItems, renderTodoLedger } from './rebuild-context.js'
import { estimateTokens, sha1, truncateTokens, withTimeout } from './util.js'

const CHECKPOINT_TOKEN_BUDGET = 11000
const MEMORY_TOKEN_BUDGET = 10000

export const CHECKPOINT_SECTION_HEADERS = [
  '## §1 Active intent',
  '## §2 Next concrete action',
  '## §3 Directives (this session)',
  '## §4 Task tree',
  '## §5 Current work',
  '## §6 Files and code sections',
  '## §7 Discovered knowledge (cross-task)',
  '## §8 Errors and fixes',
  '## §9 Live resources',
  '## §10 Design decisions and discussion outcomes',
  '## §11 Open notes',
]

export const MEMORY_SECTION_HEADERS = [
  '## Project context',
  '## Rules',
  '## Architecture decisions',
  '## Discovered durable knowledge',
]

function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': {
      const error = new Error('checkpoint writer truncated at the token cap')
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

/** Surface messages with their surface index (needed for the watermark slice). */
export function visibleMessages(session) {
  const entries = []
  for (let index = 0; index < session.surface.nodes.length; index += 1) {
    const seq = session.surface.nodes[index]
    const event = session.eventAt(seq)
    const message = session.deriveEventMessage(event)
    if (message !== null && message !== undefined) entries.push({ index, seq, event, message })
  }
  return entries
}

/**
 * Keep the system head and a newest suffix within a token budget, never
 * starting the suffix with an orphan tool result.
 */
export function trimWriterMessages(messages, budgetTokens) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  let total = 0
  let started = false
  let keepFrom = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const cost = estimateTokens(messageText(message)) + 8
    if (started && total + cost > budgetTokens) break
    total += cost
    started = true
    keepFrom = index
  }
  const system = messages[0]?.role === 'system' ? messages[0] : undefined
  let suffix = messages.slice(keepFrom)
  while (suffix.length > 0 && suffix[0].role === 'tool') suffix = suffix.slice(1)
  if (suffix.length === 0) return system ? [system] : []
  return system !== undefined && keepFrom > 0 ? [system, ...suffix] : suffix
}

/** Render current memory files for the writer's context section. */
function writerContextBlock(store, scope, session) {
  const state = store.read(scope)
  const todos = renderTodoLedger(latestTodoItems(session))
  const tasks = todos ?? store.taskSummaries(scope).map((task) => `### ${task.id}\n${task.text}`).join('\n\n')
  const checkpoint = truncateTokens(state.checkpoint, CHECKPOINT_TOKEN_BUDGET)
  const memory = truncateTokens(state.memory, MEMORY_TOKEN_BUDGET)
  const notes = truncateTokens(state.notes, 6000)
  return [
    `CHECKPOINT_PATH = ${state.paths.checkpoint}`,
    `MEMORY_PATH     = ${state.paths.memory}`,
    `TASK_MEM_DIR    = ${state.paths.tasks}`,
    `NOTES_PATH      = ${state.paths.notes}`,
    '',
    'Current checkpoint.md:',
    '````markdown',
    checkpoint || '(empty)',
    '````',
    '',
    'Current MEMORY.md:',
    '````markdown',
    memory || '(empty)',
    '````',
    '',
    'Current notes.md (drain into the sections above; it will be reset to its template after a successful checkpoint):',
    '````markdown',
    notes || '(empty)',
    '````',
    '',
    'Task ledger for §4 (DSH todo_write when present, otherwise task progress files; never invent IDs):',
    '````markdown',
    tasks || '(none)',
    '````',
  ].join('\n')
}

/**
 * Build the messages for the writer: the covered conversation prefix (MiMo's
 * watermark excludes the recent tail) + current memory files + instruction.
 * Returns null when the whole visible conversation is tail and there is nothing
 * for the writer to cover.
 */
export function buildWriterMessages(ctx, session, store, scope, config) {
  let watermark
  try {
    const measurement = measure(ctx, session)
    watermark = computeWriterWatermark(session, measurement, config)
  } catch {
    watermark = null
  }
  const entries = visibleMessages(session)
  let covered = entries
  if (watermark !== null) {
    covered = entries.filter((entry) => entry.index < watermark.startIdx)
  } else {
    // MiMo's computeBoundary degenerates to the first message when the whole
    // visible conversation is recent tail. Keep the full prefix for the writer
    // (there is no older material to exclude) but record the first surface node
    // as the coverage watermark so usability/digest bookkeeping still works.
    covered = entries
    if (session.surface.nodes.length > 0) {
      watermark = { startSeq: session.surface.nodes[0], startIdx: 0, tailTokens: 0, textBlocks: 0, tailMessageCount: entries.length }
    }
  }
  const messages = trimWriterMessages(covered.map((entry) => entry.message), config.writerInputTokenLimit)
  if (messages.length === 0) return null
  const context = writerContextBlock(store, scope, session)
  const instruction = `${CHECKPOINT_INSTRUCTION}\n\n---\n\n${context}`
  return {
    messages: [
      ...messages,
      Object.freeze({ role: 'user', content: [{ type: 'text', text: instruction }] }),
    ],
    watermark,
    coveredMessages: messages.length,
  }
}

/** Surface messages that belong to the turn currently in flight (fork seed omits it). */
function currentTurnMessages(session) {
  const messages = []
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    let start = -1
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.type === 'turn/start') start = index
    }
    for (let index = start + 1; index < events.length; index += 1) {
      const event = events[index]
      if (!event?.type) continue
      const message = session.deriveEventMessage(event)
      if (message !== null && message !== undefined) messages.push(message)
    }
  } catch {}
  return messages
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  return content.map((block) => {
    if (block?.type === 'text') return block.text ?? ''
    if (block?.type === 'tool-call') return `[tool-call ${block.name ?? ''} ${JSON.stringify(block.arguments ?? block.input ?? {})}]`
    if (block?.type === 'tool-result') return `[tool-result ${block.name ?? ''} ${blockText(block.content ?? block.output ?? '')}]`
    if (block?.type === 'image') return '[image]'
    return `[${block?.type ?? 'block'}]`
  }).join('\n')
}

function serializeMessages(messages) {
  return messages.map((message) => `### ${message.role}\n${blockText(message.content)}`).join('\n\n')
}

/**
 * Build the fork/spawn writer prompt. The subagent is a TAGGED-TEXT writer: it
 * must not touch disk — the plugin is the sole writer and owns lock/CAS and
 * .prev backups. A fork child may have inherited completed turns, so only the
 * in-flight turn is serialized; a spawn child also gets the covered prefix
 * (MiMo `checkpoint.fork=false` behavior). Both serializations are capped by
 * writerInputTokenLimit so a long in-flight turn cannot blow the writer's own
 * window before fallback.
 */
function writerSubagentPrompt({ store, scope, session, config, built, fork, memoryRoot }) {
  const parsed = store.read(scope)
  const context = writerContextBlock(store, scope, session)
  const prefix = built.messages.slice(0, -1)
  const current = currentTurnMessages(session)
  const budget = Math.max(2048, config.writerInputTokenLimit)
  const currentBudget = fork ? budget : Math.max(1024, Math.floor(budget * 0.3))
  const currentText = truncateTokens(
    serializeMessages(current) || '(empty)',
    currentBudget,
    '\n\n[... in-flight turn capped to writer budget ...]',
  )
  const prefixText = fork
    ? ''
    : truncateTokens(
        serializeMessages(prefix),
        Math.max(0, budget - estimateTokens(currentText)),
        '\n\n[... covered prefix capped to writer budget ...]',
      )
  const conversation = fork
    ? `The completed conversation prefix should be in your inherited context; treat it as authoritative history and do not repeat it. Current in-flight turn:\n\n${currentText}`
    : `Covered conversation prefix:\n\n${prefixText || '(empty)'}\n\nCurrent in-flight turn (not in the covered prefix):\n\n${currentText}`
  return [
    CHECKPOINT_INSTRUCTION,
    '',
    '--- WRITER SUBAGENT MODE ---',
    `You are the checkpoint writer subagent for memory root: ${memoryRoot}`,
    'Memory paths (read-only context supplied below; do NOT modify any file):',
    `- CHECKPOINT_PATH = ${parsed.paths.checkpoint}`,
    `- MEMORY_PATH = ${parsed.paths.memory}`,
    `- NOTES_PATH = ${parsed.paths.notes}`,
    'Hard rule: NEVER use write/edit/bash/pwsh or any file-mutating tool. You may use read/glob/grep to inspect files if helpful. Your ONLY allowed output is the complete tagged <mimo-checkpoint> and <mimo-memory> blocks (plus optional <mimo-notes>) described in the instructions.',
    '',
    '---',
    '',
    context,
    '',
    '---',
    '',
    conversation,
  ].join('\n')
}

function textFromBlocks(blocks) {
  return (blocks ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/** Run the writer as a DSH subagent when the seam/provider is present. */
async function runWriterSubagent(ctx, { agent, store, scope, config, built, route, signal }) {
  const subagents = ctx.get?.('subagents')
  if (!subagents || typeof subagents.startActivation !== 'function') return { available: false }
  const providerName = config.writerSubagentProvider || 'fork'
  const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
  if (!provider) return { available: false, reason: `provider ${providerName} missing` }
  const fork = providerName === 'fork'
  const paths = store.paths(scope)
  const memoryRoot = paths.layout === 'mimo' ? store.root : paths.dir
  const prompt = writerSubagentPrompt({ store, scope, session: agent.session, config, built, fork, memoryRoot })
  const request = {
    parent: agent,
    cwd: memoryRoot,
    prompt: [{ type: 'text', text: prompt }],
  }
  if (route !== undefined) request.agentOptions = { provider: route.provider, model: route.model }
  if (config.writerSubagentPreset && !fork) request.agentPreset = config.writerSubagentPreset
  const activation = await subagents.startActivation({
    provider: providerName,
    label: 'mimo-checkpoint-writer',
    request,
    signal,
    delivery: 'caller',
  })
  try {
    const result = await activation.result
    if (result?.stopReason !== 'completed') {
      const error = new Error(`dsh-mimo-context: writer subagent stopped with ${result?.stopReason}`)
      error.code = 'SUBAGENT_STOPPED'
      throw error
    }
    const text = textFromBlocks(result.output)
    return { available: true, text, result, provider: providerName }
  } finally {
    try { await activation.dispose() } catch {}
  }
}

/**
 * In-process writer tool loop (`writerBackend: 'tools'`).
 *
 * This is the DSH-native replacement for MiMo's tool-wielding writer: the
 * plugin owns a tiny in-memory view of the three legal memory files and exposes
 * only read/write/edit over them. No child session, no parent tool inheritance,
 * no raw disk writes — the loop's final buffers are validated and persisted
 * through store.writeCheckpoint (lock+CAS), so the plugin stays the sole writer
 * and .prev/CAS semantics stay correct.
 */
const WRITER_PATH_DESCRIPTION = 'One memory file: alias "checkpoint", "memory", or "notes", or an absolute path ending in checkpoint.md / MEMORY.md / notes.md. Any other path is rejected.'

export const WRITER_TOOL_SCHEMAS = [
  {
    name: 'writer_read',
    description: `Read one of the three memory files this writer may access. ${WRITER_PATH_DESCRIPTION}`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: WRITER_PATH_DESCRIPTION } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'writer_write',
    description: `Replace one memory file's entire content. ${WRITER_PATH_DESCRIPTION}`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: WRITER_PATH_DESCRIPTION },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'writer_edit',
    description: `Apply a literal text replacement inside one memory file. ${WRITER_PATH_DESCRIPTION} If old_string appears more than once you MUST pass replace_all=true.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: WRITER_PATH_DESCRIPTION },
        old_string: { type: 'string', description: 'Exact literal text to replace (must be unique unless replace_all is true).' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Required when old_string is not unique.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
]

function resolveWriterBufferKey(pathArg) {
  const value = String(pathArg ?? '').trim().toLowerCase()
  if (value === 'checkpoint' || value.endsWith('checkpoint.md')) return 'checkpoint'
  if (value === 'memory' || value.endsWith('memory.md')) return 'memory'
  if (value === 'notes' || value.endsWith('notes.md')) return 'notes'
  return undefined
}

/** Execute one writer tool against the in-memory buffers. Never touches disk. */
export function executeWriterTool(name, rawArgs, buffers) {
  const fail = (text) => ({ isError: true, text })
  let args
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
  } catch {
    return fail('invalid JSON arguments')
  }
  if (!args || typeof args !== 'object') return fail('arguments must be an object')
  const key = resolveWriterBufferKey(args.path)
  if (key === undefined) return fail(`path not allowed: ${String(args.path ?? '(missing)')} — only checkpoint, memory, notes are writable here`)
  if (name === 'writer_read') return { isError: false, text: String(buffers[key] ?? '') }
  if (name === 'writer_write') {
    const content = String(args.content ?? '')
    buffers[key] = content
    return { isError: false, text: `wrote ${content.length} chars to ${key}`, key }
  }
  if (name === 'writer_edit') {
    const source = String(buffers[key] ?? '')
    const oldText = String(args.old_string ?? '')
    const newText = String(args.new_string ?? '')
    if (oldText.length === 0) return fail('old_string must not be empty')
    const first = source.indexOf(oldText)
    if (first < 0) return fail(`old_string not found in ${key}`)
    const second = source.indexOf(oldText, first + oldText.length)
    if (second >= 0 && args.replace_all !== true) {
      return fail(`old_string occurs ${source.split(oldText).length - 1} times in ${key}; pass replace_all=true or narrow old_string`)
    }
    buffers[key] = args.replace_all === true ? source.split(oldText).join(newText) : source.slice(0, first) + newText + source.slice(first + oldText.length)
    return { isError: false, text: `edited ${key}`, key }
  }
  return fail(`unknown writer tool: ${String(name)}`)
}

async function runWriterToolLoop(ctx, { agent, store, scope, config, built, route, before, state, signal }) {
  const session = agent.session
  const buffers = { checkpoint: before.checkpoint, memory: before.memory, notes: before.notes }
  const context = writerContextBlock(store, scope, session)
  const messages = [
    ...built.messages.slice(0, -1),
    Object.freeze({ role: 'user', content: [{ type: 'text', text: `${CHECKPOINT_TOOL_LOOP_INSTRUCTION}\n\n---\n\n${context}` }] }),
  ]
  let finalText = ''
  // Track successful mutations: a writer may legitimately rewrite a file with
  // identical bytes (no-op update), which a pure diff cannot distinguish from
  // "the tool never ran". touched is the ground truth.
  const touched = { checkpoint: false, memory: false, notes: false }
  let rounds = 0
  for (; rounds < config.writerToolRounds; rounds += 1) {
    const assembler = new BlockAssembler()
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      tools: WRITER_TOOL_SCHEMAS,
      maxTokens: config.writerMaxTokens,
      sessionId: session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const blocks = assembler.blocks()
    if (contentHasImage(blocks)) throw new Error('dsh-mimo-context: writer loop returned image content')
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const calls = blocks.filter((block) => block.type === 'tool-call')
    if (calls.length === 0) {
      finalText = text
      rounds += 1
      break
    }
    messages.push(createAssistantMessage({ content: blocks, source: { provider: route.provider, model: route.model } }))
    for (const call of calls) {
      const result = executeWriterTool(call.name, call.arguments, buffers)
      if (!result.isError && result.key !== undefined && (call.name === 'writer_write' || call.name === 'writer_edit')) {
        touched[result.key] = true
      }
      messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: result.text }], isError: result.isError }))
    }
    if (text.trim().length > 0) finalText = text
  }
  // Falling out of the round budget mid-loop is fine: checkpointTouched below
  // still accepts a valid buffer written by the last successful tool round.
  const checkpointTouched = touched.checkpoint || buffers.checkpoint !== before.checkpoint
  const checkpointUsable =
    buffers.checkpoint.trim().length > 0 &&
    buffers.checkpoint.trim() !== CHECKPOINT_TEMPLATE.trim() &&
    looksLikeCheckpoint(buffers.checkpoint)
  let candidate
  if (checkpointTouched && checkpointUsable) {
    const tagged = [`<mimo-checkpoint>\n${buffers.checkpoint}\n</mimo-checkpoint>`]
    if (touched.memory || buffers.memory !== before.memory) {
      tagged.push(`<mimo-memory>\n${buffers.memory}\n</mimo-memory>`)
    }
    candidate = validateWriterText(tagged.join('\n'), state)
  } else if (finalText.trim().length > 0) {
    candidate = validateWriterText(finalText, state)
    if (candidate.memory === undefined && (touched.memory || buffers.memory !== before.memory)) {
      candidate.memory = truncateTokens(buffers.memory, MEMORY_TOKEN_BUDGET)
    }
  } else {
    const error = new Error('dsh-mimo-context: writer tool loop produced no checkpoint')
    error.code = 'EMPTY_TOOL_WRITER'
    throw error
  }
  return { candidate, text: finalText, buffers, rounds, touched }
}

/** Validate the tagged writer text and extract the two file bodies. */
function validateWriterText(text, state) {
  const parsed = parseWriterOutput(text)
  let checkpoint = parsed.checkpoint
  let memory = parsed.memory
  if (checkpoint === undefined && parsed.memory === undefined) {
    if (looksLikeCheckpoint(text)) checkpoint = text
    else throw new Error('dsh-mimo-context: writer output did not contain a checkpoint block')
  }
  if (checkpoint !== undefined && checkpoint.trim().length > 0 && !looksLikeCheckpoint(checkpoint)) {
    throw new Error('dsh-mimo-context: writer checkpoint is missing its required sections')
  }
  if (checkpoint !== undefined && checkpoint.includes('§1') && !hasAllCheckpointSections(checkpoint)) {
    throw new Error('dsh-mimo-context: writer checkpoint dropped one or more § sections')
  }
  if (checkpoint === undefined || checkpoint.trim().length === 0 || checkpoint.trim() === CHECKPOINT_TEMPLATE.trim()) {
    throw new Error('dsh-mimo-context: writer produced no usable checkpoint content')
  }
  checkpoint = truncateTokens(checkpoint, CHECKPOINT_TOKEN_BUDGET)
  memory = memory === undefined ? undefined : truncateTokens(memory, MEMORY_TOKEN_BUDGET)
  if (memory !== undefined && MEMORY_SECTION_HEADERS.some((header) => !memory.includes(header))) {
    state.warned?.add?.('memory-sections')
  }
  return { checkpoint, memory, notes: parsed.notes }
}

/** Extract checkpoint/memory bodies from writer output. */
export function parseWriterOutput(text) {
  const source = String(text ?? '')
  const checkpoint = parseTagText(source, 'mimo-checkpoint')
  const memory = parseTagText(source, 'mimo-memory')
  const notes = parseTagText(source, 'mimo-notes')
  return {
    checkpoint: checkpoint === undefined ? undefined : checkpoint.trim(),
    memory: memory === undefined ? undefined : memory.trim(),
    notes: notes === undefined ? undefined : notes.trim(),
  }
}

function parseTagText(text, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = pattern.exec(text)
  return match ? match[1] : undefined
}

/** Accept the MiMo §-numbered layout as well as a generic numbered layout. */
export function looksLikeCheckpoint(text) {
  const value = String(text ?? '')
  if (CHECKPOINT_SECTION_HEADERS.every((header) => value.includes(header))) return true
  if (/(^|\n)#{2,3}\s*(?:§\s*1\b|1[.)]\s|Active intent)/i.test(value)) return true
  const headings = value.match(/^#{2,3}\s+\S+/gm)
  return headings !== null && headings.length >= 4
}

/** A successful MiMo writer must preserve every § section (1..11). */
export function hasAllCheckpointSections(text) {
  const value = String(text ?? '')
  if (!/§/.test(value)) return false
  for (let index = 1; index <= 11; index += 1) {
    if (!new RegExp(`(^|\\n)#{2,3}\\s*§\\s*${index}\\b`).test(value)) return false
  }
  return true
}

/** Classify a writer failure; only retryable failures arm the final-rung gate. */
export function classifyWriterFailure(error) {
  const code = String(error?.code ?? '').toUpperCase()
  const message = String(error?.message ?? error).toLowerCase()
  const deterministic = code.includes('AUTH') || code.includes('INVALID') || code.includes('CONTEXT') || code.includes('MAX_TOKENS') || /unauthorized|invalid request|context length|maximum context|api key/.test(message)
  return { retryable: !deterministic, kind: deterministic ? code || 'deterministic' : 'transient' }
}

/** Writers are serialized per session; this is the call body. */
async function writeCheckpointOnce(ctx, { agent, store, scope, config, state, signal, reason }) {
  const session = agent.session
  const built = buildWriterMessages(ctx, session, store, scope, config)
  if (built === null) {
    const error = new Error('no conversation prefix to checkpoint (whole window is recent tail)')
    error.code = 'NO_WATERMARK'
    throw error
  }
  const explicitRoute = config.writerProvider.length > 0 && config.writerModel.length > 0
    ? { provider: config.writerProvider, model: config.writerModel }
    : undefined
  const route = explicitRoute ?? resolveRoute(session, agent)
  if (!route) throw new Error('dsh-mimo-context: no provider/model for the checkpoint writer')

  const before = store.read(scope)
  let text = ''
  let candidate
  let usage = {}
  let usedBackend = 'direct'
  let subagentProvider = ''

  if (config.writerBackend === 'tools') {
    try {
      const loop = await runWriterToolLoop(ctx, { agent, store, scope, config, built, route, before, state, signal })
      candidate = loop.candidate
      text = loop.text
      usedBackend = 'tools'
    } catch (error) {
      state.writerAuxFailure = { backend: 'tools', error, at: Date.now() }
      ctx.logger?.debug?.(`dsh-mimo-context: writer tool loop failed, falling back to direct writer: ${String(error && error.message || error)}`)
      usedBackend = 'direct'
    }
  } else if (config.writerBackend !== 'direct') {
    try {
      const sub = await runWriterSubagent(ctx, {
        agent, store, scope, config, built, route: explicitRoute, signal,
      })
      if (!sub.available) {
        if (config.writerBackend === 'subagent') {
          throw new Error(`dsh-mimo-context: writer subagent unavailable (${sub.reason ?? 'no provider'})`)
        }
      } else {
        // Tagged-text only: the plugin persists under lock+CAS and owns .prev
        // backups. Files a child mutated anyway are ignored and overwritten by
        // writeCheckpoint, so CAS still compares the true previous body.
        if (sub.text.trim().length === 0) {
          const error = new Error('dsh-mimo-context: writer subagent produced no tagged text')
          error.code = 'EMPTY_SUBAGENT_WRITER'
          throw error
        }
        candidate = validateWriterText(sub.text, state)
        text = sub.text
        usedBackend = 'subagent'
        subagentProvider = sub.provider
      }
    } catch (error) {
      const canFallback = config.writerBackend === 'auto' && config.writerSubagentFallback
      if (!canFallback) throw error
      state.writerAuxFailure = { backend: 'subagent', error, at: Date.now() }
      ctx.logger?.debug?.(`dsh-mimo-context: subagent writer failed, falling back to direct writer: ${String(error && error.message || error)}`)
      usedBackend = 'direct'
    }
  }

  if (usedBackend === 'direct') {
    const assembler = new BlockAssembler()
    // The adapted direct writer is text-only: do not advertise the parent's tool
    // schemas, or a real model may emit tool calls that this call cannot execute.
    const options = {
      provider: route.provider,
      model: route.model,
      messages: built.messages,
      maxTokens: config.writerMaxTokens,
      sessionId: session.id,
      purpose: 'compaction',
      ...(typeof session.toolHistory === 'function' ? { toolHistory: session.toolHistory() } : {}),
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error
    const blocks = assembler.blocks()
    if (contentHasImage(blocks)) throw new Error('dsh-mimo-context: writer returned image content')
    text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (text.trim().length === 0) throw new Error('dsh-mimo-context: writer returned no text')
    candidate = validateWriterText(text, state)
    usage = assembler.usage ?? {}
  }

  const watermarkSeq = built.watermark?.startSeq
  const written = store.writeCheckpoint(scope, candidate.checkpoint, candidate.memory, {
    sessionId: session.id,
    reason: reason ?? 'threshold',
    writerCalls: (store.meta(scope).writerCalls ?? 0) + 1,
    lastWriterAt: new Date().toISOString(),
    lastWriterPressureTokens: state.lastPressure,
    ...(watermarkSeq === undefined ? {} : { lastCheckpointSeq: watermarkSeq }),
    ...(watermarkSeq === undefined ? {} : { lastCheckpointAt: new Date().toISOString() }),
  }, { expectedMemoryHash: sha1(before.memory) })
  if (written.memorySkipped) {
    state.warned?.add?.('memory-cas-skipped')
    ctx.logger?.debug?.('dsh-mimo-context: project MEMORY changed during writer run; kept newer body')
  }
  // MiMo: the writer drains notes.md into the checkpoint/MEMORY, then restores
  // the template unconditionally after a successful write.
  store.resetNotes(scope)
  const auxFailure = state.writerAuxFailure
  state.writerGeneration = written.generation
  state.writerCount += 1
  state.lastWriterAt = Date.now()
  state.writerFailure = undefined
  state.writerAuxFailure = undefined
  state.writerBackend = usedBackend
  state.writerSubagentProvider = subagentProvider
  return {
    ...written,
    text,
    writerMessages: built.messages.length,
    watermark: built.watermark,
    usage,
    route,
    backend: usedBackend,
    subagentProvider,
    auxFailure: auxFailure === undefined
      ? undefined
      : { backend: auxFailure.backend, message: String(auxFailure.error?.message ?? auxFailure.error ?? 'unknown') },
  }
}

/** Run one writer for a session with timeout and single-flight protection. */
export function startCheckpointWriter(ctx, { agent, store, scope, config, state, reason }) {
  if (state.writerRunning) return state.writerPromise
  const controller = new AbortController()
  state.writerRunning = true
  state.writerPromise = (async () => {
    try {
      const timeout = withTimeout(
        writeCheckpointOnce(ctx, { agent, store, scope, config, state, signal: controller.signal, reason }),
        config.writerTimeoutMs,
        () => controller.abort(new Error('dsh-mimo-context: writer timed out')),
      )
      const outcome = await timeout
      if (outcome.timedOut) throw new Error('dsh-mimo-context: checkpoint writer timed out')
      return outcome.value
    } catch (error) {
      state.writerFailure = { error, classification: classifyWriterFailure(error), at: Date.now() }
      throw error
    } finally {
      state.writerRunning = false
    }
  })()
  return state.writerPromise
}

/** Await the in-flight writer, if any. */
export async function awaitWriter(state) {
  if (!state.writerRunning || state.writerPromise === null) return undefined
  try {
    return await state.writerPromise
  } catch {
    return undefined
  }
}

export { CHECKPOINT_TOKEN_BUDGET, MEMORY_TOKEN_BUDGET, NOTES_TEMPLATE, CHECKPOINT_TEMPLATE, MEMORY_TEMPLATE, CHECKPOINT_WRITER_MARKER }
