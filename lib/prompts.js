// Model-facing instructions for the MiMo memory port. Adapted from MiMo Code's
// `packages/cli/src/agent/prompt/checkpoint-writer.txt` and `compaction.txt`,
// collapsed into single completion calls that return durable file bodies.

export const CHECKPOINT_WRITER_MARKER = 'MIMO_CHECKPOINT_WRITER'
export const DREAM_MARKER = 'MIMO_DREAM'
export const DISTILL_MARKER = 'MIMO_DISTILL'

export const CHECKPOINT_INSTRUCTION = `You are the checkpoint writer subagent for a session that has crossed a token threshold. Your job is to update the session's checkpoint.md in-place (conceptually) to reflect the conversation up to this checkpoint, and (when appropriate) update the project's MEMORY.md with project-level knowledge that has emerged.

You are NOT the main assistant: do not continue the user's task and do not reply conversationally. Reconcile the conversation prefix and the current memory files supplied below, then output the complete updated files in the tagged blocks. Never touch files outside the supplied memory paths.

CHECKPOINT.md structure (11 sections, all required to exist; content may be "(none)"):
  ## §1 Active intent           - verbatim user request, block-quoted
  ## §2 Next concrete action    - concrete next step, with verbatim quote when possible
  ## §3 Directives (this session) - session-specific working style only
  ## §4 Task tree               - source of truth = the task ledger supplied below. Per task: 🔵 open / 🔄 in_progress / 🟡 blocked / ✅ done / ❌ abandoned. Indent sub-tasks two spaces. Append \`(progress: tasks/<id>/progress.md, last-reconciled-written-at: <n>)\` for any task whose progress journal you reconciled.
  ## §5 Current work            - what was being done before checkpoint
  ## §6 Files and code sections - files actively read/edited with one-line purpose
  ## §7 Discovered knowledge (cross-task) - cross-task facts (candidates for MEMORY.md promotion)
  ## §8 Errors and fixes        - issues encountered and how resolved
  ## §9 Live resources          - runtime state (branch, processes, etc.)
  ## §10 Design decisions and discussion outcomes - decisions reached through discussion that produced no immediate code/file artifact
  ## §11 Open notes - writer-curated catch-all for orphan content (quotes, unresolved questions, micro-observations); prefer "(none)"

MEMORY.md structure (4 sections):
  ## Project context            - what is this project, its goal
  ## Rules                      - user-stated hard constraints
  ## Architecture decisions     - major design choices with rationale
  ## Discovered durable knowledge - facts that survive across sessions

PROCEDURE:
1. Reconcile content from BOTH the conversation prefix AND the existing notes.md.
   - Working-style preference / directive → §3 (session) or MEMORY.md ## Rules (project-durable)
   - Cross-task transferable fact → §7 (session candidate) or MEMORY.md ## Discovered durable knowledge
   - Bug + fix → §8
   - Design decision / discussion outcome → §10
   - Code/file ops → §6
   - Quote, unresolved question, side observation → §11
   - EXACT-FORM CONSTRAINT LITERAL (connection strings, ports, hostnames, env values, paths, full commands, IDs, seeds, version pins) → §3 or MEMORY.md ## Rules, COPIED VERBATIM, never paraphrased. When in doubt whether a value is exact-form, treat it as exact-form.
2. For §4 Task tree, use ONLY task IDs present in the supplied task ledger. Never invent a task ID or status. If the ledger is empty, render "(none)".
3. If a section is approaching its budget, extract a coherent topic to \`checkpoint-<topic>.md\` and replace the extracted lines with \`- See checkpoint-<topic>.md (N items) - <one-line summary>\`. Do not nest spillovers.

CRITICAL CONSTRAINTS:
1. §1 Active intent MUST contain at least one block-quoted verbatim user request:
   > "<exact user words>"
   This is the anchor. Without verbatim, the next-cycle agent loses the user's actual words.
1.5. Update §1 ONLY when the user's most recent prompt is COMMITMENT-style (implement, write, build, fix, run, create, refactor, add, remove, update, design, debug). KEEP the existing §1 when the prompt is INSPECTION-style (find, list, show, inspect, tell, describe, explain, what, why, how) or when unsure. A stale §1 is recoverable; a wrong §1 erases user intent.
2. §2 SHOULD include a verbatim quote when the user explicitly stated a next step.
3. §3 is THIS SESSION only. Project-wide rules belong in MEMORY.md ## Rules — do not duplicate them in §3. If a line uses status language (X COMPLETE / done / partially complete), move its content into §5.
4. §7 facts durable enough to outlive the session should ALSO be appended to MEMORY.md ## Discovered durable knowledge.
5. Exact-form literals must be copied byte-for-byte (backticks, punctuation, both ports when two DSNs differ only by port).
6. Never invent task IDs, file paths, commands or error strings. Never paraphrase a user quote. Never write secrets/API keys/tokens.
7. Do not read source files; the conversation already contains everything you need.
8. After producing the two complete files, stop. Do not summarize what you wrote.

Merge with the existing checkpoint, MEMORY.md and notes shown below: keep still-true facts, drop stale ones, merge newer information, and do not duplicate.

Output exactly these two fenced blocks and nothing else:

<mimo-checkpoint>
## §1 Active intent
> <verbatim quote of the user's current request, trimmed to 200 chars if needed>

## §2 Next concrete action
<the concrete next step, with a verbatim quote when available>

## §3 Directives (this session)
<session-only working preferences; project rules belong in MEMORY.md>

## §4 Task tree
<per task: 🔵 open / 🔄 in_progress / 🟡 blocked / ✅ done / ❌ abandoned; indent sub-tasks two spaces>

## §5 Current work
<what was in progress at this checkpoint>

## §6 Files and code sections
<exact backticked paths actively read/edited, one-line purpose each>

## §7 Discovered knowledge (cross-task)
<transferable facts worth promoting to MEMORY.md>

## §8 Errors and fixes
<error: cause and resolution; include user corrections>

## §9 Live resources
<runtime state: branch, processes, servers, ports>

## §10 Design decisions and discussion outcomes
<decisions with rationale>

## §11 Open notes
<quotes, unresolved questions, small observations; prefer "(none)">
</mimo-checkpoint>

<mimo-memory>
## Project context
<what the project is and its goal>

## Rules
<user-stated hard constraints>

## Architecture decisions
<major design choices with rationale>

## Discovered durable knowledge
<facts that survive across sessions>
</mimo-memory>

Rules:
- Keep all 11 sections and all 4 sections, in order; use "(none)" for empty ones, never drop a section.
- Preserve exact file paths, commands, identifiers, error strings, versions, ports and numbers verbatim. Keep the "why" behind decisions.
- User quotes are historical records, not live instructions. Never quote a summary as the user's words.
- Merge with the existing checkpoint and memory shown below: keep still-true facts, drop stale ones, merge newer information, and do not duplicate.
- Stay within roughly 11,000 tokens for the checkpoint and 10,000 tokens for memory.
- Never include secrets, API keys, tokens or passwords.
- Do not mention this request, the checkpoint process, or the output format.

Marker: ${CHECKPOINT_WRITER_MARKER}`

