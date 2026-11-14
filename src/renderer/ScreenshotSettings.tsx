import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, FolderOpen, X } from 'lucide-react';
import type { Settings } from '../shared/contracts';
import { captureModeLabels } from '../shared/capture';
import { validateVisionConfig, type VisionServiceConfig } from '../shared/intelligence';
import type { RecordingSettings } from '../shared/recording';
import { screenshotKinds, screenshotOutputFormats, validateScreenshotSettings, type ScreenshotActions, type ScreenshotKind } from '../shared/screenshot-settings';
import { CaptureHistory, PinWorkspace } from './CaptureWorkspaceSettings';
import { ApiConnectionBindingFields } from './ImageOptionsFields';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, Segmented, SubNav, SubPane, useSubNav } from './motion';
import { Switch } from './Switch';
import './styles/screenshot-settings.css';

const labels = { ...captureModeLabels, scroll: '滚动截图' };

const subTabs = [
  ['capture', '采集与输出'],
  ['editor', '编辑器与鼠标'],
  ['history', '历史库'],
  ['pins', '贴图空间'],
  ['vision', '智能识别'],
  ['recording', '屏幕录制']
] as const;

const toolbarOptions = [
  ['text-select', '选字'],
  ['select', '选择'],
  ['rectangle', '矩形'],
  ['ellipse', '椭圆'],
  ['arrow', '箭头'],
  ['line', '直线'],
  ['pen', '画笔'],
  ['highlight', '高亮'],
  ['text', '文字'],
  ['number', '序号'],
  ['redact', '遮挡'],
  ['mosaic', '马赛克'],
  ['blur', '模糊'],
  ['crop', '裁剪'],
  ['picker', '取色']
] as const;

const names = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
const languageName = (code: string) => {
  try {
    return names.of(code) || code;
  } catch {
    return code;
  }
};

