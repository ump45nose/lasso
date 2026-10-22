import type { TaskActivity } from '../shared/contracts';
export const IDLE_RELEASE_MS = 10 * 60 * 1000;
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
export function isIdleCandidate(task: ReleaseCandidate, now: number): boolean {
  return task.resident && !task.active && task.activity === 'complete' && !task.hasDraft
    && !task.pending && !task.hasPopup && Boolean(task.restoreUrl)
    && now - task.lastActivityAt >= IDLE_RELEASE_MS;
}