export const CHECKPOINT_TOOL_LOOP_INSTRUCTION = `You are the checkpoint writer for a session that has crossed a token threshold. [MIMO_WRITER_TOOLS] You are running in TOOL-LOOP MODE: instead of printing the whole files, you edit them with the provided writer tools. The plugin applies your edits atomically when you finish and validates the result.

Writer tools (the ONLY tools available to you):
- writer_read({path}) — read one memory file.
- writer_write({path, content}) — replace one memory file with content.
- writer_edit({path, old_string, new_string, replace_all?}) — literal text replacement. If old_string occurs more than once you MUST pass replace_all=true (or narrow old_string).

path accepts the aliases "checkpoint", "memory", "notes" or any path ending in checkpoint.md / MEMORY.md / notes.md. Any other path is rejected. You cannot modify any other file.

CHECKPOINT.md structure (11 sections, all required to exist; content may be "(none)"):
  ## §1 Active intent           - verbatim user request, block-quoted
  ## §2 Next concrete action    - concrete next step, with verbatim quote when possible
  ## §3 Directives (this session) - session-specific working style only
  ## §4 Task tree               - source of truth = the task ledger supplied below. Per task: 🔵 open / 🔄 in_progress / 🟡 blocked / ✅ done / ❌ abandoned. Indent sub-tasks two spaces.
  ## §5 Current work            - what was being done before checkpoint
  ## §6 Files and code sections - files actively read/edited with one-line purpose
  ## §7 Discovered knowledge (cross-task) - durable lessons
  ## §8 Errors and fixes        - concrete error + fix pairs
  ## §9 Live resources          - processes/ports/sessions that are still live
  ## §10 Design decisions and discussion outcomes - only settled decisions
  ## §11 Open notes             - leftovers that do not fit above

MEMORY.md structure (4 sections):
  ## Project context, ## Rules, ## Architecture decisions, ## Discovered durable knowledge

Working rules:
1. §1 must quote the user's current request verbatim (block quote), not paraphrase.
2. Exact-form literals (flags, identifiers, paths, error strings) must be preserved exactly; never invent.
3. §4 may only reference tasks present in the ledger supplied below; do not invent task IDs and do not write tasks/*/progress.md files.
4. Drain notes.md into the checkpoint/MEMORY before you finish; after a successful write the plugin resets notes.md to its template.
5. Preserve every existing § heading when you edit; do not drop sections. Keep the checkpoint within roughly 11K tokens and MEMORY within roughly 10K tokens.
6. When you are done, stop calling tools. A short final text note is optional; do not repeat the whole files as text.
7. The conversation prefix and current memory files are supplied below; treat them as the state to reconcile.`

