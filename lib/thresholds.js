// MiMo checkpoint firing plan (pure): which thresholds a pressure crosses, and
// the final-rung recovery gate. Extracted from prune.ts fireCheckpoints so the
// 30/40/60/80 state machine is unit-testable without a live writer.

/** Plan the fires for one pre-step. */
export function planThresholdFires({ thresholds, crossed, pressure, finalRetryAt }) {
  const maxThreshold = thresholds[thresholds.length - 1]
  const step = thresholds.length > 1 ? maxThreshold - thresholds[thresholds.length - 2] : maxThreshold
  const newlyCrossed = []
  let finalReady = false
  for (const threshold of thresholds) {
    if (pressure < threshold) break
    if (!crossed.has(threshold)) {
      newlyCrossed.push(threshold)
      continue
    }
    if (threshold === maxThreshold && finalRetryAt !== undefined && pressure >= finalRetryAt) {
      finalReady = true
    }
  }
  return { newlyCrossed, finalReady, maxThreshold, step }
}

/**
 * MiMo recovery gate: one ladder step above the pressure that fired the final
 * threshold, clamped to maxAllowed. Undefined means there is no room to retry.
 */
export function armFinalRetry({ firedAt, step, maxAllowed }) {
  const gate = Math.min(firedAt + step, maxAllowed)
  return gate > firedAt ? gate : undefined
}
