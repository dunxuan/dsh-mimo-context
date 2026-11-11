// MiMo Code rebuild-context renderer.
//
// Port of packages/cli/src/session/checkpoint.ts renderRebuildContext + helpers
// (checkpoint-templates/paths, budgeted-read, tail-digest). The model-facing
// boundary is one synthetic user message whose text is the dump below; no old
// messages before the boundary are kept verbatim (only the recent-user section,
// the activity digest, and unanswered user messages survive).
//
// DSH mapping:
//   MiMo message row  -> DSH session event (`user/message`, `assistant/message`,
//                        `tool/call`); `source.kind` distinguishes real user
//                        prose from runtime/skill/plugin synthetics.
//   task tool DB      -> <session>/tasks/<id>/progress.md files (MiMo writer is
//                        told to use the task tool; DSH has no task DB seam).

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './util.js'
import { readBudgetedSectionAwareText, readBudgetedText } from './storage.js'

export const REBUILD_HEADER =
  'The sections below are auto-loaded session context already in this message. File-backed sections list their path on a `File:` line — use the `grep` tool on that path for specific facts; do not `read` the whole file again.'

export const SEAM_WITH_ACTIVITY =
  'This session is continued from a checkpoint. The blocks above cover earlier history and the recent activity list. Resume the last task from that list and any live messages after it. Do not recap this dump.'

export const SEAM_WITHOUT_ACTIVITY =
  'This session is continued from a checkpoint. The blocks above cover earlier history. Resume the last task from the most recent live messages. Do not recap this dump.'

export const AUTONOMOUS_LOOP_REMINDER = [
  '<system-reminder>',
  'You are mid-loop in an autonomous task. The outputs of your latest tool',
  'calls are not in this context. Continue the work loop from where the',
  'blocks above leave off, and re-run a call when you need its output.',
  '</system-reminder>',
].join('\n')

export const TOOL_RESULT_CONTINUE_REMINDER = [
  '<system-reminder>',
  'Tool results above are real history from the autonomous loop. Process',
  'them and continue to the next iteration. Do not pause to summarize.',
  '</system-reminder>',
].join('\n')

const DIGEST_MAX_LINE_CHARS = 240
const DIGEST_MAX_ARG_CHARS = 80
const DIGEST_MAX_LINES = 200

