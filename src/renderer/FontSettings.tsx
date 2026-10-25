import { useEffect, useMemo, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { defaultFonts, type FontRole, type Settings } from '../shared/contracts';
import { builtinFonts, fontStack, loadImported } from './fonts';

const roles: { id: FontRole; name: string; use: string; sample: string }[] = [
  { id: 'display', name: '标题', use: '启动台、页面标题、设置标题', sample: '随手问一句，再回到手上的事。' },
  { id: 'text', name: '回答正文', use: 'CLI 回答与长段说明', sample: '释放前会开一个隐藏页核对历史与最新回答。' },
  { id: 'ui', name: '界面文字', use: '标签、按钮、列表、提示', sample: '填入后直接发送 · 已释放，点击恢复' },
  { id: 'mono', name: '代码与数据', use: '路径、命令、尺寸、快捷键', sample: 'npm run typecheck · 1788 × 693' }
];
const candidates = ['Anthropic Serif Text', 'Anthropic Serif', 'Anthropic Sans', 'Anthropic Mono', 'New York', 'Songti SC', 'Iowan Old Style', 'Palatino', 'Georgia', 'PingFang SC', 'Helvetica Neue', 'SF Mono', 'Menlo'];
const canvas = document.createElement('canvas').getContext('2d')!;
const width = (font: string) => { canvas.font = font; return canvas.measureText('永和九年 Lasso 0123 abcdefghijkl').width; };
/** A family is present when it changes the rendered width against every generic base. */
const installed = (family: string) => ['monospace', 'serif', 'sans-serif'].some(base => width(`72px "${family}", ${base}`) !== width('72px ' + base));
declare global { interface Window { queryLocalFonts?(): Promise<{ family: string }[]> } }

export function FontSettings({ settings }: { settings: Settings }) {
  const { fonts, importedFonts } = settings;
  const [open, setOpen] = useState<FontRole | null>(null);
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const importedKey = JSON.stringify(importedFonts);
  useEffect(() => { void Promise.all([document.fonts.ready, loadImported(importedFonts)]).then(() => setTick(t => t + 1)); }, [importedKey]);
  const detected = useMemo(() => candidates.filter(installed), [tick]);
  const importedNames = importedFonts.map(font => font.family);
  const sourceOf = (family: string): [string, string] => importedNames.includes(family) ? ['已导入', ''] : builtinFonts.includes(family) ? ['内置', ''] : installed(family) ? ['本机', ''] : ['未找到 · 正在用后备字体', 'warn'];
  const options = [...new Set([...importedNames, ...detected, ...builtinFonts, ...local])].filter(family => !query || family.toLowerCase().includes(query.toLowerCase()));
  async function choose(role: FontRole, family: string) {
    const r = await window.desktop.saveFonts({ ...fonts, [role]: family });
    setError(r.error || ''); if (!r.error) setQuery('');
  }
  async function readLocal() {
    try {
      const list = await window.queryLocalFonts!();
      setLocal([...new Set(list.map(font => font.family))].sort());
      setMessage(`已读取 ${list.length} 个本机字体样式。`); setError('');
    } catch (error) { setError('无法读取本机字体列表：' + (error as Error).message + '。可以直接输入字体名后回车。'); }
  }
  async function importFile(role: FontRole) {
    const r = await window.desktop.importFont();
    if (r.error) { setError(r.error); return; }
    if (!r.font) return;
    await loadImported([r.font]); setTick(t => t + 1);
    await choose(role, r.font.family);
    setMessage(`已导入「${r.font.family}」。`);
  }
  async function remove(file: string, family: string) {
    const r = await window.desktop.removeFont(file);
    setError(r.error || ''); if (!r.error) setMessage(`已移除「${family}」。使用它的角色会改用后备字体，可重新选择。`);
  }
  return <div className="l-set-body">
    <div className="l-set-row-head"><h3>字体</h3><span>默认全部使用衬线体</span></div>
    <ul className="l-group">
      {roles.map(role => {
        const family = fonts[role.id], [label, tone] = sourceOf(family), expanded = open === role.id;
        return <li className="col" key={role.id}>
          <div className="l-row">
            <div className="l-row-label"><span>{role.name}</span><span>{role.use}</span></div>
            <span className={'l-font-src ' + tone}>{label}</span>
            <button className="l-btn small" aria-expanded={expanded} onClick={() => { setOpen(expanded ? null : role.id); setQuery(''); }}>{expanded ? '收起' : '更换'}</button>
          </div>
          <div className="l-font-preview" style={{ fontFamily: fontStack(role.id, family) }}>{role.sample}</div>
          <div className="l-kbd">{family}</div>
          {expanded && <div className="l-picker">
            <input className="l-input" aria-label="搜索或输入字体名" placeholder="搜索，或输入本机字体名后回车" value={query} autoFocus spellCheck={false}
              onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && query.trim()) void choose(role.id, query.trim()); }} />
            <div className="l-picker-list" role="listbox" aria-label={role.name + '字体'}>
              {options.map(option => <button key={option} role="option" aria-selected={option === family} onClick={() => void choose(role.id, option)} style={{ fontFamily: fontStack(role.id, option) }}>
                {option}<small>{importedNames.includes(option) ? '已导入' : builtinFonts.includes(option) ? '内置' : '本机'}</small></button>)}
              {!options.length && <p className="l-field-help l-picker-empty">没有匹配的字体。按回车直接使用「{query}」。</p>}
            </div>
            <div className="l-row l-wrap">
              <button className="l-btn small" onClick={() => void importFile(role.id)}><Upload size={14} />导入字体文件…</button>
              {window.queryLocalFonts && <button className="l-btn small" onClick={() => void readLocal()}>读取全部本机字体</button>}
              <button className="l-btn small" disabled={family === defaultFonts[role.id]} onClick={() => void choose(role.id, defaultFonts[role.id])}>恢复默认</button>
            </div>
          </div>}
        </li>;
      })}
    </ul>
    {importedFonts.length > 0 && <>
      <div className="l-set-row-head l-gap"><h3>已导入的字体</h3></div>
      <ul className="l-group">{importedFonts.map(font => <li key={font.file}>
        <div className="l-row-label"><span style={{ fontFamily: fontStack('ui', font.family) }}>{font.family}</span><span className="mono">{font.file}</span></div>
        <button className="l-icon" aria-label={'移除 ' + font.family} title="移除" onClick={() => void remove(font.file, font.family)}><Trash2 size={14} /></button>
      </li>)}</ul>
    </>}
    {error ? <p className="l-field-help error" role="alert">{error}</p> : message && <p className="l-field-help" role="status">{message}</p>}
    <p className="l-field-help">只影响 Lasso 自己的界面，网页内容由网站控制。导入的字体复制到应用数据目录。</p>
  </div>;
}
