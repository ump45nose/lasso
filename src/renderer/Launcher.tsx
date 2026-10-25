import { ChevronRight, Image, ScanLine } from 'lucide-react';
import { targetLabels } from '../shared/contracts';
import type { ShellState } from '../shared/contracts';
import { Badge, folderName, isLocal, shortcutLabel, targets } from './targets';

/** Empty window: start a task without a selection. Paste is handled by the shell. */
export function Launcher({ state, openPermission }: { state: ShellState; openPermission: () => void }) {
  const { settings } = state;
  const presets = state.presets.filter(preset => preset.enabled && !preset.needsSelection);
  return <>
    <div className="l-launch">
      <div className="l-launch-intro">
        <h1 className="l-hero">随手<span className="l-hero-loop"><svg viewBox="0 0 220 80" preserveAspectRatio="none" aria-hidden="true"><path d="M30 44 C28 18 110 6 180 16 C214 22 216 56 170 66 C110 78 36 72 22 50 C14 36 40 22 70 20" /></svg><span>问一句</span></span>，<br />再回到手上的事。</h1>
        <p className="l-sub">在任意应用里选中文字，附近会出现动作条。没有选区，就从这里开始。</p>
        {state.capture.status === 'permission' && <button className="l-link" onClick={openPermission}>开启划词 · 授予辅助功能权限</button>}
      </div>
      <section>
        <h2 className="l-label">新任务</h2>
        <div className="l-targets l-stagger">
          {targets.map((target, i) => <button key={target} className="l-target" style={{ '--i': i } as React.CSSProperties} onClick={() => void window.desktop.newTask({ target })}>
            <span className="l-target-name"><Badge target={target} />{targetLabels[target]}{target === settings.lastTarget && <em>上次使用</em>}</span>
            <small>{isLocal(target) ? <>本地 CLI · <span className="mono">{folderName(settings.local[target].cwd) || '~'}</span></> : '网页 · 在小窗内登录'}</small>
          </button>)}
        </div>
      </section>
      {presets.length > 0 && <section>
        <h2 className="l-label">不需要选区的预设</h2>
        <div className="l-list l-stagger">
          {presets.map((preset, i) => <button key={preset.id} className="l-list-row" style={{ '--i': i + targets.length } as React.CSSProperties} onClick={() => void window.desktop.runPreset(preset.id)}>
            {preset.name}<small>{targetLabels[preset.target]} · {preset.mode === 'edit' ? '先编辑' : '直接发送'}</small><ChevronRight size={14} className="l-row-chev" /></button>)}
        </div>
      </section>}
    </div>
    <footer className="l-launch-foot">
      <button className="l-ghost dashed" onClick={() => void window.desktop.readImage()}><Image size={14} />粘贴图片<span className="l-kbd">⌘V</span></button>
      <button className="l-ghost" onClick={() => void window.desktop.screenshot('area')}><ScanLine size={14} />截图</button>
      <span className="l-hint">{settings.shortcut ? <>随时按 <span className="l-kbd">{shortcutLabel(settings.shortcut)}</span> 唤起</> : '从菜单栏随时打开'}</span>
    </footer>
  </>;
}
