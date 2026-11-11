// Configuration defaults and validation for dsh-mimo-context.
// Deliberately dependency-free: the Cordis loader passes the composition row's
// plain object, so we normalize and validate it ourselves.

export const DEFAULTS = Object.freeze({
  // Mirrors MIMOCODE_DISABLE_CHECKPOINT: when false the plugin neither checkpoints
  // nor rebuilds, and ordinary compaction is the fallback.
  checkpointEnabled: true,
  // Mirrors memory.disable_write: when false no new memory is written and rebuild
  // is short-circuited to ordinary compaction.
  memoryWrite: true,
  autoCheckpoint: true,
  autoRebuild: true,
  overflowRebuild: true,
  fallbackCompaction: true,
  mainOnly: true,

  // Checkpoint ladder. Entries may be numbers (absolute tokens) or strings such
  // as "20%" (fraction of the checkpoint window) or "100K" (absolute).
  // null = MiMo's window-dependent ladder.
  checkpoints: null,
  checkpointDensity: 'mimo', // 'mimo' | 'simple' (20/40/60/80)
  // MiMo CHECKPOINT_RESERVED: thresholds are clamped/dropped above window-reserved.
  checkpointReserved: 13000,

  // Rebuild trigger: null = native compaction trigger minus margin (MiMo's
  // `usable()` analogue). Checkpoint thresholds are percentages of this value.
  rebuildTriggerTokens: null,
  rebuildMarginTokens: null, // null = max(8192, 1% of window)
  rebuildCooldownMs: 30000,

  // MiMo computeBoundary: the writer's coverage stops short of the most recent
  // 10K-20K tail, so the next rebuild has fresh verbatim material to digest.
  tailMinTokens: 10000,
  tailMaxTokens: 20000,
  tailMinTextBlockMessages: 5,

  writerProvider: '',
  writerModel: '',
  // 'direct' (default): one text-only `ctx.llm.stream()` over the
  // watermark-capped prefix; the plugin is the sole writer. 'tools': bounded
  // in-process writer loop over read/write/edit against in-memory buffers
  // (checkpoint/MEMORY/notes only), falls back to direct on failure. 'auto'
  // first tries a TAGGED-TEXT-only fork/spawn subagent (never writes disk),
  // then direct. 'subagent' requires the seam and forbids the direct fallback.
  writerBackend: 'direct',
  writerSubagentProvider: 'fork',
  writerSubagentPreset: '', // optional spawn agentPreset (narrow read-only preset)
  writerSubagentFallback: true,
  writerToolRounds: 6,
  writerMaxTokens: 24000,
  writerTimeoutMs: 300000, // MiMo writer bound: 5 minutes
  writerInputTokenLimit: 120000,
  // MiMo rebuild waits: 30s when a usable checkpoint exists, 5min for the first
  // one, 180s on the automatic path, 300s on manual /rebuild.
  writerWaitMs: 180000,
  firstCheckpointWaitMs: 300000,
  manualRebuildWaitMs: 300000,
  existingCheckpointWaitMs: 30000,

  memoryInjectTokens: 12000,
  memoryBudget: {
    checkpoint: 6000,
    memory: 6000,
    tasks: 2000,
    notes: 2000,
  },
  // MiMo does not auto-inject memory CONTENT on resume; it is loaded by the
  // rebuild dump and otherwise read/search on demand. Kept opt-in for DSH.
  injectOnStart: false,
  // MiMo always teaches the memory system in the system prompt; DSH 0.2.2
  // exposes ctx.systemPrompt.section, so this registers a scoped section on
  // agent/created and only falls back to a one-time user reminder when the
  // service is unavailable.
  injectMemoryInstructions: true,

  // MiMo renderRebuildContext caps (checkpoint.push_caps in MiMo config).
  pushCaps: {
    tasksLedger: 2000,
    focusTask: 4000,
    actorLedger: 500,
    memoryTitles: 500,
    global: 6000,
    checkpoint: 11000,
    memory: 10000,
    notes: 6000,
    recentUser: 16000,
    recentUserPerMsg: 2000,
  },

  storageDir: '', // default $DSH_HOME/mimo-context
  storage: {
    // 'mimo' -> <root>/{sessions,projects,global}; 'workspace' -> legacy single dir
    layout: 'mimo',
    // true -> legacy layout under <cwd>/.mimo-context
    workspace: false,
    maxCheckpointBytes: 200000,
    maxMemoryBytes: 120000,
    maxNotesBytes: 200000,
  },

  dreamAuto: false,
  dreamIntervalDays: 7,
  distillAuto: false,
  distillIntervalDays: 30,

  debug: false,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asPositiveInt(name, value, { allowZero = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`dsh-mimo-context: ${name} must be an integer`);
  }
  if (value < 0 || (!allowZero && value === 0)) {
    throw new Error(`dsh-mimo-context: ${name} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return value;
}

function asBoolean(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`dsh-mimo-context: ${name} must be a boolean`);
  return value;
}

function asString(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`dsh-mimo-context: ${name} must be a string`);
  return value;
}

/**
 * Normalize a composition-row config object into the internal shape.
 * Throws on structurally invalid values (fail-fast at profile load).
 */
export function normalizeConfig(raw = {}) {
  if (!isPlainObject(raw)) throw new Error('dsh-mimo-context: config must be an object');
  const cfg = {
    ...DEFAULTS,
    ...raw,
    storage: { ...DEFAULTS.storage, ...(isPlainObject(raw.storage) ? raw.storage : {}) },
    memoryBudget: { ...DEFAULTS.memoryBudget, ...(isPlainObject(raw.memoryBudget) ? raw.memoryBudget : {}) },
    pushCaps: { ...DEFAULTS.pushCaps, ...(isPlainObject(raw.pushCaps) ? raw.pushCaps : {}) },
  };

  for (const key of ['checkpointEnabled', 'memoryWrite', 'fallbackCompaction', 'writerSubagentFallback']) {
    cfg[key] = raw[key] === undefined ? DEFAULTS[key] : asBoolean(key, raw[key]);
  }
  cfg.writerBackend = raw.writerBackend === undefined ? DEFAULTS.writerBackend : String(raw.writerBackend).toLowerCase();
  if (!['auto', 'direct', 'subagent', 'tools'].includes(cfg.writerBackend)) {
    throw new Error('dsh-mimo-context: writerBackend must be "auto", "direct", "subagent", or "tools"');
  }
  cfg.writerToolRounds = asPositiveInt('writerToolRounds', cfg.writerToolRounds) ?? DEFAULTS.writerToolRounds;
  cfg.writerSubagentProvider = raw.writerSubagentProvider === undefined ? DEFAULTS.writerSubagentProvider : String(raw.writerSubagentProvider);
  cfg.writerSubagentPreset = raw.writerSubagentPreset === undefined ? DEFAULTS.writerSubagentPreset : String(raw.writerSubagentPreset);
  cfg.autoCheckpoint = raw.autoCheckpoint === undefined ? DEFAULTS.autoCheckpoint : asBoolean('autoCheckpoint', raw.autoCheckpoint);
  cfg.autoRebuild = raw.autoRebuild === undefined ? DEFAULTS.autoRebuild : asBoolean('autoRebuild', raw.autoRebuild);
  cfg.overflowRebuild = raw.overflowRebuild === undefined ? DEFAULTS.overflowRebuild : asBoolean('overflowRebuild', raw.overflowRebuild);
  cfg.mainOnly = raw.mainOnly === undefined ? DEFAULTS.mainOnly : asBoolean('mainOnly', raw.mainOnly);
  cfg.injectOnStart = raw.injectOnStart === undefined ? DEFAULTS.injectOnStart : asBoolean('injectOnStart', raw.injectOnStart);
  cfg.injectMemoryInstructions = raw.injectMemoryInstructions === undefined ? DEFAULTS.injectMemoryInstructions : asBoolean('injectMemoryInstructions', raw.injectMemoryInstructions);
  cfg.dreamAuto = raw.dreamAuto === undefined ? DEFAULTS.dreamAuto : asBoolean('dreamAuto', raw.dreamAuto);
  cfg.distillAuto = raw.distillAuto === undefined ? DEFAULTS.distillAuto : asBoolean('distillAuto', raw.distillAuto);
  cfg.debug = raw.debug === undefined ? DEFAULTS.debug : asBoolean('debug', raw.debug);

  if (raw.checkpoints !== undefined && raw.checkpoints !== null) {
    if (!Array.isArray(raw.checkpoints) || raw.checkpoints.length === 0) {
      throw new Error('dsh-mimo-context: checkpoints must be a non-empty array');
    }
    cfg.checkpoints = raw.checkpoints.map((entry) => {
      if (typeof entry === 'number') return entry;
      if (typeof entry === 'string' && /^\d+(?:\.\d+)?%$/.test(entry.trim())) return entry.trim();
      if (typeof entry === 'string' && /^\d+(?:\.\d+)?[KkMm]?$/.test(entry.trim())) return entry.trim();
      throw new Error(`dsh-mimo-context: invalid checkpoint entry ${JSON.stringify(entry)} (use 50000, "50K", or "40%")`);
    });
    // Order is preserved: MiMo clamps the FIRST over-cap entry and drops later
    // ones, so user-provided order is part of the contract.
  } else {
    cfg.checkpoints = null;
  }
  cfg.checkpointDensity = raw.checkpointDensity === undefined ? DEFAULTS.checkpointDensity : String(raw.checkpointDensity).toLowerCase();
  if (!['mimo', 'simple'].includes(cfg.checkpointDensity)) {
    throw new Error('dsh-mimo-context: checkpointDensity must be "mimo" or "simple"');
  }

  for (const key of ['checkpointReserved', 'rebuildTriggerTokens', 'rebuildMarginTokens', 'rebuildCooldownMs', 'tailMinTokens', 'tailMaxTokens', 'tailMinTextBlockMessages', 'writerMaxTokens', 'writerTimeoutMs', 'writerInputTokenLimit', 'writerWaitMs', 'firstCheckpointWaitMs', 'manualRebuildWaitMs', 'existingCheckpointWaitMs', 'memoryInjectTokens']) {
    const value = asPositiveInt(key, cfg[key], { allowZero: key === 'tailMinTokens' });
    if (value === undefined) delete cfg[key];
    else cfg[key] = value;
  }

  for (const key of ['writerProvider', 'writerModel', 'storageDir']) cfg[key] = asString(key, cfg[key]) ?? '';

  for (const key of ['maxCheckpointBytes', 'maxMemoryBytes', 'maxNotesBytes']) {
    const value = asPositiveInt(`storage.${key}`, cfg.storage[key]);
    if (value === undefined) delete cfg.storage[key];
    else cfg.storage[key] = value;
  }
  cfg.storage.workspace = cfg.storage.workspace === true;
  cfg.storage.layout = raw.storage?.layout === undefined ? DEFAULTS.storage.layout : String(raw.storage.layout).toLowerCase();
  if (!['mimo', 'workspace'].includes(cfg.storage.layout)) {
    throw new Error('dsh-mimo-context: storage.layout must be "mimo" or "workspace"');
  }
  if (cfg.storage.workspace) cfg.storage.layout = 'workspace';

  for (const key of ['checkpoint', 'memory', 'tasks', 'notes']) {
    const value = asPositiveInt(`memoryBudget.${key}`, cfg.memoryBudget[key], { allowZero: true });
    if (value === undefined) delete cfg.memoryBudget[key];
    else cfg.memoryBudget[key] = value;
  }

  for (const key of Object.keys(DEFAULTS.pushCaps)) {
    const value = asPositiveInt(`pushCaps.${key}`, cfg.pushCaps[key], { allowZero: key === 'recentUser' });
    if (value === undefined) delete cfg.pushCaps[key];
    else cfg.pushCaps[key] = value;
  }

  cfg.dreamIntervalDays = asPositiveInt('dreamIntervalDays', cfg.dreamIntervalDays) ?? DEFAULTS.dreamIntervalDays;
  cfg.distillIntervalDays = asPositiveInt('distillIntervalDays', cfg.distillIntervalDays) ?? DEFAULTS.distillIntervalDays;

  return cfg;
}

/** Parse a token quantity ("50%", "100K", "1.5M", number) against a base. */
export function parseTokenQuantity(value, base) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?%$/.test(text)) return Math.max(0, Math.floor(base * (Number.parseFloat(text) / 100)));
  const match = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(text);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const factor = unit === 'M' ? 1_000_000 : unit === 'K' ? 1_000 : 1;
  return Math.max(0, Math.floor(amount * factor));
}

// ---------------------------------------------------------------------------
// MiMo Code threshold semantics (packages/cli/src/session/prune.ts)
// ---------------------------------------------------------------------------

export const CHECKPOINT_RESERVED = 13000;

/** MiMo defaultThresholdsFor(window): <25K off, <=200K 20/40/60/80%, <=500K
 * 10..90%, >500K 5..90% of the checkpoint window (MiMo's `usable()`). */
export function defaultThresholdsFor(window) {
  if (!Number.isFinite(window) || window < 25000) return [];
  if (window <= 200000) return ['20%', '40%', '60%', '80%'];
  if (window <= 500000) return ['10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%'];
  return Array.from({ length: 18 }, (_, index) => `${(index + 1) * 5}%`);
}

/** MiMo parseThreshold: percentage, K/k, M/m, or plain number. */
export function parseThreshold(value, window) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid checkpoint threshold: "${value}"`);
    return Math.floor(value);
  }
  if (typeof value !== 'string') throw new Error(`Invalid checkpoint threshold: "${String(value)}"`);
  const text = value.trim();
  if (text.endsWith('%')) {
    const amount = Number.parseFloat(text.slice(0, -1));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
      throw new Error(`Invalid checkpoint threshold percentage: "${value}" (must be 0 < n <= 100)`);
    }
    return Math.floor((window * amount) / 100);
  }
  const match = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(text);
  if (!match) throw new Error(`Invalid checkpoint threshold format: "${value}"`);
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const factor = unit === 'M' ? 1_000_000 : unit === 'K' ? 1_000 : 1;
  return Math.floor(amount * factor);
}

