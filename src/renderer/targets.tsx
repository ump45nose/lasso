import { targetLabels, taskActivityLabels } from '../shared/contracts';
import type { LocalTarget, Target, TaskSummary } from '../shared/contracts';

export const targets = Object.keys(targetLabels) as Target[];
export const targetBadges: Record<Target, string> = { chatgpt: 'Ch', gemini: 'Ge', codex: 'Cx', pi: 'π' };
export const isLocal = (target: Target | null): target is LocalTarget => target === 'codex' || target === 'pi';
export const taskStatus = (task: TaskSummary) => task.residency === 'released' ? '已释放 · 点击恢复' : task.retainedReason || taskActivityLabels[task.activity];
export const taskDot = (task: TaskSummary) => task.residency === 'released' ? 'released' : task.activity;
export const shortcutLabel = (value: string) => value.replace(/CommandOrControl|Command/gi, '⌘').replace(/Control/gi, '⌃').replace(/Alt|Option/gi, '⌥').replace(/Shift/gi, '⇧').replaceAll('+', ' ').replace('Space', '空格');
export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

export function Badge({ target }: { target: Target }) {
  return <span className={'l-badge' + (isLocal(target) ? ' local' : '')} aria-label={targetLabels[target]}>{targetBadges[target]}</span>;
}
