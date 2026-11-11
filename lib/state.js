// Per-session runtime state for the MiMo memory plugin. Everything here is
// process-local: durable state lives in the memory files and meta.json. After a
// plugin reload the checkpoint generation is re-read from disk and one memory
// injection may happen again (harmless, idempotent by content).

export class SessionState {
  constructor() {
    this.sessions = new Map()
  }

  for(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        crossed: new Set(),
        writerRunning: false,
        writerPromise: null,
        writerGeneration: undefined,
        writerBackend: undefined,
        writerSubagentProvider: undefined,
        writerCount: 0,
        lastWriterAt: 0,
        lastWriterFailure: undefined,
        // MiMo final-rung recovery gate: token position at which the last
        // threshold may fire a second time after a retryable failure.
        finalRetryAt: undefined,
        lastInjectedGeneration: undefined,
        pendingRebuild: false,
        pendingRebuildReason: undefined,
        rebuildCount: 0,
        lastRebuildAt: 0,
        lastDreamAt: undefined,
        lastDistillAt: undefined,
        lastAutoCheckAt: undefined,
        lastWriterStartedAt: 0,
        lastTurn: 0,
        lastPressure: 0,
        injectedOnce: false,
        memoryInstructionsInjected: false,
        memorySectionRegistered: false,
        warned: new Set(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  get(sessionId) {
    return this.sessions.get(sessionId)
  }

  delete(sessionId) {
    this.sessions.delete(sessionId)
  }
}

/** Cache of resolved route windows, keyed by provider/model + output cap. */
export class WindowCache {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs
    this.entries = new Map()
  }

  get(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key, value) {
    this.entries.set(key, { at: Date.now(), value })
    return value
  }

  clear() {
    this.entries.clear()
  }
}