function VisionSettings({
  onOpenConnections,
  notify
}: {
  onOpenConnections(): void;
  notify(status: { ok?: boolean; error?: string }): void;
}) {
  const [draft, setDraft] = useState<VisionServiceConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void window.desktop.visionConfig().then(
      config => {
        if (active) setDraft(config);
      },
      reason => {
        if (active) setError(String(reason));
      }
    );
    return () => {
      active = false;
    };
  }, []);

  async function commit(next: VisionServiceConfig) {
    setDraft(next);
    setError('');
    if (!next.connectionId || !next.model.trim()) return;
    try {
      const input = {
        connectionId: next.connectionId,
        baseURL: next.baseURL,
        model: next.model.trim(),
        targetLanguage: next.targetLanguage
      };
      validateVisionConfig(input);
      const saved = await window.desktop.saveVisionConfig(input);
      setDraft(saved);
      notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify({ error: msg });
    }
  }

  return (
    <div className="l-set-group">
      <div className="l-set-lbl">
        <span>截图智能识别模型</span>
        <span className="r">用于截图编辑器与贴图中的整图翻译、表格提取、数学公式 LaTeX 识别</span>
      </div>
      <div className="l-set-card">
        {draft ? (
          <>
            <div className="l-set-row col">
              <ApiConnectionBindingFields
                connectionId={draft.connectionId}
                model={draft.model}
                modelId="vision-model"
                modelPlaceholder="gpt-4.1 / gemini-2.5-flash"
                label="视觉模型（需支持图像输入）"
                onOpenConnections={onOpenConnections}
                onChange={({ connectionId, model }) => void commit({ ...draft, connectionId, model })}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">整图翻译默认语言</div>
              </div>
              <Segmented
                label="默认翻译语言"
                value={draft.targetLanguage}
                onChange={targetLanguage => void commit({ ...draft, targetLanguage })}
                options={[
                  ['简体中文', '中文'],
                  ['English', '英文'],
                  ['日本語', '日文'],
                  ['한국어', '韩文'],
                  ...(!['简体中文', 'English', '日本語', '한국어'].includes(draft.targetLanguage)
                    ? ([[draft.targetLanguage, draft.targetLanguage]] as const)
                    : [])
                ]}
              />
            </div>
          </>
        ) : (
          <div className="l-set-row">
            <span className="l-set-row-sub">正在读取视觉服务配置…</span>
          </div>
        )}
      </div>
      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ScreenshotSettings({
  fullSettings,
  onOpenShortcuts,
  onOpenConnections,
  notify
}: {
  fullSettings: Settings;
  onOpenShortcuts(): void;
  onOpenConnections(): void;
  notify(status: { ok?: boolean; error?: string }): void;
}) {
  const settings = fullSettings.screenshot;
  const [sub, setSub] = useSubNav<(typeof subTabs)[number][0]>('capture');
  const [pinRevision, setPinRevision] = useState(0);
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [supported, setSupported] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [addingLang, setAddingLang] = useState(false);
  const [heightText, setHeightText] = useState(String(settings.scrollMaxHeight));
  const supportedRef = useRef<string[]>([]);

  useEffect(() => {
    void window.desktop
      .ocrLanguages()
      .then(list => {
        setSupported(list);
        supportedRef.current = list;
      })
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => {
    setDraft(structuredClone(settings));
    setHeightText(String(settings.scrollMaxHeight));
  }, [settings]);

  async function persistShot(next: typeof settings) {
    setDraft(next);
    setError('');
    try {
      if (!next.directory.startsWith('/') || !next.quickSaveDirectory.startsWith('/')) {
        throw Error('截图保存目录需使用绝对路径');
      }
      if (supportedRef.current.length > 0) {
        validateScreenshotSettings(next, supportedRef.current);
      }
      const res = await window.desktop.saveScreenshot(next);
      if (res.error) throw Error(res.error);
      notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify({ error: msg });
    }
  }

  function patch(changes: Partial<typeof settings>) {
    void persistShot({ ...draft, ...changes });
  }

  function toggleAfterAction(kind: ScreenshotKind, key: keyof ScreenshotActions) {
    const nextKind = { ...draft.actions[kind], [key]: !draft.actions[kind][key] };
    if (!nextKind.show && !nextKind.copy && !nextKind.save) return;
    patch({ actions: { ...draft.actions, [kind]: nextKind } });
  }

  function moveLanguage(index: number, direction: number) {
    const languages = [...draft.languages];
    [languages[index], languages[index + direction]] = [languages[index + direction], languages[index]];
    patch({ languages });
  }

  async function saveGeneralPatch(changes: Partial<Pick<Settings, 'mouseActions' | 'toolbarTools'>>) {
    const res = await window.desktop.saveGeneral({
      launchAtLogin: fullSettings.launchAtLogin,
      themeMode: fullSettings.themeMode,
      toolbarTools: fullSettings.toolbarTools,
      mouseActions: fullSettings.mouseActions,
      autoCheckUpdates: fullSettings.autoCheckUpdates,
      ...changes
    });
    if (res.error) {
      setError(res.error);
      notify({ error: res.error });
    } else {
      notify({ ok: true });
    }
  }

  function toggleToolbarTool(id: string) {
    const current = fullSettings.toolbarTools.length ? fullSettings.toolbarTools : toolbarOptions.map(([tool]) => tool);
    const next = current.includes(id) ? current.filter(tool => tool !== id) : [...current, id];
    if (!next.length) {
      setError('请至少保留一个标注工具');
      return;
    }
    void saveGeneralPatch({ toolbarTools: next.length === toolbarOptions.length ? [] : next });
  }

  return (
    <>
      <SubNav scope="screenshot" label="截图设置二级分类" value={sub} options={subTabs} onChange={setSub} />

      <SubPane scope="screenshot" id="capture" active={sub === 'capture'}>
        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>截图完成后默认动作</span>
            <span className="r">
              <button type="button" className="l-text-btn" onClick={onOpenShortcuts}>
                配置截图快捷键 →
              </button>
            </span>
          </div>
          <div className="l-set-card">
            {screenshotKinds.map(kind => (
              <div className="l-set-row" key={kind}>
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{labels[kind]}</div>
                </div>
                <div className="l-shot-actions">
                  {(
                    [
                      ['show', '进编辑'],
                      ['copy', '复制'],
                      ['save', '保存']
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <Switch
                        label={`${labels[kind]}后${label}`}
                        value={draft.actions[kind][key]}
                        change={() => toggleAfterAction(kind, key)}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>选区与辅助</span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">默认选区形状</div>
              </div>
              <Segmented
                label="选区形状"
                value={draft.selectionShape}
                onChange={selectionShape => patch({ selectionShape })}
                options={[
                  ['rect', '矩形'],
                  ['freehand', '套索'],
                  ['polygon', '多边形'],
                  ['multi-rect', '多区域']
                ]}
              />
            </div>
            {(
              [
                ['includeCursor', '截图包含鼠标指针'],
                ['showCrosshair', '显示十字辅助线'],
                ['showLoupeGrid', '显示放大镜像素网格'],
                ['rememberRegionAcrossLaunches', '重启后记住上次截图区域'],
                ['pinKeepsSize', '钉为贴图时保持屏幕原尺寸']
              ] as const
            ).map(([key, label]) => (
              <div className="l-set-row" key={key}>
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{label}</div>
                </div>
                <Switch label={label} value={draft[key]} change={() => patch({ [key]: !draft[key] })} />
              </div>
            ))}
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">取色放大镜倍率</div>
              </div>
              <Segmented
                label="放大镜倍率"
                value={String(draft.loupeMagnification)}
                onChange={v => patch({ loupeMagnification: Number(v) as (typeof draft)['loupeMagnification'] })}
                options={[
                  ['4', '4×'],
                  ['8', '8×'],
                  ['12', '12×']
                ]}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">取色色值格式</div>
              </div>
              <Segmented
                label="取色色值格式"
                value={draft.loupeColorFormat}
                onChange={loupeColorFormat => patch({ loupeColorFormat })}
                options={[
                  ['hex', 'HEX'],
                  ['rgb', 'RGB'],
                  ['hsl', 'HSL']
                ]}
              />
            </div>
          </div>
        </div>

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>保存与导出</span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row col">
              <div className="l-field">
                <label htmlFor="screenshot-directory">默认保存目录</label>
                <div className="l-row">
                  <input
                    id="screenshot-directory"
                    className="l-input mono"
                    value={draft.directory}
                    onChange={e => setDraft(cur => ({ ...cur, directory: e.target.value }))}
                    onBlur={() => void persistShot(draft)}
                  />
                  <button
                    type="button"
                    className="l-btn small"
                    onClick={() =>
                      void window.desktop.choosePath('directory').then(res => {
                        if (res) patch({ directory: res.path });
                      })
                    }
                  >
                    <FolderOpen size={14} />
                    <span>选择</span>
                  </button>
                </div>
              </div>
              <div className="l-field">
                <label htmlFor="screenshot-quick-directory">快速保存目录（⌘⇧S）</label>
                <div className="l-row">
                  <input
                    id="screenshot-quick-directory"
                    className="l-input mono"
                    value={draft.quickSaveDirectory}
                    onChange={e => setDraft(cur => ({ ...cur, quickSaveDirectory: e.target.value }))}
                    onBlur={() => void persistShot(draft)}
                  />
                  <button
                    type="button"
                    className="l-btn small"
                    onClick={() =>
                      void window.desktop.choosePath('directory').then(res => {
                        if (res) patch({ quickSaveDirectory: res.path });
                      })
                    }
                  >
                    <FolderOpen size={14} />
                    <span>选择</span>
                  </button>
                </div>
              </div>
              <div className="l-field">
                <label htmlFor="screenshot-template">文件命名模板</label>
                <input
                  id="screenshot-template"
                  className="l-input mono"
                  spellCheck={false}
                  value={draft.fileNameTemplate}
                  onChange={e => setDraft(cur => ({ ...cur, fileNameTemplate: e.target.value }))}
                  onBlur={() => void persistShot(draft)}
                />
                <p className="l-field-help">{'可用变量：{YYYY} {MM} {DD} {HH} {mm} {ss} {app} {width} {height} {seq}'}</p>
              </div>
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">默认图片格式</div>
              </div>
              <Segmented
                label="截图保存格式"
                value={draft.format}
                onChange={format => patch({ format })}
                options={screenshotOutputFormats.map(f => [f, f.toUpperCase()] as const)}
              />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">默认复制方式</div>
              </div>
              <Segmented
                label="默认复制方式"
                value={draft.copyMode}
                onChange={copyMode => patch({ copyMode })}
                options={[
                  ['image', '图片'],
                  ['file', '文件'],
                  ['path', '路径']
                ]}
              />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">默认导出内容</div>
              </div>
              <Segmented
                label="默认导出内容"
                value={draft.exportContentMode}
                onChange={exportContentMode => patch({ exportContentMode })}
                options={[
                  ['result', '编辑结果'],
                  ['original', '原始底图'],
                  ['display', '显示效果']
                ]}
              />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">保存后动作</div>
              </div>
              <Segmented
                label="保存后动作"
                value={draft.afterSaveAction}
                onChange={afterSaveAction => patch({ afterSaveAction })}
                options={[
                  ['none', '无'],
                  ['reveal', '显示文件'],
                  ['copy-path', '复制路径'],
                  ['copy-file', '复制文件']
                ]}
              />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">保存时缩小至 1× 逻辑分辨率</div>
              </div>
              <Switch label="保存时缩小至 1×" value={draft.resizeTo1x} change={() => patch({ resizeTo1x: !draft.resizeTo1x })} />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">保留窗口截图阴影</div>
              </div>
              <Switch label="保留窗口阴影" value={draft.shadow} change={() => patch({ shadow: !draft.shadow })} />
            </div>

            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">滚动长截图最大高度</div>
              </div>
              <div className="l-row">
                <input
                  aria-label="滚动长截图最大高度"
                  className="l-input mono l-shot-height"
                  inputMode="numeric"
                  value={heightText}
                  onChange={e => setHeightText(e.target.value)}
                  onBlur={() => {
                    const n = Number(heightText);
                    if (Number.isSafeInteger(n) && n >= 400) patch({ scrollMaxHeight: n });
                  }}
                />
                <span className="l-set-row-sub mono">px</span>
              </div>
            </div>
          </div>
        </div>

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>离线 OCR 识别语言</span>
            <span className="r">
              <button type="button" className="l-text-btn" disabled={!supported.length} onClick={() => setAddingLang(v => !v)}>
                {addingLang ? '收起' : '+ 添加语言'}
              </button>
            </span>
          </div>
          <AnimatePresence initial={false}>
            {addingLang && (
              <motion.div key="ocr-add-lang" className="l-collapse" {...collapse}>
                <div className="l-wrap">
                  {supported
                    .filter(lang => !draft.languages.includes(lang))
                    .map(lang => (
                      <button
                        key={lang}
                        type="button"
                        className="l-btn small"
                        onClick={() => {
                          patch({ languages: [...draft.languages, lang] });
                          setAddingLang(false);
                        }}
                      >
                        {languageName(lang)}
                      </button>
                    ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="l-set-card">
            {draft.languages.map((language, index) => (
              <div className="l-set-row" key={language}>
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{languageName(language)}</div>
                </div>
                <button
                  type="button"
                  className="l-icon small"
                  aria-label={`提高 ${languageName(language)} 优先级`}
                  disabled={index === 0}
                  onClick={() => moveLanguage(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="l-icon small"
                  aria-label={`降低 ${languageName(language)} 优先级`}
                  disabled={index === draft.languages.length - 1}
                  onClick={() => moveLanguage(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="l-icon small"
                  aria-label={`移除 ${languageName(language)}`}
                  disabled={draft.languages.length === 1}
                  onClick={() => patch({ languages: draft.languages.filter(v => v !== language) })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </SubPane>

      <SubPane scope="screenshot" id="editor" active={sub === 'editor'}>
        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>截图编辑器鼠标动作与样式记忆</span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">记住标注颜色与笔触粗细</div>
              </div>
              <Switch
                label="记住标注工具样式"
                value={draft.annotationMemory.rememberToolStyles}
                change={() => patch({ annotationMemory: { ...draft.annotationMemory, rememberToolStyles: !draft.annotationMemory.rememberToolStyles } })}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">双击选区</div>
              </div>
              <Segmented
                label="双击动作"
                value={fullSettings.mouseActions.doubleClick}
                onChange={doubleClick => void saveGeneralPatch({ mouseActions: { ...fullSettings.mouseActions, doubleClick } })}
                options={[
                  ['copy', '复制'],
                  ['save', '保存'],
                  ['pin', '贴图'],
                  ['none', '无']
                ]}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">鼠标中键</div>
              </div>
              <Segmented
                label="中键动作"
                value={fullSettings.mouseActions.middleClick}
                onChange={middleClick => void saveGeneralPatch({ mouseActions: { ...fullSettings.mouseActions, middleClick } })}
                options={[
                  ['pin', '贴图'],
                  ['quick-save', '快速保存'],
                  ['none', '无']
                ]}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">鼠标右键</div>
              </div>
              <Segmented
                label="右键动作"
                value={fullSettings.mouseActions.rightClick}
                onChange={rightClick => void saveGeneralPatch({ mouseActions: { ...fullSettings.mouseActions, rightClick } })}
                options={[
                  ['reselect', '重新选区'],
                  ['cancel', '取消截图']
                ]}
              />
            </div>
          </div>
        </div>

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>主标注栏工具显示</span>
            <span className="r">
              <button
                type="button"
                className="l-text-btn"
                disabled={!fullSettings.toolbarTools.length}
                onClick={() => void saveGeneralPatch({ toolbarTools: [] })}
              >
                全部显示
              </button>
            </span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row col">
              <div className="l-ignored-scopes">
                {toolbarOptions.map(([id, label]) => {
                  const checked = !fullSettings.toolbarTools.length || fullSettings.toolbarTools.includes(id);
                  return (
                    <button key={id} type="button" className="l-btn small" role="checkbox" aria-checked={checked} onClick={() => toggleToolbarTool(id)}>
                      <Check size={13} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>平铺水印与输出圆角</span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row col">
              <div className="l-field">
                <label htmlFor="screenshot-watermark">默认水印文字（在编辑器「更多特效 ▾ → 平铺水印」中使用）</label>
                <input
                  id="screenshot-watermark"
                  className="l-input"
                  maxLength={500}
                  value={draft.watermarkText}
                  onChange={e => setDraft(cur => ({ ...cur, watermarkText: e.target.value }))}
                  onBlur={() => void persistShot(draft)}
                />
              </div>
              <div className="l-grid-equal">
                <div className="l-field">
                  <label htmlFor="screenshot-cornerRadius">导出圆角 · px</label>
                  <input
                    id="screenshot-cornerRadius"
                    className="l-input mono"
                    type="number"
                    min="0"
                    max="64"
                    value={draft.cornerRadius}
                    onChange={e => patch({ cornerRadius: Number(e.target.value) })}
                  />
                </div>
                <div className="l-field">
                  <label htmlFor="screenshot-borderWidth">导出边框 · px</label>
                  <input
                    id="screenshot-borderWidth"
                    className="l-input mono"
                    type="number"
                    min="0"
                    max="16"
                    value={draft.borderWidth}
                    onChange={e => patch({ borderWidth: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </SubPane>

      <SubPane scope="screenshot" id="history" active={sub === 'history'}>
        <CaptureHistory policy={draft.history} change={history => patch({ history })} pinned={() => setPinRevision(v => v + 1)} notify={notify} />
      </SubPane>

      <SubPane scope="screenshot" id="pins" active={sub === 'pins'}>
        <PinWorkspace settings={settings.pinWorkspace} revision={pinRevision} notify={notify} />
      </SubPane>

      <SubPane scope="screenshot" id="vision" active={sub === 'vision'}>
        <VisionSettings onOpenConnections={onOpenConnections} notify={notify} />
      </SubPane>

      <SubPane scope="screenshot" id="recording" active={sub === 'recording'}>
        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>屏幕录制默认参数</span>
            <span className="r">
              <button type="button" className="l-text-btn" onClick={() => void window.desktop.recordingPanel(true)}>
                打开录制面板 →
              </button>
            </span>
          </div>
          <div className="l-set-card">
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">帧率</div>
              </div>
              <Segmented
                label="录制帧率"
                value={String(draft.recording.fps)}
                onChange={fps => patch({ recording: { ...draft.recording, fps: Number(fps) as RecordingSettings['fps'] } })}
                options={['15', '24', '30', '60'].map(fps => [fps, `${fps} FPS`] as const)}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">画质</div>
              </div>
              <Segmented
                label="录制画质"
                value={draft.recording.quality}
                onChange={quality => patch({ recording: { ...draft.recording, quality } })}
                options={[
                  ['low', '快速'],
                  ['medium', '标准'],
                  ['high', '高画质']
                ]}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">默认导出格式</div>
              </div>
              <Segmented
                label="录制默认格式"
                value={draft.recording.format}
                onChange={format => patch({ recording: { ...draft.recording, format } })}
                options={[
                  ['gif', 'GIF'],
                  ['webp', 'WEBP'],
                  ['mp4', 'MP4']
                ]}
              />
            </div>
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-name">开始前倒计时</div>
              </div>
              <Segmented
                label="录制倒计时"
                value={String(draft.recording.countdown)}
                onChange={countdown => patch({ recording: { ...draft.recording, countdown: Number(countdown) as RecordingSettings['countdown'] } })}
                options={[
                  ['0', '无'],
                  ['3', '3 秒'],
                  ['5', '5 秒']
                ]}
              />
            </div>
            {(
              [
                ['systemAudio', '录制系统声音（仅 MP4）'],
                ['microphone', '录制麦克风（仅 MP4）'],
                ['showKeystrokes', '显示按键教学提示'],
                ['showMouseClicks', '显示鼠标点击脉冲'],
                ['cameraOverlay', '开启摄像头画中画']
              ] as const
            ).map(([key, label]) => (
              <div className="l-set-row" key={key}>
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{label}</div>
                </div>
                <Switch
                  label={label}
                  value={draft.recording[key]}
                  change={() => patch({ recording: { ...draft.recording, [key]: !draft.recording[key] } })}
                />
              </div>
            ))}
            <AnimatePresence initial={false}>
              {draft.recording.cameraOverlay && (
                <motion.div key="cam-pos" className="l-set-collapse" {...collapse}>
                  <div className="l-set-row">
                    <div className="l-set-row-main">
                      <div className="l-set-row-name">摄像头画中画位置</div>
                    </div>
                    <Segmented
                      label="摄像头位置"
                      value={draft.recording.cameraPosition}
                      onChange={cameraPosition => patch({ recording: { ...draft.recording, cameraPosition } })}
                      options={[
                        ['bottom-right', '右下'],
                        ['bottom-left', '左下'],
                        ['top-right', '右上'],
                        ['top-left', '左上']
                      ]}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </SubPane>

      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