function truncate(text, max) {
  const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`
}

function textBlocks(event) {
  const content = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
}

function messageText(event) {
  return textBlocks(event).map((block) => block.text).join('\n')
}

export function isBoundaryEvent(event) {
  if (!event || event.type !== 'user/message') return false
  const kind = event.data?.source?.kind
  if (kind === 'compact-checkpoint' || kind === 'compaction') return true
  const content = event.data?.content
  return Array.isArray(content) && content.some((block) => block?.type === 'checkpoint' || block?.type === 'compaction')
}

export function isRealUserEvent(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

function snapshotEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  } catch {}
  const events = []
  try {
    for (let seq = 0; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq)
      if (event) events.push(event)
    }
  } catch {}
  return events
}

function surfaceEvents(session) {
  const events = []
  for (const seq of session.surface.nodes) {
    try {
      const event = session.eventAt(seq)
      if (event) events.push(event)
    } catch {}
  }
  return events
}

/** MiMo truncateVerbatimUserMsg: head 60% + elision marker + tail 30%. */
export function truncateVerbatimUserMsg(text, capTokens, label) {
  if (estimateTokens(text) <= capTokens) return text
  const head = text.slice(0, Math.floor(capTokens * 0.6) * 4)
  const tail = text.slice(-Math.max(1, Math.floor(capTokens * 0.3) * 4))
  const elided = estimateTokens(text) - estimateTokens(head) - estimateTokens(tail)
  return [
    head,
    `[…elided ${elided} tokens; ${label}; recover the full message from history if it is essential]`,
    tail,
  ].join('\n')
}

/**
 * Unanswered user inputs at the tail: real user messages after the newest
 * non-user surface node. MiMo copies these in full onto the boundary.
 */
function unansweredUserEvents(session) {
  const events = surfaceEvents(session)
  let lastNonUser = -1
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].type !== 'user/message' || !isRealUserEvent(events[index])) lastNonUser = index
  }
  return events.slice(lastNonUser + 1).filter(isRealUserEvent)
}

function eventContent(event) {
  return event?.data?.content ?? event?.data?.message?.content
}

function renderToolCallLine(name, argsInput) {
  const toolName = name ?? 'tool'
  let args = ''
  try {
    const value = typeof argsInput === 'string' ? JSON.parse(argsInput) : argsInput
    if (value && typeof value === 'object') {
      args = Object.entries(value)
        .map(([key, item]) => {
          if (typeof item === 'string') return `${key}=${JSON.stringify(truncate(item, DIGEST_MAX_ARG_CHARS))}`
          let raw
          try {
            raw = JSON.stringify(item)
          } catch {
            raw = '[unserializable]'
          }
          return `${key}=${truncate(raw ?? '[unserializable]', DIGEST_MAX_ARG_CHARS)}`
        })
        .join(', ')
    }
  } catch {}
  return args ? `- ${toolName}(${args})` : `- ${toolName}()`
}

/**
 * MiMo tail-digest (tool name + args; never tool results).
 *
 * DSH 0.2.2 does NOT put standalone `tool/call` events on the surface — tool
 * calls are `tool-call` blocks inside `assistant/message` content. So digest
 * those blocks too, otherwise a surface-only scan loses every tool name.
 */
export function renderTailDigest(events) {
  const lines = []
  for (const event of events) {
    if (isBoundaryEvent(event)) continue
    if (isRealUserEvent(event) || (event.type === 'user/message' && !event.data?.source?.kind)) continue
    if (event.type === 'assistant/message') {
      const text = messageText(event).trim()
      if (text) lines.push(`- assistant: ${truncate(text, DIGEST_MAX_LINE_CHARS)}`)
      const content = eventContent(event)
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool-call') lines.push(renderToolCallLine(block.name, block.arguments ?? block.input))
        }
      }
      continue
    }
    if (event.type === 'tool/call') {
      lines.push(renderToolCallLine(event.data?.name, event.data?.arguments))
    }
  }
  const kept = lines.slice(0, DIGEST_MAX_LINES)
  const interrupted = kept.some((line) => line.includes('→ interrupted'))
  if (kept.length === 0) return ''
  return ['# Recent activity', '', ...(interrupted ? ['(tool loop interrupted by rebuild — re-run any tools you still need)', ''] : []), ...kept].join('\n')
}

function stripTopLevelH1s(text) {
  let inFence = false
  return String(text)
    .split('\n')
    .filter((line) => {
      if (/^(```|~~~)/.test(line)) {
        inFence = !inFence
        return true
      }
      if (!inFence && /^# [^#]/.test(line)) return false
      return true
    })
    .join('\n')
    .trim()
}

function pushSection(lines, heading, body, filePath) {
  lines.push(`# ${heading}`)
  if (filePath) lines.push(`File: ${filePath}`)
  if (body !== undefined) {
    const text = filePath ? stripTopLevelH1s(body) : String(body).trim()
    if (text) lines.push(text)
  }
  lines.push('')
}

function truncateAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 60))}\n... (truncated, full body at file)`
}

function listMemoryFiles(store, paths) {
  const result = []
  const walk = (dir, prefix) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.prev' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(rel)
    }
  }
  walk(paths.sessionDir, `sessions/${paths.sessionId}`)
  walk(paths.projectDir, `projects/${paths.projectKey}`)
  walk(paths.globalDir, 'global')
  return result
}

const TODO_STATUS = {
  pending: '🔵 open',
  in_progress: '🔄 in_progress',
  completed: '✅ done',
}

/**
 * DSH's todo_write already persists an authoritative whole-list task snapshot
 * in the session log (the closest analogue of MiMo's task tool DB). Prefer it
 * over the plugin's task-progress files for the Tasks ledger.
 */
export function latestTodoItems(session) {
  try {
    const events = snapshotEvents(session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].type === 'todo/write') {
        const todos = events[index].data?.todos
        return Array.isArray(todos) ? todos : []
      }
    }
  } catch {}
  return []
}

export function renderTodoLedger(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  return todos.map((todo) => `- ${TODO_STATUS[todo.status] ?? todo.status} — ${truncate(todo.content, 200)}`).join('\n')
}

function renderTasksLedger(store, scope, cap, session) {
  const todo = session ? renderTodoLedger(latestTodoItems(session)) : undefined
  if (todo) return truncateAtBoundary(todo, cap * 4)
  const tasks = store.taskSummaries(scope)
  if (tasks.length === 0) return '(none)'
  const lines = tasks.map((task) => {
    const first = task.text.split('\n').find((line) => line.trim().length > 0) ?? '(no summary)'
    return `- ${task.id} — ${truncate(first.replace(/^#+\s*/, ''), 200)}\n  (progress: tasks/${task.id}/progress.md)`
  })
  return truncateAtBoundary(lines.join('\n'), cap * 4)
}

