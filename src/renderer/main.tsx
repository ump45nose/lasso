import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleAlert } from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import type { DesktopAPI, PaletteEvent, ShellState } from '../shared/contracts';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';
import { useFonts } from './fonts';
import { Screenshot } from './capture/Screenshot';
import { ActionBar } from './ActionBar';
import { TitleBar } from './TitleBar';
import { Launcher } from './Launcher';
import { DeliveryRow, NoticeRow } from './Footer';
import { Palette } from './Palette';
import { Settings, type SettingsTab } from './Settings';
import { AgentChat } from './AgentChat';
import { ImageEntry } from './ImageEntry';
import { TextEntry } from './TextEntry';
import { Pinned } from './capture/Pinned';
import { QuickImage } from './media/QuickImage';
import { isLocal } from './targets';
import { collapse, rise } from './motion';
declare global { interface Window { desktop: DesktopAPI } }

function App() {
  const [state, setState] = useState<ShellState | null>(null);
  const [palette, setPalette] = useState<PaletteEvent>({ scope: null, backdrop: null });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('presets');
  useFonts(state?.settings);
  useEffect(() => {
    const stops = [window.desktop.onState(setState), window.desktop.onPalette(setPalette)];
    void window.desktop.getState().then(setState);
    return () => stops.forEach(stop => stop());
  }, []);
  if (!state) return null;
  const view = state.settingsOpen ? 'settings' : state.inputOpen && state.inputText ? 'text' : state.inputOpen && state.inputImage ? 'image' : state.activeTaskId && isLocal(state.activeTarget) ? 'chat'
    : state.pageError ? 'error' : state.hasPage ? 'web' : 'launcher';
  const viewKey = view === 'chat' ? 'chat-' + state.activeTaskId : view === 'text' ? 'text-' + state.inputText!.id : view === 'image' ? 'image-' + state.inputImage!.id : view;
  function paste(event: React.ClipboardEvent) {
    if (view !== 'launcher' || ![...event.clipboardData.items].some(item => item.type.startsWith('image/'))) return;
    event.preventDefault(); void window.desktop.readImage();
  }
  // Footer rows match main's layout(): the native page sits between the 44px bar and these 48px rows.
  return <div className="l-app" onPaste={paste}>
    <AnimatePresence mode="wait" initial={false}>{view === 'settings' ? <motion.div key="settings" className="l-view" {...rise}><Settings state={state} tab={settingsTab} setTab={setSettingsTab} /></motion.div>
      : <motion.div key="shell" className="l-view" {...rise}>
      <TitleBar state={state} />
      <main className="l-main"><AnimatePresence mode="wait" initial={false}><motion.div key={viewKey} className="l-view" {...rise}>
        {view === 'text' ? <TextEntry input={state.inputText!} presets={state.presets} />
          : view === 'image' ? <ImageEntry image={state.inputImage!} presets={state.presets} />
          : view === 'chat' ? <AgentChat taskId={state.activeTaskId!} />
          : view === 'error' ? <div className="l-empty"><CircleAlert size={22} className="l-danger" /><h2>网页还没打开。</h2><p>{state.pageError}</p><button className="l-btn primary" onClick={() => void window.desktop.act('reload')}>重新加载</button></div>
          : view === 'launcher' ? <Launcher state={state} openPermission={() => { setSettingsTab('general'); void window.desktop.act('settings'); }} />
          : <div className="l-web-slot" aria-label={`${state.hostname} 网页区域`} />}
      </motion.div></AnimatePresence></main>
      <AnimatePresence initial={false}>{state.delivery && <motion.div key="delivery" className="l-foot-wrap" {...collapse}><DeliveryRow delivery={state.delivery} /></motion.div>}</AnimatePresence>
    </motion.div>}</AnimatePresence>
    <AnimatePresence initial={false}>{state.notice && <motion.div key="notice" className="l-foot-wrap" {...collapse}><NoticeRow message={state.notice} /></motion.div>}</AnimatePresence>
    <AnimatePresence>{palette.scope && <Palette key={palette.scope} state={state} scope={palette.scope} backdrop={palette.backdrop} />}</AnimatePresence>
  </div>;
}
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(<MotionConfig reducedMotion="user">{surface === 'quick-image' ? <QuickImage /> : surface === 'screenshot' ? <Screenshot /> : surface === 'action-bar' ? <ActionBar /> : surface === 'pin' ? <Pinned /> : <App />}</MotionConfig>);
