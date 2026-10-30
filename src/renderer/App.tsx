import { CustomCapture } from './CustomCapture';
import { lazy, Suspense, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { DesktopAPI, PaletteEvent, ShellState } from '../shared/contracts';
import { useFonts } from './fonts';
import { TitleBar } from './TitleBar';
import { Launcher } from './Launcher';
import { DeliveryRow, NoticeRow } from './Footer';
import { Palette } from './Palette';
import type { SettingsTab } from './Settings';
const Settings = lazy(() => import('./Settings').then(m => ({ default: m.Settings })));
const AgentChat = lazy(() => import('./AgentChat').then(m => ({ default: m.AgentChat })));
import { ImageEntry } from './ImageEntry';
import { TextEntry } from './TextEntry';
import { isLocal } from './targets';
import { collapse, rise } from './motion';
declare global { interface Window { desktop: DesktopAPI } }

export default function App() {
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
  const view = state.customCaptureOpen?'custom':state.settingsOpen ? 'settings' : state.inputOpen && state.inputText ? 'text' : state.inputOpen && state.inputImage ? 'image' : state.activeTaskId && isLocal(state.activeTarget) ? 'chat'
    : state.pageError ? 'error' : state.hasPage ? 'web' : 'launcher';
  const viewKey = view === 'chat' ? 'chat-' + state.activeTaskId : view === 'text' ? 'text-' + state.inputText!.id : view === 'image' ? 'image-' + state.inputImage!.id : view;
  function paste(event: React.ClipboardEvent) {
    if (view !== 'launcher' || ![...event.clipboardData.items].some(item => item.type.startsWith('image/'))) return;
    event.preventDefault(); void window.desktop.readImage();
  }
  // Footer rows match main's layout(): the native page sits between the 44px bar and these 48px rows.
  return <div className="l-app" onPaste={paste}>
    <AnimatePresence mode="wait" initial={false}>{view==='custom'?<motion.div key="custom" className="l-view" {...rise}><CustomCapture/></motion.div>:view === 'settings' ? <motion.div key="settings" className="l-view" {...rise}><Suspense fallback={null}><Settings state={state} tab={settingsTab} setTab={setSettingsTab} /></Suspense></motion.div>
      : <motion.div key="shell" className="l-view" {...rise}>
      <TitleBar state={state} />
      <main className="l-main"><AnimatePresence mode="wait" initial={false}><motion.div key={viewKey} className="l-view" {...rise}>
        {view === 'text' ? <TextEntry input={state.inputText!} presets={state.presets} />
          : view === 'image' ? <ImageEntry key={state.inputImage!.id} image={state.inputImage!} presets={state.presets} initialPrompt={state.inputImagePrompt} />
          : view === 'chat' ? <Suspense fallback={null}><AgentChat taskId={state.activeTaskId!} /></Suspense>
          : view === 'error' ? <div className="l-empty"><CircleAlert size={22} className="l-danger" /><h2>网页还没打开。</h2><p>{state.pageError}</p><button className="l-btn primary" onClick={() => void window.desktop.act('reload')}>重新加载</button></div>
          : view === 'launcher' ? <Launcher state={state} openPermission={() => { setSettingsTab('general'); void window.desktop.act('settings'); }} />
          : <div className="l-web-slot" aria-label={`${state.hostname} 网页区域`} />}
      </motion.div></AnimatePresence></main>
      <AnimatePresence initial={false}>{state.delivery && <motion.div key="delivery" className="l-foot-wrap" {...collapse}><DeliveryRow delivery={state.delivery} /></motion.div>}</AnimatePresence>
    </motion.div>}</AnimatePresence>
    <AnimatePresence initial={false}>{(state.notice || state.captureEfficiency.phase !== 'idle') && <motion.div key="notice" className="l-foot-wrap" {...collapse}><NoticeRow message={state.notice} capture={state.captureEfficiency} /></motion.div>}</AnimatePresence>
    <AnimatePresence>{palette.scope && <Palette key={palette.scope} state={state} scope={palette.scope} backdrop={palette.backdrop} />}</AnimatePresence>
  </div>;
}