/** DSH's live-agent registry provides the closest equivalent of MiMo actors. */
function renderActiveActors(ctx, session) {
  try {
    const agents = ctx?.get?.('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    const children = list.filter((candidate) => {
      if (!candidate || candidate === session) return false
      const header = candidate.session?.header
      return header?.parentSession === session.id
    })
    if (children.length === 0) return ''
    return children
      .slice(0, 20)
      .map((child) => {
        const header = child.session?.header
        const label = header?.agentPreset ?? header?.origin ?? 'subagent'
        const status = typeof child.status === 'string' ? child.status : 'active'
        return `- ${truncate(label, 80)} (${status}) session=${child.id}`
      })
      .join('\n')
  } catch {
    return ''
  }
}

function tailReminder(session) {
  const events = surfaceEvents(session)
  const last = events.at(-1)
  if (!last) return ''
  if (last.type === 'tool/result') return TOOL_RESULT_CONTINUE_REMINDER
  if (last.type === 'assistant/message') {
    const content = last.data?.message?.content ?? last.data?.content
    const hasToolCall = Array.isArray(content) && content.some((block) => block?.type === 'tool-call')
    // A finished assistant reply with no tool call needs no reminder.
    return hasToolCall ? AUTONOMOUS_LOOP_REMINDER : ''
  }
  return ''
}

/**
 * Render the MiMo rebuild dump and boundary blocks.
 *
 * Returns null when there is genuinely nothing to push (MiMo bails early so the
 * caller may fall back to ordinary compaction).
 */
