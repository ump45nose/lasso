import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';

// A helper surface never imports the settings, chat, media or annotation modules.
const loaders = {
  'quick-image': () => import('./media/QuickImage').then(m => ({ default: m.QuickImage })),
  recording: () => import('./RecordingPanel').then(m => ({ default: m.RecordingPanel })),
  screenshot: () => import('./capture/Screenshot').then(m => ({ default: m.Screenshot })),
  'action-bar': () => import('./ActionBar').then(m => ({ default: m.ActionBar })),
  island: () => import('./island/NotchIsland').then(m => ({ default: m.NotchIsland })),
  'edge-notes': () => import('./island/EdgeNotes').then(m => ({ default: m.EdgeNotes })),
  'finder-panel': () => import('./island/FinderPanel').then(m => ({ default: m.FinderPanel })),
  translate: () => import('./island/TranslatorWindow').then(m => ({ default: m.TranslatorWindow })),
  clipboard: () => import('./island/ClipboardWindow').then(m => ({ default: m.ClipboardWindow })),
  pin: () => import('./capture/Pinned').then(m => ({ default: m.Pinned })),
  'pin-toolbar': () => import('./capture/Pinned').then(m => ({ default: m.PinToolbar })),
  main: () => import('./App')
};
const surface = new URLSearchParams(location.search).get('surface') || 'main';
const Surface = lazy(loaders[surface as keyof typeof loaders] || loaders.main);
createRoot(document.getElementById('root')!).render(<MotionConfig reducedMotion="user"><Suspense fallback={null}><Surface /></Suspense></MotionConfig>);