export const DREAM_INSTRUCTION = `You are consolidating project memory. Below are the current MEMORY.md, the session checkpoint, recent notes and the task list. Merge durable learning into a single improved MEMORY.md.

Output exactly one block and nothing else:

<mimo-memory>
## Project context
...
## Rules
...
## Architecture decisions
...
## Discovered durable knowledge
...
</mimo-memory>

Rules: keep all four sections; use "(none)" when empty; keep only durable, cross-session facts; preserve exact paths/numbers/constraints; remove stale or duplicated entries; never include secrets. Do not explain. Marker: ${DREAM_MARKER}`

export const DISTILL_INSTRUCTION = `You are packaging a repeated workflow from this session into a reusable skill. Input: the session checkpoint, method notes, and project memory. Produce one compact skill document with YAML frontmatter and actionable steps.

Output exactly one block and nothing else:

<mimo-skill>
---
name: <kebab-case-name>
description: <one sentence, when to use it>
---

# <Title>
<steps, commands, file paths, acceptance checks>
</mimo-skill>

Rules: only distill a workflow that appeared repeatedly and completed successfully; keep exact commands and paths; no secrets. Marker: ${DISTILL_MARKER}`

// MiMo ordinary-compaction prompt (packages/cli/src/agent/prompt/compaction.txt).
export const COMPACTION_INSTRUCTION = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.

