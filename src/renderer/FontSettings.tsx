import { useEffect, useMemo, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { defaultFonts, type FontRole, type Settings } from '../shared/contracts';
import { builtinFonts, fontStack, loadImported } from './fonts';

const roles: { id: FontRole; name: string; use: string; sample: string }[] = [
  { id: 'display', name: '标题', use: '启动台、设置与看板标题', sample: '随手问一句，再回到手上的事。' },
  { id: 'text', name: '长文与译文', use: 'AI 回答正文、划词快答与翻译输出', sample: '点击窗外时对话小窗会收起，网页登录状态与对话进度继续保留。' },
  { id: 'ui', name: '界面文字', use: '按钮、菜单、列表、说明文字', sample: '直接发送 · 已自动保存 · 复制译文' },
  { id: 'mono', name: '代码与数据', use: '路径、尺寸、计时、延迟、快捷键', sample: '1280 × 720 · 142ms · ⌘⇧Space' }
];

const candidates = [
  'Anthropic Serif Text',
  'Anthropic Serif',
  'Anthropic Sans',
  'JetBrains Mono',
  'New York',
  'Songti SC',
  'Iowan Old Style',
  'Palatino',
  'Georgia',
  'PingFang SC',
  'Helvetica Neue',
  'SF Mono',
  'Menlo'
];

const canvas = document.createElement('canvas').getContext('2d')!;
const width = (font: string) => {
  canvas.font = font;
  return canvas.measureText('永和九年 Lasso 0123 abcdefghijkl').width;
};
const installed = (family: string) => ['monospace', 'serif', 'sans-serif'].some(base => width(`72px "${family}", ${base}`) !== width('72px ' + base));

declare global {
  interface Window {
    queryLocalFonts?(): Promise<{ family: string }[]>;
  }
}

export function FontSettings({ settings, notify }: { settings: Settings; notify?: (status: { ok?: boolean; error?: string }) => void }) {
  const { fonts, importedFonts } = settings;
  const [open, setOpen] = useState<FontRole | null>(null);
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const importedKey = JSON.stringify(importedFonts);

  useEffect(() => {
    void Promise.all([document.fonts.ready, loadImported(importedFonts)]).then(() => setTick(t => t + 1));
  }, [importedKey]);

  const detected = useMemo(() => candidates.filter(installed), [tick]);
  const importedNames = importedFonts.map(font => font.family);
  const sourceOf = (family: string): [string, boolean] =>
    importedNames.includes(family)
      ? ['已导入', false]
      : builtinFonts.includes(family)
        ? ['内置', false]
        : installed(family)
          ? ['本机', false]
          : ['后备字体', true];
  const options = [...new Set([...importedNames, ...detected, ...builtinFonts, ...local])].filter(
    family => !query || family.toLowerCase().includes(query.toLowerCase())
  );

  async function choose(role: FontRole, family: string) {
    const r = await window.desktop.saveFonts({ ...fonts, [role]: family });
    setError(r.error || '');
    if (r.error) notify?.({ error: r.error });
    else {
      setQuery('');
      notify?.({ ok: true });
    }
  }

  async function readLocal() {
    try {
      const list = await window.queryLocalFonts!();
      setLocal([...new Set(list.map(font => font.family))].sort());
      setMessage(`已读取 ${list.length} 个本机字体样式`);
      setError('');
    } catch (reason) {
      setError('无法读取本机字体列表：' + (reason as Error).message);
    }
  }

  async function importFile(role: FontRole) {
    const r = await window.desktop.importFont();
    if (r.error) {
      setError(r.error);
      notify?.({ error: r.error });
      return;
    }
    if (!r.font) return;
    await loadImported([r.font]);
    setTick(t => t + 1);
    await choose(role, r.font.family);
    setMessage(`已导入「${r.font.family}」`);
  }

  async function remove(file: string, family: string) {
    const r = await window.desktop.removeFont(file);
    setError(r.error || '');
    if (r.error) notify?.({ error: r.error });
    else {
      setMessage(`已移除「${family}」`);
      notify?.({ ok: true });
    }
  }

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>字体与排版</span>
          <span className="r">衬线用于标题与长文，无衬线用于控件，等宽用于数据</span>
        </div>
        <div className="l-set-card">
          {roles.map(role => {
            const family = fonts[role.id];
            const [srcLabel, warn] = sourceOf(family);
            const expanded = open === role.id;
            return (
              <div key={role.id} className="l-set-row col">
                <div className="l-row">
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">
                      <span>{role.name}</span>
                      <span className={'l-chip' + (warn ? ' danger' : '')}>{srcLabel}</span>
                    </div>
                    <div className="l-set-row-sub">{role.use}</div>
                  </div>
                  <span className="l-kbd">{family}</span>
                  <button
                    type="button"
                    className="l-btn small"
                    aria-expanded={expanded}
                    onClick={() => {
                      setOpen(expanded ? null : role.id);
                      setQuery('');
                    }}
                  >
                    {expanded ? '收起' : '更换'}
                  </button>
                </div>
                <div className="l-font-preview" style={{ fontFamily: fontStack(role.id, family) }}>
                  {role.sample}
                </div>
                {expanded && (
                  <div className="l-set-subform-box">
                    <input
                      className="l-input"
                      aria-label="搜索或输入字体名"
                      placeholder="搜索，或输入本机字体名后回车"
                      value={query}
                      autoFocus
                      spellCheck={false}
                      onChange={e => setQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing && query.trim()) void choose(role.id, query.trim());
                      }}
                    />
                    <div className="l-wrap" role="listbox" aria-label={role.name + '字体'}>
                      {options.map(option => (
                        <button
                          key={option}
                          type="button"
                          role="option"
                          aria-selected={option === family}
                          className={'l-btn small' + (option === family ? ' ton' : '')}
                          onClick={() => void choose(role.id, option)}
                          style={{ fontFamily: fontStack(role.id, option) }}
                        >
                          {option}
                        </button>
                      ))}
                      {!options.length && <p className="l-field-help">按回车直接使用「{query}」</p>}
                    </div>
                    <div className="l-row">
                      <button type="button" className="l-btn small" onClick={() => void importFile(role.id)}>
                        <Upload size={13} />
                        <span>导入字体文件…</span>
                      </button>
                      {window.queryLocalFonts && (
                        <button type="button" className="l-btn small" onClick={() => void readLocal()}>
                          读取全部本机字体
                        </button>
                      )}
                      <span className="grow" />
                      <button
                        type="button"
                        className="l-ghost small"
                        disabled={family === defaultFonts[role.id]}
                        onClick={() => void choose(role.id, defaultFonts[role.id])}
                      >
                        恢复默认
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {importedFonts.length > 0 && (
        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>已导入字体</span>
          </div>
          <div className="l-set-card">
            {importedFonts.map(font => (
              <div className="l-set-row" key={font.file}>
                <div className="l-set-row-main">
                  <div className="l-set-row-name" style={{ fontFamily: fontStack('ui', font.family) }}>
                    {font.family}
                  </div>
                  <div className="l-set-row-sub mono">{font.file}</div>
                </div>
                <button type="button" className="l-icon small danger" aria-label={'移除 ' + font.family} onClick={() => void remove(font.file, font.family)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      ) : (
        message && (
          <p className="l-field-help" role="status">
            {message}
          </p>
        )
      )}
    </>
  );
}
