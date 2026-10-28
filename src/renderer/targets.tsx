import { targetLabels, taskActivityLabels } from '../shared/contracts';
import { Image } from 'lucide-react';
import type { LocalTarget, Target, TaskSummary, PresetTarget } from '../shared/contracts';
import chatgptIcon from './assets/targets/chatgpt.png';
import geminiIcon from './assets/targets/gemini.png';
import codexIcon from './assets/targets/codex.png';
import piIcon from './assets/targets/pi.svg';

export const targets = Object.keys(targetLabels) as Target[];
/** Official artwork only, one file per target in assets/targets (see AGENTS.md). A new target without an icon fails to typecheck. */
export const targetIcons: Record<Target, string> = { chatgpt: chatgptIcon, gemini: geminiIcon, codex: codexIcon, pi: piIcon };
export const isLocal = (target: Target | null): target is LocalTarget => target === 'codex' || target === 'pi';
export const taskStatus = (task: TaskSummary) => task.residency === 'released' ? '已释放 · 点击恢复' : task.retainedReason || taskActivityLabels[task.activity];
export const taskDot = (task: TaskSummary) => task.residency === 'released' ? 'released' : task.activity;
export const shortcutLabel = (value: string) => value.replace(/CommandOrControl|Command/gi, '⌘').replace(/Control/gi, '⌃').replace(/Alt|Option/gi, '⌥').replace(/Shift/gi, '⇧').replaceAll('+', ' ').replace('Space', '空格');
export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

export function Badge({ target }: { target: PresetTarget }) {
  if (target === 'api') return <Image size={16} className="l-badge" aria-label="New API" />;
  return <img className="l-badge" src={targetIcons[target]} alt={targetLabels[target]} draggable={false} />;
}
