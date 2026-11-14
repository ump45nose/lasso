import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Check, ChevronDown, ChevronUp, Lock, LockOpen, Plus, RotateCcw, Video } from 'lucide-react';
import type { CaptureRect, EditableRegion } from '../../shared/capture';
import type { RegionPreset } from '../../shared/capture-regions';
import { drawRegion, moveRegion, resizeRegion, validPixelRegion } from '../../shared/region-geometry';

const RATIO_PRESETS: readonly [number | null, string][] = [
  [null, '自由'],
  [1, '1 : 1'],
  [4 / 3, '4 : 3'],
  [16 / 9, '16 : 9']
];

function formatRatioLabel(ratio: number | null): string {
  if (ratio === null) return '自由';
  if (Math.abs(ratio - 1) < 0.01) return '1:1';
  if (Math.abs(ratio - 4 / 3) < 0.01) return '4:3';
  if (Math.abs(ratio - 16 / 9) < 0.01) return '16:9';
  return '锁定比例';
}

export function RegionControls({
  context,
  crop,
  displayCrop,
  preview,
  ratio,
  setRatio,
  commit,
  cancelPreview,
  error,
  busy,
  tool,
  controlsHost,
  open,
  setOpen,
  regionPresets = [],
  onStartScroll,
  onStartRecording
}: {
  controlsHost: HTMLElement | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  context: EditableRegion;
  crop: CaptureRect;
  displayCrop: CaptureRect;
  preview: (r: CaptureRect | null) => void;
  ratio: number | null;
  setRatio: (n: number | null) => void;
  commit: (r: CaptureRect) => void;
  cancelPreview: () => void;
  error: (s: string) => void;
  busy: boolean;
  tool: string;
  regionPresets?: RegionPreset[];
  onStartScroll?: () => void;
  onStartRecording?: () => void;
}) {
  const closing = useRef(false);
  const focused = useRef<'w' | 'h' | null>(null);
  const currentCrop = useRef(crop);
  currentCrop.current = crop;
  const [alt, setAlt] = useState(false);
  const [w, setW] = useState(String(crop.width));
  const [h, setH] = useState(String(crop.height));
  const [savingPreset, setSavingPreset] = useState(false);
  const [name, setName] = useState('');
  const [localPresets, setLocalPresets] = useState<RegionPreset[]>(regionPresets);

  useEffect(() => {
    setLocalPresets(regionPresets);
  }, [regionPresets]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAlt(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAlt(false);
    };
    const blur = () => setAlt(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    original: CaptureRect;
    handle: string;
    current: CaptureRect;
  } | null>(null);

  const sx = context.display.bounds.width / context.sourceSize.width;
  const sy = context.display.bounds.height / context.sourceSize.height;
  const box = {
    left: displayCrop.x * sx,
    top: displayCrop.y * sy,
    width: displayCrop.width * sx,
    height: displayCrop.height * sy
  };

  useEffect(() => {
    if (focused.current !== 'w') setW(String(crop.width));
    if (focused.current !== 'h') setH(String(crop.height));
  }, [crop.width, crop.height, open]);

  const close = () => {
    closing.current = true;
    focused.current = null;
    setSavingPreset(false);
    setW(String(currentCrop.current.width));
    setH(String(currentCrop.current.height));
    setOpen(false);
  };

  const abort = () => {
    if (!gesture.current) return false;
    gesture.current = null;
    preview(null);
    cancelPreview();
    return true;
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (abort() || open)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    const contextMenu = (e: MouseEvent) => {
      if (open) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('contextmenu', contextMenu, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('contextmenu', contextMenu, true);
    };
  }, [open]);

  const apply = (width: number, height: number) => {
    if (busy) return false;
    const c = currentCrop.current;
    const clampedX = Math.max(0, Math.min(c.x, context.sourceSize.width - width));
    const clampedY = Math.max(0, Math.min(c.y, context.sourceSize.height - height));
    const r = { x: clampedX, y: clampedY, width, height };
    if (!validPixelRegion(r, context.sourceSize)) {
      error('尺寸需要为整数，至少 2 × 2 像素，并位于屏幕内');
      return false;
    }
    setW(String(width));
    setH(String(height));
    commit(r);
    error('');
    return true;
  };

  const switchRatio = (n: number | null) => {
    if (busy) return;
    if (n === null) {
      setRatio(null);
      return;
    }
    const c = currentCrop.current;
    const width = Math.min(c.width, context.sourceSize.width - c.x, (context.sourceSize.height - c.y) * n);
    const height = width / n;
    if (apply(Math.round(width), Math.round(height))) setRatio(n);
  };

  const input = (axis: 'w' | 'h') => {
    focused.current = null;
    if (closing.current) return;
    const n = Number(axis === 'w' ? w : h);
    if (n === (axis === 'w' ? currentCrop.current.width : currentCrop.current.height)) return;
    const width = axis === 'w' ? n : ratio ? Math.round(n * ratio) : Number(w);
    const height = axis === 'h' ? n : ratio ? Math.round(n / ratio) : Number(h);
    if (apply(width, height)) {
      setW(String(width));
      setH(String(height));
    }
  };

  const updateGesture = (shift: boolean) => {
    const g = gesture.current;
    if (!g) return;
    const dx = g.lastX - g.x;
    const dy = g.lastY - g.y;
    const r =
      g.handle === 'move'
        ? moveRegion(g.original, dx, dy, context.sourceSize)
        : g.handle === 'draw'
          ? drawRegion({ x: g.x, y: g.y }, { x: g.lastX, y: g.lastY }, context.sourceSize, shift ? 1 : ratio)
          : resizeRegion(g.original, g.handle, dx, dy, context.sourceSize, shift ? 1 : ratio);
    g.current = r;
    preview(r);
  };

  useEffect(() => {
    const flags = (e: KeyboardEvent) => {
      if (e.key === 'Shift') updateGesture(e.type === 'keydown');
    };
    const blur = () => abort();
    window.addEventListener('keydown', flags);
    window.addEventListener('keyup', flags);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', flags);
      window.removeEventListener('keyup', flags);
      window.removeEventListener('blur', blur);
    };
  }, [ratio]);

  async function saveCurrentPreset() {
    const presetName = name.trim() || `${crop.width}×${crop.height}`;
    const nextPreset: RegionPreset = {
      id: crypto.randomUUID(),
      name: presetName,
      width: crop.width,
      height: crop.height,
      ratio,
      delay: 0
    };
    try {
      await window.screenshot.saveRegionPreset(nextPreset);
      setLocalPresets(prev => [...prev.filter(p => p.id !== nextPreset.id), nextPreset]);
      setName('');
      setSavingPreset(false);
      close();
    } catch (e) {
      error((e as Error).message);
    }
  }

  return (
    <>
      <div
        className={'region-events' + (tool === 'crop' ? ' active' : '')}
        aria-label="调整截图选区"
        style={{ pointerEvents: tool === 'crop' || alt ? 'auto' : 'none' }}
        onPointerDown={e => {
          if (busy || e.button !== 0) return;
          const handle = (e.target as HTMLElement).dataset.regionHandle;
          const inside = e.clientX >= box.left && e.clientX <= box.left + box.width && e.clientY >= box.top && e.clientY <= box.top + box.height;
          if (!handle && tool !== 'crop' && !e.altKey) return;
          e.preventDefault();
          e.stopPropagation();
          gesture.current = {
            pointerId: e.pointerId,
            x: e.clientX / sx,
            y: e.clientY / sy,
            lastX: e.clientX / sx,
            lastY: e.clientY / sy,
            original: { ...crop },
            current: { ...crop },
            handle: handle ?? (inside ? 'move' : 'draw')
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const g = gesture.current;
          if (!g || g.pointerId !== e.pointerId) return;
          g.lastX = e.clientX / sx;
          g.lastY = e.clientY / sy;
          updateGesture(e.shiftKey);
        }}
        onPointerUp={e => {
          const g = gesture.current;
          if (!g || g.pointerId !== e.pointerId) return;
          gesture.current = null;
          preview(null);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          commit(g.current);
        }}
        onLostPointerCapture={() => {
          abort();
        }}
        onPointerCancel={abort}
        onContextMenu={e => {
          if (abort() || open) {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="region-border" style={box}>
          {['n', 's', 'e', 'w'].map(edge => (
            <i key={'edge' + edge} className={'region-edge ' + edge} data-region-handle={edge} />
          ))}
          {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => (
            <i key={handle} data-region-handle={handle} className={'editor-crop-handle ' + handle} />
          ))}
        </div>
      </div>

      {controlsHost &&
        createPortal(
          <div className="region-size ed-bar" inert={busy}>
            <span className="region-num-in mono">
              <input
                aria-label="选区宽度"
                value={w}
                onFocus={() => {
                  focused.current = 'w';
                }}
                onChange={e => setW(e.target.value)}
                onBlur={() => input('w')}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <span className="x">×</span>
              <input
                aria-label="选区高度"
                value={h}
                onFocus={() => {
                  focused.current = 'h';
                }}
                onChange={e => setH(e.target.value)}
                onBlur={() => input('h')}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </span>

            <button
              type="button"
              className="ed-tool"
              aria-label="锁定当前宽高比"
              aria-pressed={ratio !== null}
              disabled={busy}
              onClick={() => switchRatio(ratio === null ? crop.width / crop.height : null)}
            >
              {ratio === null ? <LockOpen /> : <Lock />}
            </button>

            <div className="ed-menu-anchor">
              <button
                type="button"
                className={'ed-text' + (open || ratio !== null ? ' act' : '')}
                aria-label="比例与固定尺寸预设"
                aria-expanded={open}
                onClick={() => {
                  closing.current = false;
                  setOpen(!open);
                }}
              >
                <span>{formatRatioLabel(ratio)}</span>
                {open ? <ChevronUp /> : <ChevronDown />}
              </button>

              {open && (
                <div className="ed-ink-menu region-preset-menu" role="menu">
                  <div className="ed-mh">比例</div>
                  {RATIO_PRESETS.map(([val, label]) => {
                    const selected = val === null ? ratio === null : ratio !== null && Math.abs(ratio - val) < 0.01;
                    return (
                      <button
                        key={label}
                        type="button"
                        role="menuitem"
                        className="ed-mi"
                        onClick={() => {
                          switchRatio(val);
                          close();
                        }}
                      >
                        <span>{label}</span>
                        {selected && <Check className="ed-mi-r" />}
                      </button>
                    );
                  })}

                  {localPresets.length > 0 && (
                    <>
                      <div className="ed-mh">固定尺寸</div>
                      {localPresets.map(p => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitem"
                          className="ed-mi"
                          onClick={() => {
                            if (apply(p.width, p.height)) {
                              setRatio(p.ratio);
                              close();
                            }
                          }}
                        >
                          <span className="mono">
                            {p.width} × {p.height}
                          </span>
                          <span className="ed-mi-r">{p.name}</span>
                        </button>
                      ))}
                    </>
                  )}

                  <div className="ed-msep" />
                  {savingPreset ? (
                    <div className="region-save-inline">
                      <input
                        className="ed-word"
                        aria-label="区域预设名称"
                        placeholder={`${crop.width}×${crop.height} 名称…`}
                        value={name}
                        autoFocus
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void saveCurrentPreset();
                          }
                        }}
                      />
                      <button type="button" className="ed-mi-save" onClick={() => void saveCurrentPreset()}>
                        保存
                      </button>
                    </div>
                  ) : (
                    <button type="button" role="menuitem" className="ed-mi" onClick={() => setSavingPreset(true)}>
                      <Plus />
                      <span>保存当前尺寸…</span>
                    </button>
                  )}

                  <button
                    type="button"
                    role="menuitem"
                    className="ed-mi"
                    onClick={() => {
                      setRatio(context.ratio);
                      commit(context.initialCrop);
                      close();
                    }}
                  >
                    <RotateCcw />
                    <span>恢复初始选区</span>
                  </button>
                </div>
              )}
            </div>

            {(onStartScroll || onStartRecording) && <span className="ed-sep" />}
            {onStartScroll && (
              <button type="button" className="ed-text" disabled={busy} onClick={onStartScroll}>
                <ArrowDownToLine />
                <span>长截图</span>
              </button>
            )}
            {onStartRecording && (
              <button type="button" className="ed-text" disabled={busy} onClick={onStartRecording}>
                <Video />
                <span>转录屏</span>
              </button>
            )}
          </div>,
          controlsHost
        )}
    </>
  );
}