/** MiMo maxAllowedFor(window, reserved): the highest meaningful threshold. */
export function maxAllowedFor(window, reserved = CHECKPOINT_RESERVED) {
  return window - reserved;
}

/**
 * MiMo resolveThresholds: first over-cap entry is clamped to maxAllowed, later
 * over-cap entries are dropped; sorted + deduped. Throws when the window cannot
 * fit the reserve.
 */
export function resolveThresholds(raw, window, reserved) {
  const effectiveReserved = reserved ?? CHECKPOINT_RESERVED;
  const maxAllowed = maxAllowedFor(window, reserved);
  if (maxAllowed <= 0) {
    throw new Error(`Model window size (${window}) is too small for checkpoints (need > ${effectiveReserved} reserved tokens)`);
  }
  const parsed = raw.map((entry) => ({ raw: entry, value: parseThreshold(entry, window) }));
  const result = [];
  let cappedAlready = false;
  for (const item of parsed) {
    if (item.value <= maxAllowed) {
      result.push(item.value);
      continue;
    }
    if (!cappedAlready) {
      result.push(maxAllowed);
      cappedAlready = true;
    }
  }
  const values = result.sort((a, b) => a - b);
  const deduped = [];
  for (const value of values) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== value) deduped.push(value);
  }
  return deduped;
}

/** MiMo MiMo checkpoint ladder against the checkpoint window (our rebuildAt). */
export function resolveCheckpointLadder(config, window) {
  const raw = Array.isArray(config.checkpoints) && config.checkpoints.length > 0
    ? config.checkpoints
    : config.checkpointDensity === 'simple'
      ? ['20%', '40%', '60%', '80%']
      : defaultThresholdsFor(window);
  return resolveThresholds(raw, window, config.checkpointReserved);
}

/** Backward-compatible explicit ladder resolver (no reserved clamp). */
export function resolveCheckpoints(list, window) {
  if (!Array.isArray(list)) return [];
  const values = list.map((entry) => parseThreshold(entry, window)).filter((value) => value > 0).sort((a, b) => a - b);
  const unique = [];
  for (const value of values) {
    if (unique.length === 0 || unique[unique.length - 1] !== value) unique.push(value);
  }
  return unique;
}

/** MiMo default ladder as ratios; kept for tests/inspection. */
export function mimoCheckpointRatios(window) {
  return defaultThresholdsFor(window).map((entry) => Number.parseInt(entry, 10) / 100);
}
