// Pure view-model: map the agent's machine phase to calm, human language for the UI.
import type { TaskPhase } from '@/shared/messages';

export interface PhaseInfo {
  label: string;
  tone: 'idle' | 'busy' | 'done' | 'error';
  busy: boolean;
}

/** A friendly, present-tense description of what the agent is doing right now. */
export function describePhase(phase: TaskPhase): PhaseInfo {
  switch (phase) {
    case 'PLANNING':
      return { label: 'Planning the task', tone: 'busy', busy: true };
    case 'EXECUTING':
      return { label: 'Working in the page', tone: 'busy', busy: true };
    case 'EVALUATING':
      return { label: 'Checking the result', tone: 'busy', busy: true };
    case 'COMPACTING':
      return { label: 'Summarizing context', tone: 'busy', busy: true };
    case 'BLOCKED':
      return { label: 'Waiting for you to resolve a check on the page', tone: 'error', busy: true };
    case 'DONE':
      return { label: 'Done', tone: 'done', busy: false };
    case 'ABORTED':
      return { label: 'Stopped', tone: 'error', busy: false };
    case 'IDLE':
    default:
      return { label: 'Idle', tone: 'idle', busy: false };
  }
}

/** True while the agent is actively working (a Stop affordance should show). */
export function isRunning(phase: TaskPhase): boolean {
  return phase !== 'IDLE' && phase !== 'DONE' && phase !== 'ABORTED';
}
