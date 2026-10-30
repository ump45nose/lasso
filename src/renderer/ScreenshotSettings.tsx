import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FolderOpen, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ScreenshotSettings as Preferences, ScreenshotActions, ScreenshotKind } from '../shared/screenshot-settings';
import { screenshotKinds } from '../shared/screenshot-settings';
import { captureModeLabels } from '../shared/capture';
import { Segmented, collapse } from './motion';
import './styles/screenshot-settings.css';
const labels = { ...captureModeLabels, scroll: '滚动截图' };
const names = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
const languageName = (code: string) => { try { return names.of(code) || code; } catch { return code; } };
function Switch({ label, value, change }: { label: string; value: boolean; change: () => void }) {
  return <button className="l-switch" role="switch" aria-label={label} aria-checked={value} onClick={change}><span /></button>;
}
export function ScreenshotSettings({ settings, shortcuts }: { settings: Preferences; shortcuts: () => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [supported, setSupported] = useState<string[]>([]), [error, setError] = useState(''), [saved, setSaved] = useState(false), [saving, setSaving] = useState(false), [adding, setAdding] = useState(false);
  const [height, setHeight] = useState(String(settings.scrollMaxHeight));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || height !== String(settings.scrollMaxHeight);
  useEffect(() => { void window.desktop.ocrLanguages().then(setSupported).catch(e => setError(String(e))); }, []);
  // Presets can change through the custom-capture panel while other settings are drafted.
  useEffect(() => { setDraft(current => ({ ...current, regionPresets: structuredClone(settings.regionPresets) })); }, [settings.regionPresets]);
  const patch = (next: Partial<Preferences>) => { setDraft(value => ({ ...value, ...next })); setError(''); setSaved(false); };
  function action(kind: ScreenshotKind, key: keyof ScreenshotActions) {
    setError(''); setSaved(false);
    setDraft(current => {
      const next = { ...current.actions[kind], [key]: !current.actions[kind][key] };
      return next.show || next.copy || next.save ? { ...current, actions: { ...current.actions, [kind]: next } } : current;
    });
  }
  function move(index: number, direction: number) {
    const languages = [...draft.languages]; [languages[index], languages[index + direction]] = [languages[index + direction], languages[index]]; patch({ languages });
  }
  async function save() {
    if (!/^\d+$/.test(height) || !Number.isSafeInteger(Number(height)) || Number(height) < 1) { setError('最大高度请输入正整数'); return; }
    setSaving(true);
    try { const next = { ...draft, scrollMaxHeight: Number(height) }; const result = await window.desktop.saveScreenshot(next); setError(result.error || ''); if (!result.error) { setDraft(next); setHeight(String(next.scrollMaxHeight)); setSaved(true); } }
    catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  return <>
    <div className="l-set-body l-shot-settings">
      <div className="l-set-row-head"><h3>截图完成后</h3><button className="l-text-btn" onClick={shortcuts}>配置快捷键</button></div>
      <ul className="l-group">{screenshotKinds.map(kind => <li key={kind} className="l-shot-policy"><span>{labels[kind]}</span><div className="l-shot-actions">{([['show', '显示'], ['copy', '复制'], ['save', '保存']] as const).map(([key, label]) => <label key={key}><span>{label}</span><Switch label={`${labels[kind]}后${label}`} value={draft.actions[kind][key]} change={() => action(kind, key)} /></label>)}</div></li>)}</ul>
      <p className="l-field-help">复制和保存输出截图完成时的图片。后续标注通过编辑器手动输出。</p>
      <div className="l-set-row-head l-gap"><h3>保存</h3></div>
      <ul className="l-group">
        <li className="col"><div className="l-field"><label htmlFor="screenshot-directory">截图文件夹</label><div className="l-row"><input id="screenshot-directory" className="l-input mono" value={draft.directory} onChange={e => patch({ directory: e.target.value })} /><button className="l-btn" aria-label="选择截图文件夹" onClick={() => void window.desktop.choosePath('directory').then(result => { if (result) patch({ directory: result.path }); }).catch(e => setError(String(e)))}><FolderOpen size={16} />选择</button></div></div></li>
        <li><span>默认格式</span><Segmented label="截图保存格式" value={draft.format} onChange={format => patch({ format })} options={ [['png', 'PNG'], ['jpeg', 'JPEG']] } /></li>
        {draft.format === 'jpeg' && <li><p className="l-field-help">透明区域以{draft.background === 'solid' ? '所选背景色' : '白色'}填充。</p></li>}
        <li><div className="l-row-label"><span>保存时缩小至 1×</span><span>仅缩小保存文件，编辑、复制和贴图保留原始像素。</span></div><Switch label="保存时缩小至 1×" value={draft.resizeTo1x} change={() => patch({ resizeTo1x: !draft.resizeTo1x })} /></li>
      </ul>
      <div className="l-set-row-head l-gap"><h3>区域记忆</h3></div><ul className="l-group"><li><div className="l-row-label"><span>重启后记住上次区域</span></div><Switch label="重启后记住上次区域" value={draft.rememberRegionAcrossLaunches} change={() => patch({ rememberRegionAcrossLaunches: !draft.rememberRegionAcrossLaunches })} /></li></ul>
      <div className="l-set-row-head l-gap"><h3>窗口外观</h3><span>窗口截图与前台窗口截图</span></div>
      <ul className="l-group">
        <li><span>背景</span><Segmented label="窗口截图背景" value={draft.background} onChange={background => patch({ background })} options={ [['transparent', '透明'], ['solid', '纯色']] } /></li>
        <AnimatePresence initial={false}>{draft.background === 'solid' && <motion.li key="color" {...collapse}><label htmlFor="screenshot-color">背景颜色</label><div className="l-row"><span className="l-shot-swatch" style={{ backgroundColor: /^#[\da-f]{6}$/i.test(draft.backgroundColor) ? draft.backgroundColor : undefined }} />{/* ui-check-ignore: configured background is exported image content */}<input id="screenshot-color" className="l-input mono l-shot-color" aria-label="窗口背景颜色" value={draft.backgroundColor} maxLength={7} onChange={e => patch({ backgroundColor: e.target.value })} /></div></motion.li>}</AnimatePresence>
        <li><span>保留窗口阴影</span><Switch label="保留窗口阴影" value={draft.shadow} change={() => patch({ shadow: !draft.shadow })} /></li>
      </ul>
      <div className="l-set-row-head l-gap"><h3>滚动截图</h3></div>
      <ul className="l-group"><li><div className="l-row-label"><label htmlFor="screenshot-height">最大输出高度</label><span>原始像素；同时受 2000 万总像素限制。</span></div><div className="l-row"><input id="screenshot-height" className="l-input mono l-shot-height" inputMode="numeric" value={height} onChange={e => { setHeight(e.target.value); setSaved(false); }} /><span>px</span></div></li></ul>
      <div className="l-set-row-head l-gap"><h3>文字识别</h3><span>按顺序优先识别</span></div>
      <ul className="l-group">{draft.languages.map((language, index) => <li key={language}><div className="l-row-label"><span>{languageName(language)}</span>{supported.length > 0 && !supported.includes(language) && <span className="l-danger">本机不支持，请移除</span>}</div><button className="l-icon" aria-label={`提高 ${languageName(language)} 优先级`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button><button className="l-icon" aria-label={`降低 ${languageName(language)} 优先级`} disabled={index === draft.languages.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button><button className="l-icon" aria-label={`移除 ${languageName(language)}`} disabled={draft.languages.length === 1} onClick={() => patch({ languages: draft.languages.filter(value => value !== language) })}><X size={15} /></button></li>)}</ul>
      <button className="l-btn small" aria-expanded={adding} disabled={!supported.length} onClick={() => setAdding(!adding)}>添加语言</button>
      <AnimatePresence>{adding && <motion.div className="l-shot-languages" {...collapse}>{supported.filter(language => !draft.languages.includes(language)).map(language => <button className="l-btn small" key={language} onClick={() => { patch({ languages: [...draft.languages, language] }); setAdding(false); }}>{languageName(language)}</button>)}</motion.div>}</AnimatePresence>
    </div>
    {(dirty || saved || error) && <div className="l-save-bar" role="status">{error ? <span className="l-danger">{error}</span> : saved && !dirty ? <span className="l-ok"><Check size={14} />已保存</span> : '有未保存的更改'}<span className="push" />{dirty && <><button className="l-btn small" disabled={saving} onClick={() => { setDraft(structuredClone(settings)); setHeight(String(settings.scrollMaxHeight)); setError(''); setSaved(false); }}>放弃</button><button className="l-btn small primary" disabled={saving || !supported.length} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></>}</div>}
  </>;
}
