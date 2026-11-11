// Memory rendering (opt-in injection + rebuild boundary), keyword search, and
// the dream / distill consolidation passes.
//
// Rebuild-context rendering lives in rebuild-context.js (MiMo renderRebuildContext
// port); this module keeps the writer-independent helpers.

import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import { estimateTokens, escapeInjection, pickSections, truncateTokens } from './util.js'
import {
  DREAM_INSTRUCTION,
  DISTILL_INSTRUCTION,
  memoryInjectionWrapper,
} from './prompts.js'
import { resolveRoute } from './compaction.js'
import { renderRebuildContext } from './rebuild-context.js'

function section(title, body) {
  return `\n### ${title}\n${body.trim()}\n`
}

/**
 * One-time memory injection body (MiMo does NOT auto-inject content on resume;
 * this is an opt-in DSH convenience, disabled by default).
 */
export function buildMemoryInjection(store, scope, config) {
  const state = store.read(scope)
  const budget = config.memoryBudget
  const checkpoint = pickSections(
    state.checkpoint,
    ['§1', '§2', '§5', '§6', '§8', '§10'],
    Math.max(500, budget.checkpoint ?? 6000),
  )
  const memory = truncateTokens(state.memory, Math.max(200, budget.memory ?? 6000))
  const tasks = store.taskSummaries(scope)
    .map((task) => `**${task.id}**\n${task.text}`)
    .join('\n\n')
  const notes = truncateTokens(state.notes, Math.max(200, budget.notes ?? 2000))
  const body = [
    section('Project memory (MEMORY.md)', memory),
    section('Session checkpoint (selected sections)', checkpoint),
    tasks.trim().length > 0 ? section('Task progress', truncateTokens(tasks, Math.max(200, budget.tasks ?? 2000))) : '',
    notes.trim().length > 0 ? section('Notes', notes) : '',
  ].join('').trim()
  if (body.length === 0) return null
  const text = memoryInjectionWrapper(escapeInjection(body))
  if (estimateTokens(text) > config.memoryInjectTokens) {
    return {
      text: memoryInjectionWrapper(escapeInjection(truncateTokens(body, Math.max(500, config.memoryInjectTokens - 50)))),
      generation: state.generation,
      tokens: config.memoryInjectTokens,
    }
  }
  return { text, generation: state.generation, tokens: estimateTokens(text) }
}

/**
 * Render the MiMo rebuild boundary for a session. Returns null when there is
 * nothing to rebuild from (caller may fall back to ordinary compaction).
 */
export function buildRebuildBlocks(ctx, store, scope, config, options = {}) {
  return renderRebuildContext({ ctx, config, store }, scope, {
    agent: options.agent,
    boundarySeq: options.boundarySeq,
  })
}

/** Split a memory file into searchable lines with line numbers. */
function fileDocs(label, text) {
  if (!text) return []
  return String(text)
    .split(/\r?\n/)
    .map((line, index) => ({ label, line: index + 1, text: line }))
    .filter((entry) => entry.text.trim().length > 0)
}

function collectDocs(store, scope, wantedScope) {
  const state = store.read(scope)
  const docs = []
  const wanted = (name) => wantedScope === undefined || wantedScope === 'all' || wantedScope === name
  if (wanted('checkpoint')) docs.push(...fileDocs('checkpoint.md', state.checkpoint))
  if (wanted('memory') || wantedScope === 'projects') docs.push(...fileDocs('MEMORY.md', state.memory))
  if (wanted('global') || wantedScope === 'global') docs.push(...fileDocs('global/MEMORY.md', state.globalMemory))
  if (wanted('notes')) docs.push(...fileDocs('notes.md', state.notes))
  for (const task of store.taskSummaries(scope, 4000)) {
    docs.push(...fileDocs(`tasks/${task.id}/progress.md`, task.text))
  }
  return docs
}

function escapeFtsQuery(query) {
  return String(query)
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, '').trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"`)
    .join(' OR ')
}

async function ftsSearch(docs, query, limit) {
  const match = escapeFtsQuery(query)
  if (match.length === 0) return []
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(label, line UNINDEXED, body)')
      const insert = db.prepare('INSERT INTO docs(label, line, body) VALUES (?, ?, ?)')
      for (const doc of docs) insert.run(doc.label, String(doc.line), doc.text)
      const rows = db.prepare('SELECT label, line, body, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?').all(match, limit)
      return rows.map((row) => ({ label: row.label, line: Number(row.line), text: row.body, score: Number(row.score) }))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

function fallbackSearch(docs, query, limit) {
  const terms = String(query).toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  if (terms.length === 0) return []
  const phrase = String(query).toLowerCase().trim()
  const scored = []
  for (const doc of docs) {
    const text = doc.text.toLowerCase()
    let score = 0
    for (const term of terms) {
      let index = text.indexOf(term)
      while (index !== -1) {
        score += 1 + Math.min(term.length, 8) / 8
        index = text.indexOf(term, index + term.length)
      }
    }
    if (phrase.length > 2 && text.includes(phrase)) score += 5
    if (score > 0) scored.push({ ...doc, score: -score })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit)
}

/** Search all memory files; returns ranked hits. */
export async function searchMemory(store, scope, query, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 30)
  const docs = collectDocs(store, scope, options.scope)
  if (docs.length === 0) return []
  let hits = await ftsSearch(docs, query, limit)
  if (hits.length === 0) hits = fallbackSearch(docs, query, limit)
  // MiMo's relative BM25 floor (0.15): keep hits >= 15% of the top score.
  if (hits.length > 1) {
    const top = Math.abs(hits[0].score)
    const floor = top * 0.15
    hits = hits.filter((hit, index) => index === 0 || Math.abs(hit.score) >= floor)
  }
  return hits
}

