// Small dependency-free helpers shared by the plugin modules.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cheap token estimate matching the harness's fixed heuristic closely enough
 * for budgeting: CJK characters cost one token, other characters four per token. */
export function estimateTokens(text) {
  if (!text) return 0
  const value = String(text)
  const cjk = value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g)
  const cjkCount = cjk ? cjk.length : 0
  return cjkCount + Math.ceil((value.length - cjkCount) / 4)
}

/** Approximate character budget for a token budget. */
export function charsForTokens(tokens) {
  return Math.max(0, Math.floor(tokens * 4))
}

/** Truncate text to a token budget, keeping the head and marking the cut. */
export function truncateTokens(text, maxTokens, marker = '\n\n[... truncated to fit memory budget ...]') {
  if (!text) return ''
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = charsForTokens(maxTokens)
  if (maxChars <= marker.length + 16) return text.slice(0, maxChars)
  return text.slice(0, maxChars - marker.length) + marker
}

/** Truncate text to a byte budget (UTF-8), keeping the head. */
export function truncateBytes(text, maxBytes, marker = '\n\n[... file size cap reached ...]') {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  if (buffer.length <= maxBytes) return String(text ?? '')
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const head = buffer.subarray(0, Math.max(0, maxBytes - markerBytes)).toString('utf8')
  return head + marker
}

/** Escape model-visible text so it cannot close framework-controlled wrappers. */
export function escapeInjection(text) {
  return String(text ?? '')
    .replaceAll('</system-reminder>', '&lt;/system-reminder&gt;')
    .replaceAll('</conversation-summary>', '&lt;/conversation-summary&gt;')
    .replaceAll('</mimo-checkpoint>', '&lt;/mimo-checkpoint&gt;')
    .replaceAll('</mimo-memory>', '&lt;/mimo-memory&gt;')
    .replaceAll('<mimo-checkpoint>', '&lt;mimo-checkpoint&gt;')
    .replaceAll('<mimo-memory>', '&lt;mimo-memory&gt;')
}

/** Extract the content of the first `<tag ...>...</tag>` pair. */
export function parseTag(text, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = pattern.exec(String(text ?? ''))
  return match ? match[1].trim() : undefined
}

export function sha1(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* bounded spin fallback */ }
  }
}

/**
 * Small cross-process lock for the shared project MEMORY.md. The writer runs in
 * a durable session, so two sessions in the same project can finish writers at
 * the same time; this serializes the short read/backup/write critical section.
 * It is intentionally not an ownership system: stale locks are reclaimed and
 * callers fall back to an unlocked write rather than failing a checkpoint.
 */
export function withFileLockSync(lockPath, fn, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : 60000
  ensureDir(dirname(lockPath))
  const deadline = Date.now() + timeoutMs
  let fd
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch {}
      if (Date.now() >= deadline) {
        // Do not lose the checkpoint because a stale lock survived: the write
        // itself is atomic, and CAS still protects the shared MEMORY body.
        return fn({ locked: false })
      }
      sleepSync(20)
    }
  }
  try {
    if (fd !== undefined) closeSync(fd)
    return fn({ locked: true })
  } finally {
    try { unlinkSync(lockPath) } catch {}
  }
}

export function readTextIfExists(path) {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Atomic write: write a sibling temp file, then rename over the destination. */
export function atomicWrite(path, content) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    // Windows can reject replace-over-existing in edge cases; fall back to rm+rename.
    try {
      rmSync(path, { force: true })
    } catch {}
    renameSync(tmp, path)
  }
}

export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Run a promise with a timeout; resolves `{ timedOut: true }` on expiry. */
export async function withTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timedOut: false, value: await promise }
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {}
      resolve({ timedOut: true, value: undefined })
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    const value = await Promise.race([promise.then((result) => ({ timedOut: false, value: result })), timeout])
    return value
  } finally {
    clearTimeout(timer)
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

export function safeJsonParse(text, fallback = undefined) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Split markdown into named sections (## §N ...) for budgeted injection. */
export function extractSections(markdown) {
  const sections = new Map()
  const pattern = /^##\s+(§\d+|[^\n]+?)\s*$/gm
  let match
  const starts = []
  while ((match = pattern.exec(markdown)) !== null) {
    starts.push({ title: match[1].trim(), index: match.index })
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1].index : markdown.length
    sections.set(start.title, markdown.slice(start.index, end).trim())
  }
  return sections
}

/** Extract the "## §N" section containing one of the requested labels. */
export function pickSections(markdown, wantedLabels, maxTokens) {
  const sections = extractSections(markdown)
  const picked = []
  for (const [title, body] of sections) {
    if (wantedLabels.some((label) => title.includes(label))) picked.push(body)
  }
  const text = picked.join('\n\n').trim()
  if (!text) return truncateTokens(markdown, 2000)
  return truncateTokens(text, maxTokens)
}

/** Extract file paths from a checkpoint's files section (backticked paths). */
export function extractFilePaths(markdown, limit = 5) {
  const paths = []
  const seen = new Set()
  const pattern = /`([^`\n]+)`/g
  let match
  while ((match = pattern.exec(String(markdown ?? ''))) !== null) {
    const candidate = match[1].trim()
    if (candidate.length === 0 || candidate.length > 300) continue
    if (!/[\\/]/.test(candidate) && !/\.[A-Za-z0-9]{1,8}$/.test(candidate)) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    paths.push(candidate)
    if (paths.length >= limit) break
  }
  return paths
}
