import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FolderOpen, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ScreenshotSettings as Preferences, ScreenshotActions, ScreenshotKind } from '../shared/screenshot-settings';
import { screenshotKinds, screenshotOutputFormats, validateScreenshotSettings } from '../shared/screenshot-settings';
import { captureModeLabels } from '../shared/capture';
import { validateVisionConfig, type VisionServiceConfig } from '../shared/intelligence';
import { Segmented, SubNav, SubPane, collapse, useSubNav } from './motion';
import type { RecordingSettings } from '../shared/recording';
import { CaptureHistory, PinWorkspace } from './CaptureWorkspaceSettings';
import './styles/screenshot-settings.css';
const labels = { ...captureModeLabels, scroll: '滚动截图' };
const subTabs = [
  ['capture', '采集与输出'],
  ['history', '历史记录'],
  ['pins', '贴图空间'],
  ['vision', '智能服务'],
  ['recording', '屏幕录制']
] as const;
const names = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
const languageName = (code: string) => { try { return names.of(code) || code; } catch { return code; } };
function Switch({ label, value, change }: { label: string; value: boolean; change: () => void }) {
  return <button className="l-switch" role="switch" aria-label={label} aria-checked={value} onClick={change}><span /></button>;
}
function VisionSettings() {
  const [saved, setSaved] = useState<VisionServiceConfig | null>(null), [draft, setDraft] = useState<VisionServiceConfig | null>(null);
  const [credential, setCredential] = useState(''), [clear, setClear] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { let active = true; void window.desktop.visionConfig().then(config => { if (active) { setSaved(config); setDraft(config); } }, reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || !!credential || clear;
  const patch = (input: Partial<VisionServiceConfig>) => { setDraft(value => value && ({ ...value, ...input })); setError(''); setMessage(''); };
  async function save() {
    if (!draft) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const { hasCredential: _hasCredential, ...config } = draft;
      const input = { ...config, ...(!config.useMediaCredential && (clear || credential) ? { credential: clear ? '' : credential } : {}) };
      validateVisionConfig(input); const result = await window.desktop.saveVisionConfig(input);
      setSaved(result); setDraft(result); setCredential(''); setClear(false); setMessage('智能识别与翻译设置已保存');
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  return <section id="screenshot-vision" className="l-set-section l-gap">
    <div className="l-set-row-head"><h3>智能识别与翻译</h3></div>
    {draft && <><ul className="l-group">
      <li><div className="l-row-label"><span>复用生图 API 凭据</span><span>地址留空时也使用生图服务地址，模型在此单独指定。</span></div><Switch label="复用生图 API 凭据" value={draft.useMediaCredential} change={() => patch({ useMediaCredential: !draft.useMediaCredential })} /></li>
      <li className="col"><div className="l-field"><label htmlFor="vision-base-url">服务地址</label><input id="vision-base-url" className="l-input mono" value={draft.baseURL} placeholder={draft.useMediaCredential ? '留空复用生图服务地址' : 'https://…/v1'} onChange={event => patch({ baseURL: event.target.value })} /></div></li>
      <li className="col"><div className="l-field"><label htmlFor="vision-model">模型名称</label><input id="vision-model" className="l-input mono" value={draft.model} placeholder="支持图像理解的模型" onChange={event => patch({ model: event.target.value })} /></div></li>
      <li className="l-shot-option"><span>默认翻译语言</span><Segmented label="默认翻译语言" value={draft.targetLanguage} onChange={targetLanguage => patch({ targetLanguage })} options={[['简体中文', '中文'], ['English', '英文'], ['日本語', '日文'], ['한국어', '韩文'], ...(!['简体中文', 'English', '日本語', '한국어'].includes(draft.targetLanguage) ? [[draft.targetLanguage, draft.targetLanguage] as const] : [])]} /></li>
      {!draft.useMediaCredential && <li className="col"><div className="l-field"><label htmlFor="vision-api-key">独立 API Key</label><input id="vision-api-key" type="password" autoComplete="off" className="l-input mono" value={credential} placeholder={!saved?.useMediaCredential && saved?.hasCredential ? '已安全保存，留空保留' : '输入独立 API Key'} onChange={event => { setCredential(event.target.value); setClear(false); setMessage(''); setError(''); }} />{!saved?.useMediaCredential && saved?.hasCredential && <button className="l-text-btn" aria-pressed={clear} onClick={() => { setClear(!clear); setCredential(''); setMessage(''); }}>{clear ? '保存时清除独立凭据 · 撤销' : '清除已存独立凭据'}</button>}</div></li>}
    </ul><div className="l-vision-actions"><span className="l-field-help">{draft.useMediaCredential !== saved?.useMediaCredential ? '保存后切换凭据来源' : saved?.hasCredential ? '凭据已安全保存' : '尚未保存可用凭据'}</span><span className="push" /><button className="l-btn small" disabled={!dirty || busy} onClick={() => { setDraft(saved); setCredential(''); setClear(false); setError(''); setMessage(''); }}>放弃更改</button><button className="l-btn small primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? '保存中…' : '保存智能服务'}</button></div></>}
    {error && <p className="l-field-help l-danger" role="alert">{error}</p>}{message && <p className="l-field-help l-ok" role="status"><Check size={14} />{message}</p>}
  </section>;
}
export function ScreenshotSettings({ settings, shortcuts }: { settings: Preferences; shortcuts: () => void }) {
  const [sub, setSub, bodyRef] = useSubNav<(typeof subTabs)[number][0]>('capture');
  const [pinRevision, setPinRevision] = useState(0);
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [supported, setSupported] = useState<string[]>([]), [error, setError] = useState(''), [saved, setSaved] = useState(false), [saving, setSaving] = useState(false), [adding, setAdding] = useState(false);
  const [height, setHeight] = useState(String(settings.scrollMaxHeight));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || height !== String(settings.scrollMaxHeight);
  useEffect(() => { void window.desktop.ocrLanguages().then(setSupported).catch(e => setError(String(e))); }, []);
  // Presets can change through the custom-capture panel while other settings are drafted.
  useEffect(() => { setDraft(current => ({ ...current, regionPresets: structuredClone(settings.regionPresets) })); }, [settings.regionPresets]);
  // Workspace controls save independently; an output save must retain the latest groups.
  useEffect(() => { setDraft(current => ({ ...current, pinWorkspace: structuredClone(settings.pinWorkspace) })); }, [settings.pinWorkspace]);
  // Editor style updates must survive saving an unrelated output preference.
  useEffect(() => { setDraft(current => ({ ...current, annotationMemory: { ...structuredClone(settings.annotationMemory), rememberToolStyles: current.annotationMemory.rememberToolStyles } })); }, [settings.annotationMemory]);
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
    if (!draft.directory.startsWith('/') || !draft.quickSaveDirectory.startsWith('/')) { setError('截图文件夹和快速保存目录需使用绝对路径'); return; }
    setSaving(true);
    try { const next = { ...draft, scrollMaxHeight: Number(height) }; validateScreenshotSettings(next, supported); const result = await window.desktop.saveScreenshot(next); setError(result.error || ''); if (!result.error) { setDraft(next); setHeight(String(next.scrollMaxHeight)); setSaved(true); } }
    catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  return <>
    <SubNav label="截图设置二级分类" value={sub} options={subTabs} onChange={setSub} />
    <div ref={bodyRef} className="l-set-body l-shot-settings">
      <SubPane id="capture" active={sub === 'capture'}>
        <section id="screenshot-advanced" className="l-set-section">
          <div className="l-set-row-head"><h3>高级采集</h3><span>保存后用于下一次截图</span></div>
          <ul className="l-group">
            <li className="l-shot-option"><span>选区形状</span><Segmented label="选区形状" value={draft.selectionShape} onChange={selectionShape => patch({ selectionShape })} options={ [['rect', '矩形'], ['freehand', '自由套索'], ['polygon', '多边形'], ['multi-rect', '多区域']] } /></li>
            {([['includeCursor', '截图包含鼠标指针'], ['showCrosshair', '显示十字辅助线'], ['showLoupeGrid', '显示放大镜像素网格']] as const).map(([key, label]) => <li key={key}><span>{label}</span><Switch label={label} value={draft[key]} change={() => patch({ [key]: !draft[key] })} /></li>)}
            <li className="l-shot-option"><span>放大镜倍率</span><Segmented label="放大镜倍率" value={String(draft.loupeMagnification)} onChange={value => patch({ loupeMagnification: Number(value) as Preferences['loupeMagnification'] })} options={ [['4', '4×'], ['8', '8×'], ['12', '12×']] } /></li>
            <li className="l-shot-option"><span>取色色值格式</span><Segmented label="取色色值格式" value={draft.loupeColorFormat} onChange={loupeColorFormat => patch({ loupeColorFormat })} options={ [['hex', 'HEX'], ['rgb', 'RGB'], ['hsl', 'HSL']] } /></li>
          </ul>
          <div className="l-set-row-head l-gap"><h3>输出装饰与水印</h3></div>
          <ul className="l-group">
            {([['cornerRadius', '输出圆角半径', 64], ['borderWidth', '输出边框宽度', 16]] as const).map(([key, label, max]) => <li key={key}><label className="l-row-label" htmlFor={'screenshot-' + key}>{label}</label><div className="l-row"><input id={'screenshot-' + key} className="l-input mono l-shot-height" type="number" min="0" max={max} step="1" value={draft[key]} onChange={e => patch({ [key]: Number(e.target.value) })} /><span>px</span></div></li>)}
            <li><label className="l-row-label" htmlFor="screenshot-border-color">输出边框颜色</label><input id="screenshot-border-color" className="l-input mono l-shot-color" value={draft.borderColor} maxLength={7} onChange={e => patch({ borderColor: e.target.value })} /></li>
            <li className="col"><div className="l-field"><label htmlFor="screenshot-watermark">水印文字</label><input id="screenshot-watermark" className="l-input" maxLength={500} value={draft.watermarkText} onChange={e => patch({ watermarkText: e.target.value })} /><p className="l-field-help">在编辑器中点击「水印」，为当前图片添加平铺水印。</p></div></li>
            <li className="col"><div className="l-field"><label htmlFor="screenshot-watermark-opacity">水印透明度</label><div className="l-row"><input id="screenshot-watermark-opacity" className="l-shot-quality" type="range" min="0" max="1" step="0.01" value={draft.watermarkOpacity} onChange={e => patch({ watermarkOpacity: Number(e.target.value) })} /><output htmlFor="screenshot-watermark-opacity" className="mono">{Math.round(draft.watermarkOpacity * 100)}%</output></div></div></li>
          </ul>
        </section>
        <div className="l-set-row-head l-gap"><h3>截图完成后</h3><button className="l-text-btn" onClick={shortcuts}>配置快捷键</button></div>
        <ul className="l-group">{screenshotKinds.map(kind => <li key={kind} className="l-shot-policy"><span>{labels[kind]}</span><div className="l-shot-actions">{([['show', '显示'], ['copy', '复制'], ['save', '保存']] as const).map(([key, label]) => <label key={key}><span>{label}</span><Switch label={`${labels[kind]}后${label}`} value={draft.actions[kind][key]} change={() => action(kind, key)} /></label>)}</div></li>)}</ul>
        <p className="l-field-help">复制和保存输出截图完成时的图片。后续标注通过编辑器手动输出。</p>
        <div className="l-set-row-head l-gap"><h3>贴图</h3></div>
        <ul className="l-group"><li><div className="l-row-label"><span>保持原尺寸</span><span>按截图在屏幕上的大小显示，不拖边改变大小。关闭后缩进窗口，并可拖动边缘调整。</span></div><Switch label="贴图保持原尺寸" value={draft.pinKeepsSize} change={() => patch({ pinKeepsSize: !draft.pinKeepsSize })} /></li></ul>
        <div id="screenshot-editing" className="l-set-row-head l-gap"><h3>编辑</h3></div>
        <ul className="l-group"><li><div className="l-row-label"><span>记住标注工具样式</span><span>下次编辑恢复所用工具及各工具的颜色、粗细、字号与强度。</span></div><Switch label="记住标注工具样式" value={draft.annotationMemory.rememberToolStyles} change={() => patch({ annotationMemory: { ...draft.annotationMemory, rememberToolStyles: !draft.annotationMemory.rememberToolStyles } })} /></li></ul>
        <div id="screenshot-output" className="l-set-row-head l-gap"><h3>保存与输出</h3></div>
        <ul className="l-group">
          <li className="col"><div className="l-field"><label htmlFor="screenshot-directory">截图文件夹</label><div className="l-row"><input id="screenshot-directory" className="l-input mono" value={draft.directory} onChange={e => patch({ directory: e.target.value })} /><button className="l-btn" aria-label="选择截图文件夹" onClick={() => void window.desktop.choosePath('directory').then(result => { if (result) patch({ directory: result.path }); }).catch(e => setError(String(e)))}><FolderOpen size={16} />选择</button></div></div></li>
          <li className="l-shot-option"><span>默认格式</span><Segmented label="截图保存格式" value={draft.format} onChange={format => patch({ format })} options={screenshotOutputFormats.map(format => [format, format.toUpperCase()] as const)} /></li>
          <li className="col"><div className="l-field"><label htmlFor="screenshot-quality">JPEG 质量</label><div className="l-row"><input id="screenshot-quality" className="l-shot-quality" type="range" min="10" max="100" step="1" value={draft.jpegQuality} onChange={e => patch({ jpegQuality: Number(e.target.value) })} /><output htmlFor="screenshot-quality" className="mono">{draft.jpegQuality}%</output></div><p className="l-field-help">只影响 JPEG 输出。JPEG、BMP 的透明区域以{draft.background === 'solid' ? '所选背景色' : '白色'}填充。</p></div></li>
          <li className="col"><div className="l-field"><label htmlFor="screenshot-quick-directory">快速保存目录</label><div className="l-row"><input id="screenshot-quick-directory" className="l-input mono" value={draft.quickSaveDirectory} onChange={e => patch({ quickSaveDirectory: e.target.value })} /><button className="l-btn" aria-label="选择快速保存目录" onClick={() => void window.desktop.choosePath('directory').then(result => { if (result) patch({ quickSaveDirectory: result.path }); }).catch(e => setError(String(e)))}><FolderOpen size={16} />选择</button></div><p className="l-field-help">快速保存直接写入此目录，无需再次选择位置。</p></div></li>
          <li className="col"><div className="l-field"><label htmlFor="screenshot-template">文件命名模板</label><input id="screenshot-template" className="l-input mono" spellCheck={false} value={draft.fileNameTemplate} onChange={e => patch({ fileNameTemplate: e.target.value })} aria-describedby="screenshot-template-help" /><p id="screenshot-template-help" className="l-field-help l-shot-template-help">{'日期时间：{YYYY} {MM} {DD} {HH} {mm} {ss}；应用：{app}；像素：{width} {height}；序号：{seq}。可用 / 创建子文件夹，不用填写扩展名。'}</p></div></li>
          <li className="l-shot-option"><span>默认复制方式</span><Segmented label="默认复制方式" value={draft.copyMode} onChange={copyMode => patch({ copyMode })} options={ [['image', '图片'], ['file', '文件'], ['path', '路径']] } /></li>
          <li className="l-shot-option"><span>默认导出内容</span><Segmented label="默认导出内容" value={draft.exportContentMode} onChange={exportContentMode => patch({ exportContentMode })} options={ [['result', '编辑结果'], ['original', '原始底图'], ['display', '显示效果']] } /></li>
          <li className="l-shot-option"><span>保存后动作</span><Segmented label="保存后动作" value={draft.afterSaveAction} onChange={afterSaveAction => patch({ afterSaveAction })} options={ [['none', '无'], ['reveal', '显示文件'], ['copy-path', '复制路径'], ['copy-file', '复制文件']] } /></li>
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
      </SubPane>
      <SubPane id="history" active={sub === 'history'}>
        <CaptureHistory policy={draft.history} change={history => patch({ history })} pinned={() => setPinRevision(value => value + 1)} />
      </SubPane>
      <SubPane id="pins" active={sub === 'pins'}>
        <PinWorkspace settings={settings.pinWorkspace} revision={pinRevision} />
      </SubPane>
      <SubPane id="vision" active={sub === 'vision'}>
        <VisionSettings />
      </SubPane>
      <SubPane id="recording" active={sub === 'recording'}>
        <section id="screenshot-recording" className="l-set-section">
          <div className="l-set-row-head"><h3>屏幕录制与教学演示</h3><button className="l-text-btn" onClick={() => void window.desktop.recordingPanel(true)}>打开录制面板</button></div>
          <ul className="l-group">
            <li className="l-shot-option"><span>帧率</span><Segmented label="录制帧率" value={String(draft.recording.fps)} onChange={fps => patch({ recording: { ...draft.recording, fps: Number(fps) as RecordingSettings['fps'] } })} options={['15', '24', '30', '60'].map(fps => [fps, fps] as const)} /></li>
            <li className="l-shot-option"><span>画质</span><Segmented label="录制画质" value={draft.recording.quality} onChange={quality => patch({ recording: { ...draft.recording, quality } })} options={ [['low', '低'], ['medium', '中'], ['high', '高']] } /></li>
            <li className="l-shot-option"><span>默认格式</span><Segmented label="录制默认格式" value={draft.recording.format} onChange={format => patch({ recording: { ...draft.recording, format } })} options={ [['gif', 'GIF'], ['webp', 'WEBP'], ['mp4', 'MP4']] } /></li>
            <li className="l-shot-option"><span>倒计时</span><Segmented label="录制倒计时" value={String(draft.recording.countdown)} onChange={countdown => patch({ recording: { ...draft.recording, countdown: Number(countdown) as RecordingSettings['countdown'] } })} options={ [['0', '无'], ['3', '3 秒'], ['5', '5 秒']] } /></li>
            {([['systemAudio', '系统声音'], ['microphone', '麦克风'], ['showKeystrokes', '显示按键提示'], ['showMouseClicks', '显示鼠标点击'], ['cameraOverlay', '摄像头画中画']] as const).map(([key, label]) => <li key={key}><span>{label}</span><Switch label={key === 'systemAudio' || key === 'microphone' ? `录制${label}` : label} value={draft.recording[key]} change={() => patch({ recording: { ...draft.recording, [key]: !draft.recording[key] } })} /></li>)}
            <li className="l-shot-option"><span>摄像头位置</span><Segmented label="摄像头位置" value={draft.recording.cameraPosition} onChange={cameraPosition => patch({ recording: { ...draft.recording, cameraPosition } })} options={ [['bottom-right', '右下'], ['bottom-left', '左下'], ['top-right', '右上'], ['top-left', '左上']] } /></li>
          </ul><p className="l-field-help">保存后用于下一次录制。MP4 可包含系统声音和麦克风；GIF、WEBP 与动态贴图无声音。</p>
        </section>
      </SubPane>
    </div>
    {(dirty || saved || error) && <div className="l-save-bar" role="status">{error ? <span className="l-danger">{error}</span> : saved && !dirty ? <span className="l-ok"><Check size={14} />已保存</span> : '有未保存的更改'}<span className="push" />{dirty && <><button className="l-btn small" disabled={saving} onClick={() => { setDraft(structuredClone(settings)); setHeight(String(settings.scrollMaxHeight)); setError(''); setSaved(false); }}>放弃</button><button className="l-btn small primary" disabled={saving || !supported.length} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></>}</div>}
  </>;
}
