import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  Keyboard,
  Languages,
  LayoutDashboard,
  Plug,
  Plus,
  SlidersHorizontal,
  Sparkles,
  TextCursorInput,
  type LucideIcon
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { SettingsSection, ShellState } from '../shared/contracts';
import { useFonts } from './fonts';
import {
  DesktopSuitePane,
  GeneralAppearancePane,
  SelectionActionBarPane,
  ShortcutsSyncPane,
  TranslationPane
} from './GeneralSettings';
import { ConnectionsPane } from './ImageOptionsFields';
import { rise } from './motion';
import { PresetSettings } from './PresetSettings';
import { ScreenshotSettings } from './ScreenshotSettings';

const modules: readonly { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: '通用与外观', icon: SlidersHorizontal },
  { id: 'selection', label: '划词与动作条', icon: TextCursorInput },
  { id: 'presets', label: 'AI 预设与生图', icon: Sparkles },
  { id: 'translation', label: '翻译', icon: Languages },
  { id: 'connections', label: '模型与 API 连接', icon: Plug },
  { id: 'capture', label: '截图、贴图与录屏', icon: Camera },
  { id: 'suite', label: '桌面套件', icon: LayoutDashboard },
  { id: 'shortcuts', label: '快捷键与同步', icon: Keyboard }
];

export function Settings() {
  const [state, setState] = useState<ShellState | null>(null);
  const [section, setSection] = useState<SettingsSection>('general');
  const [saveState, setSaveState] = useState<{ error?: string }>({});
  const [creatingPreset, setCreatingPreset] = useState<'chat' | 'image' | null>(null);
  const [creatingConn, setCreatingConn] = useState(false);
  const externalSectionRef = useRef<SettingsSection | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);

  useFonts(state?.settings);

  useEffect(() => {
    document.documentElement.dataset.theme = state?.settings.themeMode || 'paper';
  }, [state?.settings.themeMode]);

  const applyState = useCallback((next: ShellState) => {
    setState(next);
    if (next.settingsSection && next.settingsSection !== externalSectionRef.current) {
      externalSectionRef.current = next.settingsSection;
      setSection(next.settingsSection);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const stop = window.desktop.onState(next => {
      if (active) applyState(next);
    });
    void window.desktop.getState().then(next => {
      if (active) applyState(next);
    });
    return () => {
      active = false;
      stop();
    };
  }, [applyState]);

  const notify = useCallback((status: { ok?: boolean; error?: string }) => {
    if (status.error) setSaveState({ error: status.error });
    else setSaveState({});
  }, []);

  function switchSection(next: SettingsSection) {
    setSection(next);
    setSaveState({});
    setCreatingPreset(null);
    setCreatingConn(false);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }

  if (!state) return <main className="l-set-win" aria-label="Lasso 设置" />;

  const currentModule = modules.find(m => m.id === section) || modules[0];

  return (
    <main className="l-set-win" aria-label="Lasso 设置">
      <aside className="l-set-side" aria-label="设置分类">
        {modules.map(item => {
          const Icon = item.icon;
          const active = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              className="l-set-nav-item"
              aria-current={active ? 'page' : undefined}
              onClick={() => switchSection(item.id)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <div className="l-set-ver">Lasso 2.4.0</div>
      </aside>

      <section className="l-set-pane" aria-labelledby="settings-pane-title">
        <header className="l-set-pane-head">
          <h1 id="settings-pane-title">{currentModule.label}</h1>
          <span className={'l-set-saved' + (saveState.error ? ' error' : '')} role={saveState.error ? 'alert' : 'status'}>
            {saveState.error ? (
              <span>{saveState.error}</span>
            ) : (
              <>
                <Check size={13} />
                <span>已自动保存</span>
              </>
            )}
          </span>
          {section === 'presets' && (
            <button type="button" className="l-btn small" onClick={() => setCreatingPreset('chat')}>
              <Plus size={13} />
              <span>新建预设</span>
            </button>
          )}
          {section === 'connections' && (
            <button type="button" className="l-btn small" onClick={() => setCreatingConn(true)}>
              <Plus size={13} />
              <span>新建连接</span>
            </button>
          )}
        </header>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={section} ref={bodyRef} className="l-set-pane-body" {...rise}>
            {section === 'general' && <GeneralAppearancePane state={state} notify={notify} />}
            {section === 'selection' && <SelectionActionBarPane state={state} notify={notify} />}
            {section === 'presets' && (
              <PresetSettings
                presets={state.presets}
                creatingKind={creatingPreset}
                onClearCreate={() => setCreatingPreset(null)}
                onOpenConnections={() => switchSection('connections')}
                notify={notify}
              />
            )}
            {section === 'translation' && (
              <TranslationPane
                translation={state.settings.translation}
                onOpenConnections={() => switchSection('connections')}
                notify={notify}
              />
            )}
            {section === 'connections' && (
              <ConnectionsPane
                state={state}
                creatingNew={creatingConn}
                onStartCreate={() => setCreatingConn(true)}
                onDoneCreate={() => setCreatingConn(false)}
                notify={notify}
              />
            )}
            {section === 'capture' && (
              <ScreenshotSettings
                fullSettings={state.settings}
                onOpenShortcuts={() => switchSection('shortcuts')}
                onOpenConnections={() => switchSection('connections')}
                notify={notify}
              />
            )}
            {section === 'suite' && <DesktopSuitePane state={state} notify={notify} />}
            {section === 'shortcuts' && <ShortcutsSyncPane state={state} notify={notify} />}
          </motion.div>
        </AnimatePresence>
      </section>
    </main>
  );
}