export function renderRebuildContext(runtime, scope, options = {}) {
  const { ctx, config, store } = runtime
  const session = options.agent?.session
  const paths = store.paths(scope)
  const state = store.read(scope)
  const caps = config.pushCaps
  const digestBoundary = options.boundarySeq ?? state.watermark

  const tasksText = renderTasksLedger(store, scope, caps.tasksLedger, session)
  const checkpointRead = state.hasCheckpoint
    ? readBudgetedSectionAwareText(state.checkpoint, caps.checkpoint, paths.checkpoint)
    : undefined
  const checkpointText = checkpointRead?.text ?? ''
  const memoryRead = readBudgetedSectionAwareText(state.memory, caps.memory, paths.memory)
  const notesRead = readBudgetedText(paths.notes, caps.notes)
  const globalRead = readBudgetedSectionAwareText(state.globalMemory, caps.global, paths.globalMemory)

  const unanswered = session ? unansweredUserEvents(session) : []
  const unansweredIds = new Set(unanswered.map((event) => event.data?.id))
  const recentUserEntries = []
  if (session && caps.recentUser > 0) {
    // Recent user = surface messages the checkpoint watermark has NOT covered
    // yet (the writer's tail start). Old pre-watermark intents live in §1.
    const events = surfaceEvents(session)
      .filter((event) =>
        isRealUserEvent(event) &&
        !isBoundaryEvent(event) &&
        !unansweredIds.has(event.data?.id) &&
        (digestBoundary === undefined || event.seq >= digestBoundary))
    let remaining = caps.recentUser
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      const raw = messageText(event).trim()
      if (!raw) continue
      const entry = truncateVerbatimUserMsg(raw, caps.recentUserPerMsg, `messageID=${event.data?.id ?? event.seq}`)
      const cost = estimateTokens(entry)
      if (remaining - cost < 0) break
      recentUserEntries.unshift(entry)
      remaining -= cost
    }
  }

  // Previous rebuild boundary is the digest watermark; never re-digest it
  // (MiMo's "fractal bloat" guard).
  let lastBoundarySeq
  let boundaryEvent
  if (session) {
    for (const event of surfaceEvents(session)) {
      if (isBoundaryEvent(event)) {
        lastBoundarySeq = event.seq
        boundaryEvent = event
      }
    }
  }
  // Activity = current-surface tail after the writer watermark (the point the
  // checkpoint covers through); when no watermark exists, fall back to the
  // previous rebuild boundary. Full-log scans would re-inject shadowed/replaced
  // history and inbox splices ("fractal bloat").
  const activityEvents = session
    ? surfaceEvents(session).filter((event) => {
        if (event.seq >= session.seq) return false
        if (digestBoundary !== undefined) return event.seq >= digestBoundary
        if (lastBoundarySeq === undefined) return true
        return event.seq > lastBoundarySeq
      })
    : []
  const activity = renderTailDigest(activityEvents)

  if (
    tasksText === '(none)' &&
    !checkpointText.trim() &&
    !memoryRead?.text?.trim() &&
    !globalRead?.text?.trim() &&
    !notesRead?.text?.trim() &&
    recentUserEntries.length === 0
  ) {
    return null
  }

  const lines = [REBUILD_HEADER, '']
  pushSection(lines, 'Tasks ledger', tasksText)
  if (checkpointText.trim()) pushSection(lines, 'Session checkpoint', checkpointText, paths.checkpoint)
  const actors = session ? renderActiveActors(ctx, session) : ''
  if (actors) pushSection(lines, 'Active actors', truncateAtBoundary(actors, caps.actorLedger * 4))
  if (recentUserEntries.length > 0) pushSection(lines, 'Recent user input (verbatim)', recentUserEntries.join('\n'))
  if (memoryRead?.text?.trim()) pushSection(lines, 'Project durable knowledge', memoryRead.text, paths.memory)
  if (globalRead?.text?.trim()) pushSection(lines, 'Global memory', globalRead.text, paths.globalMemory)
  if (notesRead?.text?.trim()) pushSection(lines, 'Session notes', notesRead.text, paths.notes)

  const pushed = new Set([paths.checkpoint, paths.memory, paths.globalMemory, paths.notes])
  const indexEntries = listMemoryFiles(store, paths).filter((entry) => {
    const full = join(store.root, entry)
    return !pushed.has(full) && !entry.includes('/checkpoint-')
  })
  if (indexEntries.length > 0) {
    lines.push('# Memory keys index')
    let budget = caps.memoryTitles
    for (const entry of indexEntries) {
      const cost = estimateTokens(entry)
      if (budget - cost < 0) break
      lines.push(`- ${entry}`)
      budget -= cost
    }
    lines.push('')
  }

  if (activity) {
    lines.push('')
    lines.push(activity)
  }
  lines.push('')
  lines.push(activity ? SEAM_WITH_ACTIVITY : SEAM_WITHOUT_ACTIVITY)
  const reminder = session ? tailReminder(session) : ''
  if (reminder) {
    lines.push('')
    lines.push(reminder)
  }

  const text = lines.join('\n')
  const blocks = [{ type: 'text', text }]
  // MiMo copies unanswered user messages onto the boundary in full, outside the
  // recent-user budget; they must not be paraphrased by the writer.
  for (const event of unanswered) {
    const content = event.data?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        blocks.push({ type: 'text', text: block.text })
      } else if (block?.type === 'file') {
        blocks.push(block)
      }
    }
  }
  return {
    blocks,
    text,
    generation: state.generation,
    watermark: state.watermark,
    boundarySeq: boundaryEvent?.seq,
    diagnostics: {
      checkpoint: checkpointRead?.truncated ?? false,
      memory: memoryRead?.truncated ?? false,
      notes: notesRead?.truncated ?? false,
      global: globalRead?.truncated ?? false,
      recentUserEntries: recentUserEntries.length,
      unanswered: unanswered.length,
      activityLines: activity ? activity.split('\n').length : 0,
      tokens: estimateTokens(text),
    },
  }
}

/** Backward-compatible helper used by the plugin's rebuild path. */
export function buildRebuildBlocks(store, scope, config, options = {}) {
  const runtime = { config, store, ctx: options.ctx }
  const rendered = renderRebuildContext(runtime, scope, { agent: options.agent })
  if (rendered === null) return null
  return { blocks: rendered.blocks, text: rendered.text, generation: rendered.generation, diagnostics: rendered.diagnostics }
}

export function memoryFileIndex(store, scope) {
  return listMemoryFiles(store, store.paths(scope))
}

export { listMemoryFiles }
