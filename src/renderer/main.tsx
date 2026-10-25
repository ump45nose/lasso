import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleAlert } from 'lucide-react';
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
import { isLocal } from './targets';
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
  const view = state.settingsOpen ? 'settings' : state.inputImage && state.imageOpen ? 'image' : state.activeTaskId && isLocal(state.activeTarget) ? 'chat'
    : state.pageError ? 'error' : state.hasPage ? 'web' : 'launcher';
  function paste(event: React.ClipboardEvent) {
    if (view !== 'launcher' || ![...event.clipboardData.items].some(item => item.type.startsWith('image/'))) return;
    event.preventDefault(); void window.desktop.readImage();
  }
  // Footer rows match main's layout(): the native page sits between the 44px bar and these 48px rows.
  return <div className="l-app" onPaste={paste}>
    {view === 'settings' ? <Settings state={state} tab={settingsTab} setTab={setSettingsTab} /> : <>
      <TitleBar state={state} />
      <main className="l-main">
        {view === 'image' ? <ImageEntry image={state.inputImage!} presets={state.presets} />
          : view === 'chat' ? <AgentChat key={state.activeTaskId} taskId={state.activeTaskId!} />
          : view === 'error' ? <div className="l-empty l-surface-enter"><CircleAlert size={22} className="l-danger" /><h2>网页还没打开。</h2><p>{state.pageError}</p><button className="l-btn primary" onClick={() => void window.desktop.act('reload')}>重新加载</button></div>
          : view === 'launcher' ? <Launcher state={state} openPermission={() => { setSettingsTab('general'); void window.desktop.act('settings'); }} />
          : <div className="l-web-slot" aria-label={`${state.hostname} 网页区域`} />}
      </main>
      {state.delivery && <DeliveryRow delivery={state.delivery} />}
    </>}
    {state.notice && <NoticeRow message={state.notice} />}
    {palette.scope && <Palette key={palette.scope} state={state} scope={palette.scope} backdrop={palette.backdrop} />}
  </div>;
}
const surface = new URLSearchParams(location.search).get('surface');
createRoot(document.getElementById('root')!).render(surface === 'screenshot' ? <Screenshot /> : surface === 'action-bar' ? <ActionBar /> : <App />);
