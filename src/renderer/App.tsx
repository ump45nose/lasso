import { lazy, Suspense, useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { DesktopAPI, PaletteEvent, ShellState } from '../shared/contracts';
import { useFonts } from './fonts';
import { TitleBar } from './TitleBar';
import { Launcher } from './Launcher';
import { DeliveryRow, NoticeRow } from './Footer';
import { Palette } from './Palette';
import { collapse, rise } from './motion';

const ApiChat = lazy(() => import('./ApiChat').then(m => ({ default: m.ApiChat })));

declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}

export default function App() {
  const [state, setState] = useState<ShellState | null>(null);
  const [palette, setPalette] = useState<PaletteEvent>({ scope: null, backdrop: null });
  useFonts(state?.settings);

  useEffect(() => {
    const stops = [window.desktop.onState(setState), window.desktop.onPalette(setPalette)];
    void window.desktop.getState().then(setState);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        void window.desktop.openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stops.forEach(stop => stop());
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!state) return null;

  const view =
    state.activeTaskId && state.activeTarget === 'api'
      ? 'api'
      : state.pageError
        ? 'error'
        : state.hasPage
          ? 'web'
          : 'launcher';
  const viewKey = view === 'api' ? 'api-' + state.activeTaskId : view;

  function paste(event: React.ClipboardEvent) {
    if (view !== 'launcher' || ![...event.clipboardData.items].some(item => item.type.startsWith('image/'))) return;
    event.preventDefault();
    void window.desktop.readImage();
  }

  return (
    <div className="l-app" onPaste={paste}>
      <TitleBar state={state} />
      <main className="l-main">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={viewKey} className="l-view" {...rise}>
            {view === 'api' ? (
              <Suspense fallback={null}>
                <ApiChat taskId={state.activeTaskId!} shell={state} />
              </Suspense>
            ) : view === 'error' ? (
              <div className="l-empty">
                <CircleAlert size={22} className="l-danger" />
                <h2>网页还没打开。</h2>
                <p>{state.pageError}</p>
                <button type="button" className="l-btn primary" onClick={() => void window.desktop.act('reload')}>
                  重新加载
                </button>
              </div>
            ) : view === 'launcher' ? (
              <Launcher state={state} openPermission={() => void window.desktop.openSettings('selection')} />
            ) : (
              <div className="l-web-slot" aria-label={`${state.hostname} 网页区域`} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
      <AnimatePresence initial={false}>
        {state.delivery && (
          <motion.div key="delivery" className="l-foot-wrap" {...collapse}>
            <DeliveryRow delivery={state.delivery} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {(state.notice || state.captureEfficiency.phase !== 'idle') && (
          <motion.div key="notice" className="l-foot-wrap" {...collapse}>
            <NoticeRow message={state.notice} capture={state.captureEfficiency} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>{palette.scope && <Palette key={palette.scope} state={state} scope={palette.scope} backdrop={palette.backdrop} />}</AnimatePresence>
    </div>
  );
}
