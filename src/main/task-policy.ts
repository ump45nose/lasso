import type { TaskActivity } from '../shared/contracts';
export interface ReleaseCandidate {
  active: boolean;
  resident: boolean;
  activity: TaskActivity;
  hasDraft: boolean;
  pending: boolean;
  hasPopup: boolean;
  restoreUrl: string | null;
  lastActivityAt: number;
}
export function isIdleCandidate(task: ReleaseCandidate, now: number, idleMs: number): boolean {
  return task.resident && !task.active && task.activity === 'complete' && !task.hasDraft
    && !task.pending && !task.hasPopup && Boolean(task.restoreUrl)
    && now - task.lastActivityAt >= idleMs;
}