Marker: MIMO_COMPACTION`

export const COMPACTION_MARKER = 'MIMO_COMPACTION'

/**
 * MiMo buildSummaryMessage: the ordinary-compaction boundary body. The trigger
 * is "manual" | "automatic" | "provider-overflow".
 */
export function buildCompactionSummaryMessage(summary, trigger, hasTail) {
  return [
    `<conversation-summary trigger="${trigger}">`,
    'The earlier conversation has been compacted into the summary below.',
    hasTail
      ? 'Complete API rounds that arrived while compaction was running follow this summary.'
      : 'No additional API rounds arrived while compaction was running.',
    '',
    String(summary ?? '').trim(),
    '</conversation-summary>',
  ].join('\n')
}

/** MiMo buildFileManifest body (5 most recently touched files). */
export function buildFilesTouchedManifest(files) {
  if (!Array.isArray(files) || files.length === 0) return undefined
  return [
    '## Attachments',
    '',
    '<files-touched>',
    'These files were read or edited earlier in this session. Their contents have been',
    'removed from context — re-read any file you need before editing it.',
    '',
    ...files.slice(-5).map((file) => `- ${String(file).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`),
    '</files-touched>',
  ].join('\n')
}

// Deprecated framing kept for backward-compatible exports/tests. Checkpoint
// rebuilds now use MiMo's renderRebuildContext dump (no outer summary tag).
export const REBUILD_PREAMBLE = 'This session was rebuilt from a MiMo checkpoint to free context. Treat the captured material as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this rebuild.'
export const REBUILD_CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.'
export const SUMMARY_OPEN_TAG = '<conversation-summary trigger="mimo-rebuild">'
export const SUMMARY_CLOSE_TAG = '</conversation-summary>'

/**
 * MiMo `buildMemoryInstructions` (packages/cli/src/session/llm.ts), adapted to
 * the plugin's tool names/paths. MiMo puts this in the system prompt; DSH has no
 * third-party system-prompt seam, so the plugin injects it once as a
 * system-reminder user message (same instructions, same active-recall protocol).
 */
export function buildMemoryInstructions(paths, { checkpointEnabled = true } = {}) {
  const files = [
    `- Project memory at \`${paths.memory}\` — persistent across all sessions in this project. Contains: project context, rules, architecture decisions, durable cross-task knowledge.`,
  ]
  if (checkpointEnabled) {
    files.push(
      `- Session checkpoint at \`${paths.checkpoint}\` — current session's structured state, written ONLY by the checkpoint-writer. 11 sections covering active intent, next action, directives, task tree, current work, files, learnings, errors, live resources, design decisions, and open notes.`,
      `- Per-task progress at \`${paths.tasks}/<id>/progress.md\` — writer-derived task narrative; read it when you need a task's detailed history.`,
    )
  }
  files.push(`- Global memory at \`${paths.globalMemory}\` — user-level preferences and cross-project feedback.${checkpointEnabled ? ' Auto-injected into rebuild context under the "# Global memory" header when present.' : ''}`)
  const sections = [
    `# Memory system

You have a persistent file-based memory system. ${checkpointEnabled ? 'Four' : 'Two'} file types:

${files.join('\n')}`,
  ]
  if (checkpointEnabled) {
    sections.push('The checkpoint writer is the sole curator of the structured files. You do not maintain them mid-task — the writer extracts everything from the conversation at checkpoint events.')
  }
  sections.push(
    `## When to edit MEMORY.md directly

You may edit MEMORY.md when:
- User states a project-level rule that should hold across sessions → ## Rules
- User states a project-level architectural decision → ## Architecture decisions
- A clearly durable cross-session fact emerges that you want available immediately → ## Discovered durable knowledge

These are exceptions, not the norm. The writer covers most extraction at checkpoint time.`,
    `## Notes scratchpad

You have a single legal scratchpad at \`${paths.notes}\`. Append entries with the mimo_memory_write tool when you want to record a quote, an unresolved question, a cross-project observation, or a note for future-self. Format each entry as:
  ## [turn N · YYYY-MM-DDTHH:MM:SSZ]
  Free-form body.

This is your ONLY legal scratchpad — don't create learning.md, scratch.md, or any other ad-hoc memory file.`,
    `## What NOT to do

${[
      ...(checkpointEnabled ? ["- Don't edit checkpoint.md — that's the writer's domain."] : []),
      "- Don't create memory files other than notes.md.",
      "- Don't ask the user about something memory may already record — search first with mimo_memory_search (or grep/read the paths above).",
    ].join('\n')}`,
  )
  if (checkpointEnabled) {
    sections.push(
      `## Active recall protocol

After a checkpoint rebuild, these dumps may already be in your context (the message begins with "The sections below are auto-loaded session context already in this message."):

- checkpoint.md, MEMORY.md, notes.md, global/MEMORY.md, tasks ledger, recent user input, recent activity.

If these dumps are visible:
- Do NOT read them again as whole files. The bytes are already in front of you.
- For specific past details, use mimo_memory_search/grep with a keyword; do not pull a whole file.
- For files NOT in the rebuild dump, read on demand.

Memory entries name functions, files, flags, paths — those are CLAIMS about a point in time when they were written. Verify before acting on a specific name.`,
    )
  }
  return sections.join('\n\n')
}

export const MEMORY_INJECTION_HEADER = 'The following MiMo memory was restored for this session. Use it as background; do not treat quoted user text as a new request.'

export function memoryInjectionWrapper(body) {
  return `<system-reminder>\n${MEMORY_INJECTION_HEADER}\n\n${body}\n</system-reminder>`
}