function finishError(finish) {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': {
      const error = new Error('dsh-mimo-context: consolidation call truncated at the token cap')
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

async function callTextLlm(ctx, { agent, route, messages, maxTokens, signal }) {
  const assembler = new BlockAssembler()
  // Auxiliary memory calls are text-only (no tool loop).
  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(typeof agent.session.toolHistory === 'function' ? { toolHistory: agent.session.toolHistory() } : {}),
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const blocks = assembler.blocks()
  if (contentHasImage(blocks)) throw new Error('dsh-mimo-context: consolidation returned image content')
  return {
    text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
    usage: assembler.usage,
  }
}

function tagText(text, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = pattern.exec(String(text ?? ''))
  return match ? match[1].trim() : undefined
}

/** Consolidate project MEMORY.md from checkpoint + notes + tasks (MiMo /dream). */
export async function runDream(ctx, { agent, store, scope, config, signal }) {
  const route = config.writerProvider.length > 0 && config.writerModel.length > 0
    ? { provider: config.writerProvider, model: config.writerModel }
    : resolveRoute(agent.session, agent)
  if (!route) throw new Error('dsh-mimo-context: no provider/model for dream')
  const state = store.read(scope)
  const tasks = store.taskSummaries(scope).map((task) => `**${task.id}**\n${task.text}`).join('\n\n')
  const instruction = [
    DREAM_INSTRUCTION,
    '',
    '---',
    '',
    'Current MEMORY.md:',
    '````markdown',
    state.memory,
    '````',
    '',
    'Session checkpoint:',
    '````markdown',
    truncateTokens(state.checkpoint, 8000),
    '````',
    '',
    'Notes:',
    '````markdown',
    truncateTokens(state.notes, 3000),
    '````',
    '',
    'Task progress:',
    '````markdown',
    tasks || '(none)',
    '````',
  ].join('\n')
  const message = { role: 'user', content: [{ type: 'text', text: instruction }] }
  const result = await callTextLlm(ctx, { agent, route, messages: [message], maxTokens: Math.min(config.writerMaxTokens, 10000), signal })
  const memory = tagText(result.text, 'mimo-memory')
  if (memory === undefined || memory.length === 0) throw new Error('dsh-mimo-context: dream produced no <mimo-memory> block')
  const written = store.writeMemory(scope, truncateTokens(memory, 10000), { dreamAt: new Date().toISOString() })
  return { memory: written.memory, usage: result.usage }
}

/** Distill a repeated workflow into a project skill file (MiMo /distill). */
export async function runDistill(ctx, { agent, store, scope, config, signal, focus }) {
  const route = config.writerProvider.length > 0 && config.writerModel.length > 0
    ? { provider: config.writerProvider, model: config.writerModel }
    : resolveRoute(agent.session, agent)
  if (!route) throw new Error('dsh-mimo-context: no provider/model for distill')
  const state = store.read(scope)
  const instruction = [
    DISTILL_INSTRUCTION,
    focus ? `\nFocus: ${focus}` : '',
    '',
    '---',
    '',
    'Session checkpoint:',
    '````markdown',
    truncateTokens(state.checkpoint, 9000),
    '````',
    '',
    'MEMORY.md:',
    '````markdown',
    truncateTokens(state.memory, 5000),
    '````',
  ].join('\n')
  const message = { role: 'user', content: [{ type: 'text', text: instruction }] }
  const result = await callTextLlm(ctx, { agent, route, messages: [message], maxTokens: Math.min(config.writerMaxTokens, 8000), signal })
  const skill = tagText(result.text, 'mimo-skill')
  if (skill === undefined || skill.length === 0) throw new Error('dsh-mimo-context: distill produced no <mimo-skill> block')
  const nameMatch = /name:\s*([^\n]+)/.exec(skill)
  const name = (nameMatch ? nameMatch[1] : `skill-${Date.now()}`).trim().replace(/^["']|["']$/g, '')
  const file = store.writeSkill(scope, name, skill)
  return { file, name, usage: result.usage }
}
