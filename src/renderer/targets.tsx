import { Image, Zap } from 'lucide-react';
import { targetLabels, taskActivityLabels } from '../shared/contracts';
import type { PresetTarget, Target, TaskSummary, WebTarget } from '../shared/contracts';
import chatgptIcon from './assets/targets/chatgpt.png';
import geminiIcon from './assets/targets/gemini.png';

export const targets = Object.keys(targetLabels) as Target[];
/** Official artwork only for web targets (see AGENTS.md). */
export const targetIcons: Record<WebTarget, string> = { chatgpt: chatgptIcon, gemini: geminiIcon };
export const taskStatus = (task: TaskSummary) =>
  task.residency === 'released' ? '已释放 · 点击恢复' : task.retainedReason || taskActivityLabels[task.activity];
export const taskDot = (task: TaskSummary) => (task.residency === 'released' ? 'released' : task.activity);
export const shortcutLabel = (value: string) =>
  value
    .replace(/CommandOrControl|Command/gi, '⌘')
    .replace(/Control/gi, '⌃')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Shift/gi, '⇧')
    .replaceAll('+', '')
    .replace('Space', '空格');
export const folderName = (path: string) => path.split('/').filter(Boolean).at(-1) || path;

export function Badge({ target, kind = 'chat', dark = false }: { target: PresetTarget; kind?: 'chat' | 'image'; dark?: boolean }) {
  if (kind === 'image') return <Image size={15} className="l-badge l-badge-icon" aria-label="生图" />;
  if (target === 'api') return <Zap size={15} className="l-badge l-badge-icon" aria-label="API" />;
  return (
    <img
      className={dark ? 'l-badge l-badge-dark' : 'l-badge'}
      src={targetIcons[target]}
      alt={targetLabels[target]}
      draggable={false}
    />
  );
}
