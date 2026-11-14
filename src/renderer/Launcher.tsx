import { ChevronRight, ClipboardPaste, FolderOpen, Scan, SquareDashed, Zap } from 'lucide-react';
import { presetTargetLabels as targetLabels, type ShellState, type Target } from '../shared/contracts';
import { Badge, targets } from './targets';

/** Empty B2 launcher: start ChatGPT / Gemini / API conversation or quick-capture. */
export function Launcher({ state, openPermission }: { state: ShellState; openPermission: () => void }) {
  const { settings, connections } = state;
  const captureBusy = state.captureEfficiency.phase !== 'idle';
  const presets = state.presets.filter(preset => preset.enabled && !preset.needsSelection);

  const apiConn =
    connections.find(c => c.id === settings.defaultApiChat.connectionId) ||
    connections[0] ||
    null;
  const apiModel = settings.defaultApiChat.model || apiConn?.models[0] || '';
  const apiSub = apiConn ? `${apiConn.name}${apiModel ? ` · ${apiModel}` : ''}` : '轻量连续追问 · 点击配置连接';

  function targetSubtitle(target: Target) {
    if (target === 'api') return <span className="mono">{apiSub}</span>;
    return '网页 · 在小窗内使用';
  }

  return (
    <>
      <div className="l-launch">
        <div className="l-launch-intro">
          <h1 className="l-hero">
            随手<mark className="l-hero-mark">问一句</mark>，
            <br />
            再回到手上的事。
          </h1>
          <p className="l-sub">选中文字时附近会出现动作条；没有选区，就从这里开始。</p>
          {state.capture.status === 'permission' && (
            <button type="button" className="l-link" onClick={openPermission}>
              开启划词 · 授予辅助功能权限
            </button>
          )}
        </div>

        <section className="l-launch-sect">
          <h2 className="l-label">开始新对话</h2>
          <div className="l-card-rows l-stagger">
            {targets.map((target, i) => (
              <button
                key={target}
                type="button"
                className="l-card-row"
                style={{ '--i': i } as React.CSSProperties}
                onClick={() => void window.desktop.newTask({ target })}
              >
                {target === 'api' ? (
                  <span className="l-target-tile">
                    <Zap size={13} />
                  </span>
                ) : (
                  <Badge target={target} />
                )}
                <span className="l-card-row-main">
                  <span className="l-card-row-title">{targetLabels[target]}</span>
                  <span className="l-card-row-sub">{targetSubtitle(target)}</span>
                </span>
                {target === settings.lastTarget && <span className="l-chip">上次使用</span>}
                <ChevronRight size={14} className="l-row-chev" />
              </button>
            ))}
          </div>
        </section>

        {presets.length > 0 && (
          <section className="l-launch-sect">
            <h2 className="l-label">常用预设 · 无需选区</h2>
            <div className="l-card-rows l-stagger">
              {presets.slice(0, 6).map((preset, i) => (
                <button
                  key={preset.id}
                  type="button"
                  className="l-card-row compact"
                  style={{ '--i': i + targets.length } as React.CSSProperties}
                  onClick={() => void window.desktop.runPreset(preset.id)}
                >
                  <span className="l-card-row-title grow">{preset.name}</span>
                  <span className="l-card-row-sub">
                    {targetLabels[preset.target]} · {preset.kind === 'image' ? '生图' : preset.mode === 'edit' ? '先编辑' : '直接发送'}
                  </span>
                  <ChevronRight size={14} className="l-row-chev" />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer className="l-toolstrip">
        <button type="button" className="l-ghost" disabled={captureBusy} onClick={() => void window.desktop.readImage()}>
          <ClipboardPaste size={14} />
          粘贴图片
          <span className="l-kbd">⌘V</span>
        </button>
        <button type="button" className="l-ghost" disabled={captureBusy} onClick={() => void window.desktop.screenshot('area')}>
          <Scan size={14} />
          区域截图
        </button>
        <button type="button" className="l-ghost" disabled={captureBusy} onClick={() => void window.desktop.screenshot('rect')}>
          <SquareDashed size={14} />
          框选截图
        </button>
        <button type="button" className="l-ghost" disabled={captureBusy} onClick={() => void window.desktop.openLocalImage()}>
          <FolderOpen size={14} />
          打开图片
        </button>
      </footer>
    </>
  );
}
