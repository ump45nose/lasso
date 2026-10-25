import { ChevronLeft } from 'lucide-react';
import type { ShellState } from '../shared/contracts';
import { GeneralSettings } from './GeneralSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { PresetSettings } from './PresetSettings';

export type SettingsTab = 'presets' | 'apps' | 'local' | 'general';
const tabs: [SettingsTab, string][] = [['presets', '预设'], ['apps', '应用背景'], ['local', '本地 CLI'], ['general', '通用']];

/** Replaces the title bar while open; the web view is hidden by main. */
export function Settings({ state, tab, setTab }: { state: ShellState; tab: SettingsTab; setTab: (tab: SettingsTab) => void }) {
  return <>
    <header className="l-set-head">
      <button className="l-text-btn l-back" aria-label={state.tasks.length ? '返回任务' : '返回小窗'} onClick={() => void window.desktop.act('close-settings')}><ChevronLeft size={16} />{state.tasks.length ? '任务' : '小窗'}</button>
      <h2>设置</h2><span className="l-kbd">⌘,</span>
    </header>
    <nav className="l-set-nav" aria-label="设置分类">{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === 'general' ? <GeneralSettings state={state} />
      : <div className="l-set-body l-surface-enter" key={tab}>{tab === 'presets' ? <PresetSettings presets={state.presets} /> : <IntegrationSettings settings={state.settings} section={tab} />}</div>}
  </>;
}
