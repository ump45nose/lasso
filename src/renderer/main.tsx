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
  screenshot: () => import('./capture/Screenshot').then(m => ({ default: m.Screenshot })),
  'action-bar': () => import('./ActionBar').then(m => ({ default: m.ActionBar })),
  pin: () => import('./capture/Pinned').then(m => ({ default: m.Pinned })),
  main: () => import('./App')
};
const surface = new URLSearchParams(location.search).get('surface') || 'main';
const Surface = lazy(loaders[surface as keyof typeof loaders] || loaders.main);
createRoot(document.getElementById('root')!).render(<MotionConfig reducedMotion="user"><Suspense fallback={null}><Surface /></Suspense></MotionConfig>);
