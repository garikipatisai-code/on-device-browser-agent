// Circuit breaker: detects loops, low diversity, no-progress, unknown-tool storms.
// Pure data — orchestrator owns its state instance.

export interface BreakerConfig {
  consecutiveRepeatLimit: number;
  diversityWindow: number;
  minDistinctActions: number;
  unknownToolWindow: number;
  unknownToolLimit: number;
  noProgressTurnLimit: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  consecutiveRepeatLimit: 3,
  diversityWindow: 10,
  minDistinctActions: 3,
  unknownToolWindow: 8,
  unknownToolLimit: 3,
  noProgressTurnLimit: 8,
};

export interface BreakerState {
  recentActionHashes: string[];
  recentUnknownToolFlags: boolean[];
  consecutiveRepeats: number;
  lastActionHash: string | null;
  turnsSinceLastFinding: number;
}

export function newBreakerState(): BreakerState {
  return {
    recentActionHashes: [],
    recentUnknownToolFlags: [],
    consecutiveRepeats: 0,
    lastActionHash: null,
    turnsSinceLastFinding: 0,
  };
}

export interface BreakerVerdict {
  trip: boolean;
  reason?: 'action-repeat' | 'low-diversity' | 'unknown-tool-storm' | 'no-progress';
  detail?: string;
}

export function recordAction(
  state: BreakerState,
  hash: string,
  unknownTool: boolean,
  foundNewFinding: boolean,
  cfg: BreakerConfig = DEFAULT_BREAKER,
): BreakerState {
  const recentActionHashes = [...state.recentActionHashes, hash].slice(-cfg.diversityWindow);
  const recentUnknownToolFlags = [...state.recentUnknownToolFlags, unknownTool].slice(-cfg.unknownToolWindow);
  const consecutiveRepeats =
    state.lastActionHash === hash ? state.consecutiveRepeats + 1 : 1;
  const turnsSinceLastFinding = foundNewFinding ? 0 : state.turnsSinceLastFinding + 1;
  return {
    recentActionHashes,
    recentUnknownToolFlags,
    consecutiveRepeats,
    lastActionHash: hash,
    turnsSinceLastFinding,
  };
}

export function checkBreaker(state: BreakerState, cfg: BreakerConfig = DEFAULT_BREAKER): BreakerVerdict {
  if (state.consecutiveRepeats >= cfg.consecutiveRepeatLimit) {
    return { trip: true, reason: 'action-repeat', detail: `repeated ${state.consecutiveRepeats}x` };
  }
  if (
    state.recentActionHashes.length >= cfg.diversityWindow &&
    new Set(state.recentActionHashes).size < cfg.minDistinctActions
  ) {
    return {
      trip: true,
      reason: 'low-diversity',
      detail: `${new Set(state.recentActionHashes).size} distinct in last ${cfg.diversityWindow}`,
    };
  }
  const unknownCount = state.recentUnknownToolFlags.filter(Boolean).length;
  if (unknownCount >= cfg.unknownToolLimit) {
    return { trip: true, reason: 'unknown-tool-storm', detail: `${unknownCount} bogus tool names` };
  }
  if (state.turnsSinceLastFinding >= cfg.noProgressTurnLimit) {
    return {
      trip: true,
      reason: 'no-progress',
      detail: `no new findings in ${state.turnsSinceLastFinding} turns`,
    };
  }
  return { trip: false };
}

export function resetForNewStep(state: BreakerState): BreakerState {
  // A new step is a clean slate: clear the windowed detectors too, so a fresh
  // step can't trip on stale flags/hashes accumulated during the previous one.
  void state;
  return newBreakerState();
}
