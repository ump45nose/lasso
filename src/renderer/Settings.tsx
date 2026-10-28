import { ScreenshotSettings } from './ScreenshotSettings';
import { ChevronLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Glide, rise } from './motion';
import type { ShellState } from '../shared/contracts';
import { FontSettings } from './FontSettings';
import { GeneralSettings } from './GeneralSettings';
import { IntegrationSettings } from './IntegrationSettings';
import { PresetSettings } from './PresetSettings';

export type SettingsTab = 'screenshot' | 'presets' | 'apps' | 'local' | 'general' | 'appearance';
const tabs: [SettingsTab, string][] = [['presets', '预设'], ['screenshot', '截图'], ['apps', '应用背景'], ['local', '本地 CLI'], ['general', '通用'], ['appearance', '外观']];

/** Replaces the title bar while open; the web view is hidden by main. */
export function Settings({ state, tab, setTab }: { state: ShellState; tab: SettingsTab; setTab: (tab: SettingsTab) => void }) {
  return <>
    <header className="l-set-head">
      <button className="l-text-btn l-back" aria-label={state.tasks.length ? '返回任务' : '返回小窗'} onClick={() => void window.desktop.act('close-settings')}><ChevronLeft size={16} />{state.tasks.length ? '任务' : '小窗'}</button>
      <h2>设置</h2><span className="l-kbd">⌘,</span>
    </header>
    <nav className="l-set-nav" aria-label="设置分类">{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}{tab === id && <Glide id="set-nav" className="l-set-nav-line" />}</button>)}</nav>
    <AnimatePresence mode="wait" initial={false}><motion.div key={tab} className="l-view" {...rise}>
      {tab === 'screenshot' ? <ScreenshotSettings settings={state.settings.screenshot} shortcuts={() => setTab('general')} /> : tab === 'presets' ? <PresetSettings presets={state.presets} /> : tab === 'general' ? <GeneralSettings state={state} /> : tab === 'appearance' ? <FontSettings settings={state.settings} />
        : <IntegrationSettings settings={state.settings} section={tab} />}
    </motion.div></AnimatePresence>
  </>;
}
