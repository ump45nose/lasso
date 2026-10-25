'use strict';
/* Lasso 2 detailed design: working prototype of every local surface.
   Components mirror the planned renderer structure; data is sample only. */
const { useState, useEffect, useRef, useLayoutEffect, useMemo, Fragment } = React;
const html = htm.bind(React.createElement);

/* ───────── Icons (Lucide-style, 1.6 stroke) ───────── */
const ICONS = {
  plus: html`<g><path d="M12 5v14M5 12h14" /></g>`,
  pin: html`<g><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" /></g>`,
  search: html`<g><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></g>`,
  x: html`<g><path d="M6 6l12 12M18 6L6 18" /></g>`,
  copy: html`<g><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></g>`,
  retry: html`<g><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></g>`,
  chevD: html`<g><path d="M6 9l6 6 6-6" /></g>`,
  chevR: html`<g><path d="M9 6l6 6-6 6" /></g>`,
  chevL: html`<g><path d="M15 6l-6 6 6 6" /></g>`,
  check: html`<g><path d="M5 12.5l4.5 4.5L19 7.5" /></g>`,
  image: html`<g><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18" /></g>`,
  scan: html`<g><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3" /></g>`,
  expand: html`<g><path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" /></g>`,
  minus: html`<g><path d="M5 12h14" /></g>`,
  sliders: html`<g><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></g>`,
  folder: html`<g><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></g>`,
  terminal: html`<g><path d="M5 7l5 5-5 5M12 18h7" /></g>`,
  grip: html`<g><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="2.6" /></g>`,
  up: html`<g><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></g>`,
  download: html`<g><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></g>`,
  upload: html`<g><path d="M12 20V9M7 14l5-5 5 5M5 4h14" /></g>`,
  crop: html`<g><path d="M6 3v13a2 2 0 0 0 2 2h13M3 6h13a2 2 0 0 1 2 2v13" /></g>`,
  dots: html`<g><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" /></g>`,
  trash: html`<g><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></g>`,
  alert: html`<g><circle cx="12" cy="12" r="8" /><path d="M12 8v5M12 16v.01" /></g>`,
  type: html`<g><path d="M5 19L11 5h2l6 14M8 14h8" /></g>`,
  play: html`<g><path d="M8 5l11 7-11 7z" /></g>`,
};
function Icon({ n, s }) {
  return html`<svg className=${'ic' + (s ? ' ' + s : '')} viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
}
function Mark({ size = 16, ink = '#141413' }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
    <path fill="none" stroke="#D97757" strokeWidth="15" strokeLinecap="round" d="M10 35C22 33 32 32.4 41 31.4" />
    <path fill="none" stroke=${ink} strokeWidth="5" strokeLinecap="round" d="M8 35.2C20 34 31 33.4 40 32.4M50 31.4L58 30.6M48 23.5L54 18.6M49.5 39L56 43.5" />
  </svg>`;
}

/* ───────── Sample data ───────── */
const TARGETS = {
  chatgpt: { label: 'ChatGPT', badge: 'Ch', local: false, host: 'chatgpt.com' },
  gemini: { label: 'Gemini', badge: 'Ge', local: false, host: 'gemini.google.com' },
  codex: { label: 'Codex', badge: 'Cx', local: true },
  pi: { label: 'Pi', badge: 'π', local: true },
};
const TARGET_IDS = Object.keys(TARGETS);
const ACTIVITY = { idle: '新对话', loading: '加载中', running: '进行中', waiting: '等待处理', draft: '有草稿', complete: '已完成', unknown: '状态待确认', error: '页面异常', released: '已释放 · 点击恢复' };
const DEFAULT_PRESETS = [
  { id: 'ask', name: '问 AI', template: '请结合以下内容回答我的问题：\n\n{{selection}}\n\n我的问题是：', target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true },
  { id: 'explain', name: '解释', template: '请用通俗的语言解释以下内容，并给出一个简短例子：\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'summarize', name: '总结', template: '请总结以下内容，保留重要事实和结论，用简洁的要点呈现：\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true, model: '示例模型', effort: '深度' },
  { id: 'translate', name: '翻译', template: '请翻译以下内容：外文译为中文，中文译为英文。保留原意与格式，只输出译文。\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'today', name: '整理今天待办', template: '请使用你已连接的工具，整理我今天的待办和日程，按优先级列出，并注明信息来源。无法访问的信息请直接说明，不要猜测。', target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true },
];
const BASE_TASKS = [
  { id: 't1', target: 'chatgpt', title: '幂等性解释', activity: 'complete' },
  { id: 't2', target: 'gemini', title: '周报要点', activity: 'complete' },
  { id: 't3', target: 'codex', title: 'TaskManager', activity: 'waiting' },
  { id: 't4', target: 'chatgpt', title: '发布说明翻译', activity: 'released' },
  { id: 't5', target: 'pi', title: '整理 dotfiles', activity: 'draft' },
];
const clone = value => JSON.parse(JSON.stringify(value));
let seq = 10;
const newId = () => 't' + (++seq);
const preview = template => template.replace(/\s+/g, ' ').split('{{selection}}');

/* ───────── Fonts ───────── */
const ROLES = [
  { id: 'display', name: '标题', use: '启动台、页面标题、设置标题', sample: '随手问一句，再回到手上的事。', fallback: 'var(--serif-fallback)' },
  { id: 'text', name: '回答正文', use: 'CLI 回答与长段说明', sample: '释放前会开一个隐藏页核对历史与最新回答。', fallback: 'var(--serif-fallback)' },
  { id: 'ui', name: '界面文字', use: '标签、按钮、列表、提示', sample: '填入后直接发送 · 已释放，点击恢复', fallback: 'var(--serif-fallback)' },
  { id: 'mono', name: '代码与数据', use: '路径、命令、尺寸、快捷键', sample: 'npm run typecheck · 1788 × 693', fallback: "'SF Mono', Menlo, monospace" },
];
const DEFAULT_FONTS = { display: 'Anthropic Serif Text', text: 'Anthropic Serif Text', ui: 'Anthropic Serif Text', mono: 'JetBrains Mono' };
const BUILTIN = ['Newsreader', 'JetBrains Mono'];
const SYSTEM_CANDIDATES = ['Anthropic Serif Text', 'Anthropic Serif', 'Anthropic Sans', 'Anthropic Mono', 'New York', 'Songti SC', 'Iowan Old Style', 'Palatino', 'Georgia', 'PingFang SC', 'Helvetica Neue', 'SF Mono', 'Menlo'];
const quote = family => "'" + family.replace(/['\\]/g, '') + "'";
const stackFor = (role, family) => quote(family) + ', ' + ROLES.find(r => r.id === role).fallback;
const measure = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return font => { ctx.font = font; return ctx.measureText('永和九年 Lasso 0123 abcdefghijkl').width; };
})();
function isInstalled(family) {
  return ['monospace', 'serif', 'sans-serif'].some(base => measure('72px ' + quote(family) + ', ' + base) !== measure('72px ' + base));
}
/** Reads the family name from an OpenType/TrueType name table. WOFF files fall back to the file name. */
function readFamily(buffer) {
  const v = new DataView(buffer);
  let base = 0;
  if (v.getUint32(0) === 0x74746366) base = v.getUint32(12);
  const sig = v.getUint32(base);
  if (sig !== 0x00010000 && sig !== 0x4F54544F && sig !== 0x74727565) return null;
  const tables = v.getUint16(base + 4);
  for (let i = 0; i < tables; i++) {
    const rec = base + 12 + 16 * i;
    if (v.getUint32(rec) !== 0x6E616D65) continue;
    const off = v.getUint32(rec + 8), count = v.getUint16(off + 2), strings = off + v.getUint16(off + 4), names = {};
    for (let j = 0; j < count; j++) {
      const e = off + 6 + 12 * j, platform = v.getUint16(e), id = v.getUint16(e + 6), len = v.getUint16(e + 8), at = v.getUint16(e + 10);
      if ((platform !== 3 && platform !== 0) || names[id]) continue;
      let text = '';
      for (let k = 0; k < len; k += 2) text += String.fromCharCode(v.getUint16(strings + at + k));
      names[id] = text;
    }
    return { family: names[16] || names[1], style: names[17] || names[2] || '' };
  }
  return null;
}
function loadStored() {
  try { const saved = JSON.parse(localStorage.getItem('lasso-v2-fonts') || 'null'); if (saved && saved.display) return saved; } catch (error) {}
  return { ...DEFAULT_FONTS };
}

function FontSettings({ fonts, setFonts, imported, addImported }) {
  const [open, setOpen] = useState(null);
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState([]);
  const [message, setMessage] = useState('');
  const [tick, setTick] = useState(0);
  const file = useRef(null);
  useEffect(() => { document.fonts.ready.then(() => setTick(t => t + 1)); }, []);
  const detected = useMemo(() => SYSTEM_CANDIDATES.filter(isInstalled), [tick]);
  const importedNames = imported.map(f => f.family);
  const source = family => importedNames.includes(family) ? ['已导入', ''] : BUILTIN.includes(family) ? ['内置', ''] : isInstalled(family) ? ['本机', ''] : ['未找到 · 正在用后备字体', 'warn'];
  const options = [...new Set([...importedNames, ...detected, ...BUILTIN, ...local])].filter(f => !query || f.toLowerCase().includes(query.toLowerCase()));
  async function readLocal() {
    try {
      const list = await window.queryLocalFonts();
      setLocal([...new Set(list.map(f => f.family))].sort());
      setMessage('已读取 ' + list.length + ' 个本机字体样式。');
    } catch (error) {
      setMessage('这个预览页没有读取字体列表的权限；Lasso 应用内会直接列出本机全部字体。也可以在上方输入字体名。');
    }
  }
  async function importFile(event) {
    const chosen = event.target.files[0];
    event.target.value = '';
    if (!chosen) return;
    try {
      const buffer = await chosen.arrayBuffer();
      const name = readFamily(buffer);
      const family = (name && name.family) || chosen.name.replace(/\.[^.]+$/, '');
      const face = new FontFace(family, buffer);
      await face.load();
      document.fonts.add(face);
      addImported({ family, style: name ? name.style : '', file: chosen.name });
      if (open) setFonts({ ...fonts, [open]: family });
      setMessage('已导入「' + family + '」' + (name && name.style ? ' · ' + name.style : '') + '。');
      setTick(t => t + 1);
    } catch (error) {
      setMessage('「' + chosen.name + '」不是可用的字体文件。支持 .otf、.ttf、.woff、.woff2。');
    }
  }
  return html`<div className="l-set-body-inner" style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="l-set-row-head"><h3>字体</h3><span>默认全部使用衬线体</span></div>
    <ul className="l-group">
      ${ROLES.map(role => {
        const family = fonts[role.id];
        const [label, tone] = source(family);
        return html`<li className="col" key=${role.id}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="l-row-label"><span>${role.name}</span><span>${role.use}</span></div>
            <span className=${'l-font-src ' + tone}>${label}</span>
            <button type="button" className="l-btn small" aria-expanded=${open === role.id} onClick=${() => { setOpen(open === role.id ? null : role.id); setQuery(''); }}>${open === role.id ? '收起' : '更换'}</button>
          </div>
          <div className="l-font-preview" style=${{ fontFamily: stackFor(role.id, family) }}>${role.sample}</div>
          <div className="l-kbd">${family}</div>
          ${open === role.id && html`<div className="l-picker">
            <input className="l-input" id=${'font-search-' + role.id} aria-label="搜索或输入字体名" placeholder="搜索，或输入本机字体名后回车" value=${query}
              onChange=${e => setQuery(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && query.trim()) { setFonts({ ...fonts, [role.id]: query.trim() }); setQuery(''); } }} />
            <div className="l-picker-list" role="listbox" aria-label=${role.name + '字体'}>
              ${options.map(f => html`<button type="button" role="option" key=${f} aria-selected=${f === family} onClick=${() => setFonts({ ...fonts, [role.id]: f })} style=${{ fontFamily: stackFor(role.id, f) }}>
                ${f}<small>${importedNames.includes(f) ? '已导入' : BUILTIN.includes(f) ? '内置' : '本机'}</small></button>`)}
              ${!options.length && html`<p className="l-field-help" style=${{ padding: '6px 8px' }}>没有匹配的字体。按回车直接使用「${query}」。</p>`}
            </div>
            <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button type="button" className="l-btn small" onClick=${() => file.current.click()}><${Icon} n="upload" s="s" />导入字体文件…</button>
              <button type="button" className="l-btn small" onClick=${readLocal}>读取全部本机字体</button>
              <button type="button" className="l-btn small" onClick=${() => setFonts({ ...fonts, [role.id]: DEFAULT_FONTS[role.id] })}>恢复默认</button>
            </div>
          </div>`}
        </li>`;
      })}
    </ul>
    <input ref=${file} type="file" accept=".otf,.ttf,.ttc,.woff,.woff2" hidden onChange=${importFile} />
    ${message && html`<p className="l-field-help" role="status">${message}</p>`}
    <p className="l-field-help">只影响 Lasso 自己的界面，网页内容由网站控制。导入的字体复制到应用数据目录，换机器时随设置一起迁移。</p>
  </div>`;
}

/* ───────── Window parts ───────── */
function StatusDot({ activity }) { return html`<span className=${'dot ' + activity} aria-hidden="true"></span>`; }
function Badge({ target }) { return html`<span className=${'l-badge' + (TARGETS[target].local ? ' local' : '')}>${TARGETS[target].badge}</span>`; }

function TitleBar({ s, act }) {
  const visible = useMemo(() => {
    const list = s.tasks.slice(0, s.image ? 2 : 3);
    const active = s.tasks.find(t => t.id === s.activeId);
    if (active && !list.includes(active)) list[list.length - 1] = active;
    return list;
  }, [s.tasks, s.activeId, s.image]);
  const hidden = s.tasks.length - visible.length;
  const imageActive = s.view === 'image';
  return html`<header className="l-bar">
    ${!s.tasks.length && !s.image ? html`<div className="l-wordmark"><${Mark} size=${18} /><span>Lasso</span></div>` : html`
    <div className="l-tabs" role="tablist" aria-label="本次任务">
      ${s.image && html`<button type="button" role="tab" className="l-tab" aria-selected=${imageActive} onClick=${() => act.view('image')}>
        <span style=${{ color: 'var(--clay-ink)', display: 'flex' }}><${Icon} n="image" s="s" /></span><span className="l-tab-title">待处理图片</span></button>`}
      ${visible.map(t => html`<button type="button" role="tab" key=${t.id} className="l-tab" aria-selected=${!imageActive && s.view !== 'launcher' && t.id === s.activeId}
          title=${TARGETS[t.target].label + ' · ' + t.title + ' · ' + ACTIVITY[t.activity]} onClick=${() => act.select(t.id)}>
        <${StatusDot} activity=${t.activity} /><${Badge} target=${t.target} /><span className="l-tab-title">${t.title}</span>
        <span className="l-tab-close" role="button" aria-label=${'关闭 ' + t.title} onClick=${e => { e.stopPropagation(); act.close(t.id); }}><${Icon} n="x" s="xs" /></span>
      </button>`)}
      ${hidden > 0 && html`<button type="button" className="l-more" aria-label=${'另外 ' + hidden + ' 个任务'} onClick=${() => act.palette('tasks')}>+${hidden}</button>`}
    </div>`}
    <button type="button" className="l-icon" aria-label="新任务" title="新任务 ⌘N" onClick=${() => act.palette('new')}><${Icon} n="plus" /></button>
    <span className="l-sep"></span>
    <button type="button" className="l-icon" aria-label=${s.pinned ? '取消置顶' : '置顶'} title=${s.pinned ? '已置顶：点击窗外不隐藏' : '置顶'} aria-pressed=${s.pinned} onClick=${act.pin}><${Icon} n="pin" s="s" /></button>
    <button type="button" className="l-cmd" aria-label="打开指令面板" title="指令面板 ⌘K" onClick=${() => act.palette('all')}><${Icon} n="search" s="s" /><span className="l-kbd">⌘K</span></button>
  </header>`;
}

function DeliveryFoot({ d, act }) {
  if (d.kind === 'restore') return html`<footer className="l-foot" role="status"><${StatusDot} activity="loading" /><span className="l-foot-msg">正在恢复原对话 · 不会重发提示词</span></footer>`;
  const steps = d.steps;
  const error = d.state === 'fail';
  const finished = d.state === 'sent' || d.state === 'editing';
  return html`<footer className=${'l-foot' + (error ? ' error' : '')} role="status">
    <ol className="l-steps" aria-label="投递进度">
      ${steps.map((step, i) => {
        const done = finished || i < d.at;
        const now = !finished && i === d.at;
        const cls = done ? 'done' : now ? (error ? 'fail' : 'now') : '';
        return html`<${Fragment} key=${step.id}>
          ${i > 0 && html`<li aria-hidden="true" className=${'l-link-line' + (done || now ? '' : ' todo')}></li>`}
          <li className=${'l-step ' + cls} aria-current=${now ? 'step' : undefined}>
            ${done ? html`<${Icon} n="check" s="xs" />` : now ? (error ? html`<${Icon} n="alert" s="xs" />` : html`<span className=${'dot ' + (d.state === 'login' ? 'waiting' : 'running')}></span>`) : html`<span className="dot draft" style=${{ width: 7, height: 7, borderColor: 'var(--ink-5)' }}></span>`}
            ${step.label}
          </li>
        </${Fragment}>`;
      })}
    </ol>
    <span className="l-foot-msg" title=${d.message}>${d.message}</span>
    ${error && html`<button type="button" className="l-text-btn" onClick=${act.retry}>重试</button>`}
    ${d.state === 'editing' && html`<button type="button" className="l-text-btn" onClick=${act.dismissDelivery}>完成</button>`}
    ${!finished && html`<button type="button" className="l-icon" aria-label="复制完整原文" title="复制完整原文" onClick=${() => act.toast('已复制完整原文')}><${Icon} n="copy" s="s" /></button>`}
    ${!finished && html`<button type="button" className="l-icon" aria-label="取消待发送动作" title=${error ? '关闭' : '取消待发送动作'} onClick=${act.cancelDelivery}><${Icon} n="x" s="s" /></button>`}
  </footer>`;
}
function NoticeFoot({ n, act }) {
  return html`<footer className="l-foot error" role="alert"><${Icon} n="alert" s="s" /><span className="l-foot-msg" title=${n.message}>${n.message}</span>
    ${n.action && html`<button type="button" className="l-text-btn" onClick=${() => act.toast('已打开系统设置')}>${n.action}</button>`}
    <button type="button" className="l-icon" aria-label="关闭提示" onClick=${act.dismissNotice}><${Icon} n="x" s="s" /></button></footer>`;
}

function WebArea({ s, act }) {
  const task = s.tasks.find(t => t.id === s.activeId);
  const host = task ? TARGETS[task.target].host : 'chatgpt.com';
  if (s.web === 'error') return html`<div className="l-empty l-surface-enter"><span style=${{ color: 'var(--danger)' }}><${Icon} n="alert" /></span><h2>网页还没打开。</h2>
    <p>${host} 暂时无法连接。检查网络后重新加载；已填写的内容仍保留在待发送队列里。</p><button type="button" className="l-btn primary" onClick=${act.reload}>重新加载</button></div>`;
  const filled = s.delivery && s.delivery.kind !== 'restore' && (s.delivery.state === 'editing' || s.delivery.steps[s.delivery.at]?.id === 'send' || s.delivery.steps.slice(0, s.delivery.at).some(x => x.id === 'fill'));
  return html`<div className="l-web" aria-label=${host + ' 网页区域'}>
    ${s.web === 'loading' && html`<div className="l-loading-line" aria-label="网页加载中"></div>`}
    <span className="l-web-host">${host} · 网页由网站自己渲染</span>
    ${s.web === 'login' ? html`<div className="l-empty"><p style=${{ fontSize: 13 }}>这里是 ${host} 的登录页。登录后，待发送的内容会自动继续填入。</p>
      <button type="button" className="l-btn" onClick=${act.loggedIn}>模拟：已在网页中登录</button></div>` : html`
    <div style=${{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18, opacity: s.web === 'loading' ? .5 : 1 }}>
      <div className="l-skel" style=${{ width: '62%' }}></div><div className="l-skel" style=${{ width: '88%' }}></div>
      <div className="l-skel" style=${{ width: '74%' }}></div><div className="l-skel" style=${{ width: '40%' }}></div>
    </div>
    <div className=${'l-web-input' + (filled ? ' filled' : '')}>
      ${filled ? html`<div className="l-skel" style=${{ width: '96%' }}></div><div className="l-skel" style=${{ width: '92%' }}></div><div className="l-skel" style=${{ width: '81%' }}></div>`
        : html`<div className="l-skel" style=${{ width: '34%', background: '#E8E6DC' }}></div>`}
      <span>网页自己的输入框</span>
    </div>`}
  </div>`;
}

function Launcher({ s, act }) {
  return html`<${Fragment}>
    <div className="l-launch l-surface-enter">
      <div style=${{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1 className="l-hero">随手<span className="l-hero-loop"><svg viewBox="0 0 220 80" preserveAspectRatio="none" aria-hidden="true"><path d="M30 44 C28 18 110 6 180 16 C214 22 216 56 170 66 C110 78 36 72 22 50 C14 36 40 22 70 20" /></svg><span style=${{ position: 'relative' }}>问一句</span></span>，<br />再回到手上的事。</h1>
        <p className="l-sub">在任意应用里选中文字，附近会出现动作条。没有选区，就从这里开始。</p>
      </div>
      <section>
        <h2 className="l-label">新任务</h2>
        <div className="l-targets">
          ${TARGET_IDS.map(id => html`<button type="button" key=${id} className="l-target" onClick=${() => act.newTask(id)}>
            <span className="l-target-name"><${Badge} target=${id} />${TARGETS[id].label}${id === 'chatgpt' && html`<em>上次使用</em>`}</span>
            <small className=${TARGETS[id].local ? 'mono' : ''} style=${TARGETS[id].local ? { fontSize: 11 } : null}>${TARGETS[id].local ? '本地 CLI · ~' : '网页 · 已登录'}</small>
          </button>`)}
        </div>
      </section>
      <section>
        <h2 className="l-label">不需要选区的预设</h2>
        <div className="l-list">
          ${s.presets.filter(p => p.enabled && !p.needsSelection).map(p => html`<button type="button" key=${p.id} className="l-list-row" onClick=${() => act.runPreset(p)}>
            ${p.name}<small>${TARGETS[p.target].label} · ${p.mode === 'edit' ? '先编辑' : '直接发送'}</small><span style=${{ color: 'var(--ink-4)', display: 'flex' }}><${Icon} n="chevR" s="s" /></span></button>`)}
        </div>
      </section>
    </div>
    <footer className="l-launch-foot">
      <button type="button" className="l-ghost dashed" onClick=${act.openImage}><${Icon} n="image" s="s" />粘贴图片<span className="l-kbd">⌘V</span></button>
      <button type="button" className="l-ghost" onClick=${() => act.toast('截图覆盖层见本页「截图」一节')}><${Icon} n="scan" s="s" />截图</button>
      <span className="l-hint">从菜单栏随时打开</span>
    </footer>
  </${Fragment}>`;
}

/* ───────── Command palette ───────── */
function Palette({ s, act }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [targets, setTargets] = useState({});
  const list = useRef(null);
  const scope = s.palette;
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = text => !q || text.toLowerCase().includes(q);
    const out = [];
    if (scope === 'all') {
      const presets = s.presets.filter(p => p.enabled && match(p.name)).map(p => ({ key: 'p-' + p.id, kind: 'preset', preset: p, label: p.name, disabled: p.needsSelection && !s.selection }));
      if (presets.length) out.push({ title: '预设', rows: presets });
    }
    if (scope === 'all' || scope === 'tasks') {
      const tasks = s.tasks.filter(t => (scope === 'tasks' || t.id !== s.activeId) && match(t.title)).map(t => ({ key: 'task-' + t.id, kind: 'task', task: t, label: t.title }));
      if (tasks.length) out.push({ title: scope === 'tasks' ? '全部任务' : '切换任务', rows: tasks });
    }
    if (scope === 'all' || scope === 'new') {
      const rows = TARGET_IDS.map(id => ({ key: 'new-' + id, kind: 'new', target: id, label: TARGETS[id].label + ' 新对话' }))
        .concat(['codex', 'pi'].map(id => ({ key: 'cwd-' + id, kind: 'new', target: id, cwd: true, label: TARGETS[id].label + ' · 选择工作目录…' }))).filter(r => match(r.label));
      if (rows.length) out.push({ title: '新任务', rows });
    }
    if (scope === 'all') {
      const rows = [
        { key: 'shot', kind: 'cmd', icon: 'scan', label: '截图', run: () => act.toast('截图覆盖层见本页「截图」一节') },
        { key: 'clip', kind: 'cmd', icon: 'image', label: '使用剪贴板图片', run: act.openImage },
        { key: 'pin', kind: 'cmd', icon: 'pin', label: s.pinned ? '取消置顶' : '置顶小窗', run: act.pin },
        { key: 'reload', kind: 'cmd', icon: 'retry', label: '重新加载网页', run: act.reload },
        { key: 'expand', kind: 'cmd', icon: 'expand', label: '放大到工作区', hint: '双击标题栏', run: () => act.toast('放大到当前显示器工作区') },
        { key: 'hide', kind: 'cmd', icon: 'minus', label: '隐藏小窗', hint: '⌘W', run: act.hide },
        { key: 'settings', kind: 'cmd', icon: 'sliders', label: '设置…', hint: '⌘,', run: () => act.settings('general') },
      ].filter(r => match(r.label));
      if (rows.length) out.push({ title: '图片与窗口', rows });
    }
    return out;
  }, [query, scope, s.presets, s.tasks, s.activeId, s.pinned, s.selection]);
  const flat = groups.flatMap(g => g.rows).filter(r => !r.disabled);
  const current = flat[Math.min(index, flat.length - 1)];
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const targetOf = p => targets[p.id] || p.target;
  function run(row) {
    if (!row || row.disabled) return;
    if (row.kind === 'preset') act.runPreset(row.preset, targetOf(row.preset));
    else if (row.kind === 'task') act.select(row.task.id);
    else if (row.kind === 'new') act.newTask(row.target, row.cwd);
    else row.run();
    if (row.kind !== 'cmd' || row.key !== 'pin') act.palette(null);
  }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); act.palette(null); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % Math.max(1, flat.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(current); }
    else if (e.key === 'Tab' && current?.kind === 'preset') {
      e.preventDefault();
      const p = current.preset, at = TARGET_IDS.indexOf(targetOf(p));
      setTargets({ ...targets, [p.id]: TARGET_IDS[(at + (e.shiftKey ? TARGET_IDS.length - 1 : 1)) % TARGET_IDS.length] });
    }
  }
  return html`<${Fragment}>
    <div className="l-scrim" onClick=${() => act.palette(null)}></div>
    <div className="l-palette" role="dialog" aria-label="指令面板">
      <label className="l-pal-search"><${Icon} n="search" />
        <input id="palette-search" autoFocus=${true} aria-label="搜索预设、任务或指令" placeholder=${scope === 'tasks' ? '搜索任务' : scope === 'new' ? '选择新任务的目标' : '搜索预设、任务或指令'} value=${query} onChange=${e => setQuery(e.target.value)} onKeyDown=${key} />
        <span className="l-keycap">esc</span></label>
      ${scope === 'all' && html`<div className="l-pal-ctx">${s.selection ? html`<span className="l-mark">已选 <span className="mono">1,284</span> 字</span><span>来自 Safari · 已匹配应用背景</span>`
        : html`<span>没有选区 · 需要选区的预设暂不可用</span>`}</div>`}
      <div className="l-pal-list" ref=${list} role="listbox" aria-label="指令">
        ${groups.map(g => html`<${Fragment} key=${g.title}>
          <div className="l-pal-group">${g.title}</div>
          ${g.rows.map(r => {
            const selected = r === current;
            const p = r.preset;
            return html`<button type="button" key=${r.key} role="option" className="l-pal-row" aria-selected=${selected} disabled=${r.disabled} onMouseEnter=${() => !r.disabled && setIndex(flat.indexOf(r))} onClick=${() => run(r)}>
              ${r.kind === 'task' && html`<${StatusDot} activity=${r.task.activity} />`}
              ${(r.kind === 'task' || r.kind === 'new') && html`<${Badge} target=${r.kind === 'task' ? r.task.target : r.target} />`}
              ${r.kind === 'cmd' && html`<span style=${{ color: 'var(--ink-3)', display: 'flex' }}><${Icon} n=${r.icon} s="s" /></span>`}
              <span>${r.label}</span>
              ${r.kind === 'preset' && (selected ? html`<span className=${'l-pal-target push' + (targetOf(p) !== p.target ? ' changed' : '')}>${TARGETS[targetOf(p)].label}<kbd>⇥</kbd></span>`
                : html`<small className="push">${TARGETS[targetOf(p)].label}</small>`)}
              ${r.kind === 'preset' && html`<small>${r.disabled ? '需要选区' : targetOf(p) !== p.target && (p.model || p.effort) ? '跟随目标默认' : p.mode === 'edit' ? '先编辑' : '直接发送'}</small>`}
              ${r.kind === 'task' && html`<small className="push">${ACTIVITY[r.task.activity]}</small>`}
              ${r.hint && html`<small className="push mono">${r.hint}</small>`}
              ${selected && html`<span className=${'l-kbd' + (r.kind === 'preset' || r.kind === 'task' || r.hint ? '' : ' push')}>↵</span>`}
            </button>`;
          })}
        </${Fragment}>`)}
        ${!flat.length && html`<p className="l-pal-empty">没有匹配「${query}」的预设或指令。</p>`}
      </div>
      <div className="l-pal-foot"><span><span className="mono">↑↓</span> 选择</span><span><span className="mono">↵</span> 运行</span>${scope === 'all' && html`<span><span className="mono">⇥</span> 临时换目标</span>`}<span style=${{ marginLeft: 'auto' }}><span className="mono">⌘,</span> 设置</span></div>
    </div>
  </${Fragment}>`;
}

/* ───────── Local CLI chat ───────── */
const ANSWER = '要同时满足四个条件才会释放：\n- 在后台闲置满 10 分钟；\n- 状态明确为已完成；\n- 没有草稿、附件或待确认操作；\n- 有可恢复的原链接。\n释放前会开一个隐藏页核对历史与最新回答，核对失败就保留原页面。要我跑一遍类型检查确认改动吗？';
function Answer({ text, streaming }) {
  const lines = text.split('\n');
  const blocks = [];
  lines.forEach(line => {
    if (line.startsWith('- ')) { const last = blocks[blocks.length - 1]; if (last && last.list) last.items.push(line.slice(2)); else blocks.push({ list: true, items: [line.slice(2)] }); }
    else if (line) blocks.push({ text: line });
  });
  return html`<article className="l-answer">${blocks.map((b, i) => b.list ? html`<ul key=${i}>${b.items.map((item, j) => html`<li key=${j}>${item}</li>`)}</ul>` : html`<p key=${i}>${b.text}${streaming && i === blocks.length - 1 && html`<span className="l-caret"></span>`}</p>`)}</article>`;
}
function initialChat(kind, task) {
  if (kind === 'empty') return { messages: [], request: null, activity: 'idle', error: null };
  if (kind === 'error') return { messages: [{ id: 'u1', role: 'user', text: '把 dotfiles 里重复的 alias 合并一下' }, { id: 'a1', role: 'assistant', text: '我先列出了 4 处重复定义，合并前想确认保留哪一份 `ll`。' }], request: null, activity: 'complete', error: 'Pi 进程已在后台释放。发送下一条时会按原会话恢复，不会重发之前的内容。', released: true };
  if (kind === 'preset') return { messages: [{ id: 'u1', role: 'user', text: task.prompt }], request: null, activity: 'running', stream: '已读取选区。这段话的意思是：同一个幂等键代表同一次下单意图，服务端据此只创建一笔订单。', streamed: '' };
  return {
    messages: [
      { id: 'u1', role: 'user', text: 'TaskManager 什么时候会释放后台网页任务？' },
      { id: 'l1', role: 'ledger', title: '读取了 2 个文件', items: ['src/main/tasks.ts', 'src/main/task-policy.ts'] },
      { id: 'a1', role: 'assistant', text: ANSWER },
    ],
    request: { id: 'r1', kind: 'confirm', title: 'Codex 请求运行命令', command: 'npm run typecheck', cwd: '~/WorkSpace/Code/Github/lasso' },
    activity: 'waiting', error: null,
  };
}
function Chat({ task, kind, act }) {
  const [c, setC] = useState(() => initialChat(kind, task));
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState({ l1: true });
  const [model, setModel] = useState('默认模型');
  const [effort, setEffort] = useState('中');
  const [image, setImage] = useState(false);
  const box = useRef(null);
  const busy = c.activity === 'running' || c.activity === 'waiting';
  useEffect(() => { act.activity(task.id, c.activity === 'idle' ? 'idle' : c.activity); }, [c.activity]);
  useEffect(() => { box.current && (box.current.scrollTop = box.current.scrollHeight); }, [c, open]);
  useEffect(() => {
    if (c.activity !== 'running' || c.stream == null) return;
    if (c.streamed.length >= c.stream.length) {
      setC(old => ({ ...old, activity: 'complete', messages: [...old.messages, { id: 'a' + Date.now(), role: 'assistant', text: old.stream }], stream: null, streamed: '' }));
      return;
    }
    const timer = setTimeout(() => setC(old => old.stream == null ? old : ({ ...old, streamed: old.stream.slice(0, old.streamed.length + 3) })), 32);
    return () => clearTimeout(timer);
  }, [c]);
  function send() {
    if (busy || (!draft.trim() && !image)) return;
    const text = draft.trim() || '看看这张截图里的报错';
    setDraft(''); setImage(false);
    setC(old => ({ ...old, error: null, released: false, activity: 'running',
      messages: [...old.messages, { id: 'u' + Date.now(), role: 'user', text, image }, { id: 'l' + Date.now(), role: 'ledger', title: '读取了 1 个文件', items: ['src/main/tasks.ts'] }],
      stream: '收到。我会先看 `tasks.ts` 里的回收门槛，再回答。门槛集中在 `release()` 之前的检查里，生成中、等待审批和含草稿的任务都不会被释放。', streamed: '' }));
  }
  function answer(allow) {
    setC(old => ({ ...old, request: null, activity: 'running',
      messages: [...old.messages, { id: 'd' + Date.now(), role: 'decision', text: (allow ? '已允许一次 · ' : '已拒绝 · ') + old.request.command },
        ...(allow ? [{ id: 'l' + Date.now(), role: 'ledger', title: '运行了 1 条命令', items: ['npm run typecheck · 退出码 0'] }] : [])],
      stream: allow ? '类型检查通过，没有新增错误。' : '好的，不运行命令。如果需要，你可以稍后在终端里自己执行 `npm run typecheck`。', streamed: '' }));
  }
  function stop() { setC(old => ({ ...old, activity: 'complete', request: null, stream: null, streamed: '', messages: [...old.messages, ...(old.streamed ? [{ id: 'a' + Date.now(), role: 'assistant', text: old.streamed }] : []), { id: 'n' + Date.now(), role: 'notice', text: '已停止。' }] })); }
  const name = TARGETS[task.target].label;
  return html`<div className="l-chat l-surface-enter">
    <div className="l-msgs" ref=${box}>
      ${!c.messages.length && html`<div className="l-welcome"><h2>在这里接着聊。</h2><p>沿用 ${name} 的登录、模型、MCP 与权限设置。工作目录：<span className="mono" style=${{ fontSize: 12 }}>~</span>。</p>
        ${task.target === 'pi' && html`<p style=${{ fontSize: 12.5 }}>Pi 的终端专属扩展界面不会出现在小窗里。</p>`}</div>`}
      ${c.messages.map(m => m.role === 'user' ? html`<div key=${m.id} style=${{ alignSelf: 'flex-end', maxWidth: '82%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          ${m.image && html`<div className="l-thumb"><div></div></div>`}<p className="l-user" style=${{ maxWidth: '100%' }}>${m.text}</p></div>`
        : m.role === 'ledger' ? html`<div className="l-ledger" key=${m.id}>
          <button type="button" aria-expanded=${Boolean(open[m.id])} onClick=${() => setOpen({ ...open, [m.id]: !open[m.id] })}><${Icon} n="chevD" s="xs" />${m.title}</button>
          ${open[m.id] && html`<ul>${m.items.map(item => html`<li key=${item}><span className="ok"><${Icon} n="check" s="xs" /></span><span>${item}</span></li>`)}</ul>`}</div>`
        : m.role === 'decision' ? html`<div className="l-req done" key=${m.id}><${Icon} n="terminal" s="s" /><span className="mono" style=${{ fontSize: 12 }}>${m.text}</span></div>`
        : m.role === 'notice' ? html`<p className="l-notice-msg" key=${m.id}>${m.text}</p>`
        : html`<${Answer} key=${m.id} text=${m.text} />`)}
      ${c.stream != null && html`<${Answer} text=${c.streamed || '…'} streaming=${true} />`}
      ${c.request && html`<section className="l-req" aria-label="审批请求">
        <div className="l-req-head"><${Icon} n="terminal" s="s" /><span>${c.request.title}</span><span className="l-req-state"><span className="dot waiting"></span>等待你</span></div>
        <div className="l-req-body"><div className="l-req-code"><code>${c.request.command}</code><span>${c.request.cwd}</span></div></div>
        <div className="l-req-actions"><button type="button" className="l-btn primary" onClick=${() => answer(true)}>允许这一次</button><button type="button" className="l-btn" onClick=${() => answer(false)}>拒绝</button></div>
      </section>`}
    </div>
    ${c.error && html`<div className="l-banner" role="alert"><${Icon} n="alert" s="s" /><span>${c.error}</span>${c.released && html`<button type="button" className="l-text-btn" onClick=${() => setC(old => ({ ...old, error: null, released: false }))}>立即恢复</button>`}</div>`}
    <form className="l-composer" onSubmit=${e => { e.preventDefault(); send(); }}>
      ${image && html`<div className="l-thumb"><div></div><button type="button" aria-label="移除图片" onClick=${() => setImage(false)}><${Icon} n="x" s="xs" /></button></div>`}
      <textarea id=${'composer-' + task.id} aria-label=${'发送给 ' + name} rows="2" value=${draft} placeholder=${busy ? '可以先写下一条，任务结束后发送…' : '问一句，或粘贴一张截图…'}
        onChange=${e => setDraft(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}></textarea>
      <div className="l-composer-row">
        <button type="button" className="l-chip mono" title="工作目录 · 新任务可在 ⌘K 里选择"><${Icon} n="folder" s="xs" />lasso</button>
        <label className="l-chip" style=${{ position: 'relative' }}>${model}<${Icon} n="chevD" s="xs" />
          <select aria-label="模型" disabled=${busy} value=${model} onChange=${e => setModel(e.target.value)} style=${{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}>
            <option>默认模型</option><option>示例模型 A</option><option>示例模型 B</option></select></label>
        <label className="l-chip" style=${{ position: 'relative' }}>强度 · ${effort}<${Icon} n="chevD" s="xs" />
          <select aria-label="思考强度" disabled=${busy} value=${effort} onChange=${e => setEffort(e.target.value)} style=${{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}>
            <option>低</option><option>中</option><option>高</option></select></label>
        <button type="button" className="l-icon" style=${{ marginLeft: 'auto' }} aria-label="使用剪贴板图片" disabled=${busy} onClick=${() => setImage(true)}><${Icon} n="image" /></button>
        ${busy ? html`<button type="button" className="l-stop" onClick=${stop}><i></i>停止</button>`
          : html`<button type="submit" className="l-send" aria-label="发送 ⌘↵" disabled=${!draft.trim() && !image}><${Icon} n="up" /></button>`}
      </div>
    </form>
  </div>`;
}

/* ───────── Image entry ───────── */
function ImageEntry({ s, act }) {
  const [target, setTarget] = useState('');
  return html`<div className="l-image l-surface-enter">
    <div style=${{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style=${{ fontSize: 12, color: 'var(--ink-3)' }}>来自截图 · 刚刚</span><h2>这张图，想问什么？</h2></div>
    <figure style=${{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="l-print"><div className="l-shot" role="img" aria-label="截图预览：一段聊天消息"><div><i></i><b style=${{ width: 210 }}></b></div><div><b style=${{ width: 170 }}></b><i style=${{ background: '#B9C7D9' }}></i></div></div></div>
      <figcaption style=${{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
        <span className="mono" style=${{ fontSize: 11 }}>1788 × 693 px · 原尺寸发送</span>
        <button type="button" className="l-text-btn" style=${{ marginLeft: 'auto', fontSize: 13 }} onClick=${() => act.toast('已从剪贴板重新读取')}>替换</button>
        <button type="button" className="l-text-btn" style=${{ fontSize: 13 }} onClick=${act.removeImage}>移除</button>
      </figcaption>
    </figure>
    <div className="l-seg" role="radiogroup" aria-label="发送到" style=${{ alignSelf: 'flex-start' }}>
      ${[['', '沿用预设目标'], ...TARGET_IDS.map(id => [id, TARGETS[id].label])].map(([id, label]) => html`<button type="button" role="radio" key=${id || 'preset'} aria-checked=${target === id} onClick=${() => setTarget(id)}>${label}</button>`)}
    </div>
    <div className="l-list">
      ${s.presets.filter(p => p.enabled).map(p => html`<button type="button" key=${p.id} className="l-list-row" onClick=${() => act.runPreset(p, target || p.target, true)}>
        ${p.name}<small>${TARGETS[target || p.target].label} · ${p.mode === 'edit' ? '先编辑' : '直接发送'}</small><span style=${{ color: 'var(--ink-4)', display: 'flex' }}><${Icon} n="chevR" s="s" /></span></button>`)}
    </div>
  </div>`;
}

/* ───────── Settings ───────── */
function PresetList({ presets, setPresets, edit }) {
  const drag = useRef(null);
  let enabledCount = 0;
  const bar = [], more = [];
  presets.forEach(p => { if (p.enabled && enabledCount < 4) { enabledCount++; bar.push(p); } else more.push(p); });
  function drop(id) {
    const from = presets.findIndex(p => p.id === drag.current), to = presets.findIndex(p => p.id === id);
    if (from < 0 || from === to) return;
    const next = [...presets]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); setPresets(next);
  }
  const row = p => html`<li key=${p.id} draggable="true" onDragStart=${() => { drag.current = p.id; }} onDragOver=${e => e.preventDefault()} onDrop=${() => drop(p.id)} style=${{ opacity: p.enabled ? 1 : .55 }}>
    <span className="l-grip" aria-hidden="true"><${Icon} n="grip" s="s" /></span>
    <button type="button" className="l-preset" onClick=${() => edit(p.id)}>
      <strong>${p.name}${!p.needsSelection && html`<span className="tag">无需选区</span>`}${!p.enabled && html`<span className="tag">已停用</span>`}</strong>
      <span>${preview(p.template).map((part, i) => html`<${Fragment} key=${i}>${i > 0 && html`<span className="l-placeholder-chip">选区</span>`}${part}</${Fragment}>`)}</span>
    </button>
    <span className="l-row-meta">${TARGETS[p.target].label} · ${p.mode === 'edit' ? '先编辑' : '直接发送'}</span>
    <button type="button" className="l-switch" role="switch" aria-checked=${p.enabled} aria-label=${'启用' + p.name} onClick=${() => setPresets(presets.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x))}><span></span></button>
  </li>`;
  return html`<${Fragment}>
    <div className="l-set-row-head"><h3>动作条 · 前 4 个</h3><span>拖动调整顺序，点开编辑</span></div>
    <ul className="l-group">${bar.map(row)}</ul>
    <div className="l-set-row-head" style=${{ marginTop: 10 }}><h3>更多菜单</h3><span>动作条「···」与指令面板</span></div>
    <ul className="l-group">${more.map(row)}</ul>
    <button type="button" className="l-add" onClick=${() => { const p = { id: 'p' + Date.now(), name: '新预设', template: '{{selection}}', target: 'chatgpt', mode: 'edit', needsSelection: true, enabled: true }; setPresets([...presets, p]); edit(p.id); }}><${Icon} n="plus" s="s" />新建预设</button>
  </${Fragment}>`;
}
function PresetEditor({ preset, save, remove, back }) {
  const [p, setP] = useState(preset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const area = useRef(null);
  const dirty = JSON.stringify(p) !== JSON.stringify(preset);
  const set = change => { setP({ ...p, ...change }); setSaved(false); };
  function insert() {
    const el = area.current, at = el.selectionStart;
    set({ template: p.template.slice(0, at) + '{{selection}}' + p.template.slice(el.selectionEnd) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at + 13, at + 13); });
  }
  return html`<${Fragment}>
    <div className="l-set-body l-surface-enter" style=${{ gap: 16 }}>
      <button type="button" className="l-text-btn" style=${{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 2, marginLeft: -8 }} onClick=${back}><${Icon} n="chevL" s="s" />全部预设</button>
      <div className="l-field"><label htmlFor="preset-name">名称</label><input id="preset-name" className="l-input" value=${p.name} onChange=${e => set({ name: e.target.value })} /></div>
      <div className="l-field">
        <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><label htmlFor="preset-template" className="l-field-label">提示词</label>
          <button type="button" className="l-btn small" onClick=${insert}>插入选区位置</button></div>
        <textarea id="preset-template" ref=${area} className="l-textarea" rows="6" value=${p.template} onChange=${e => set({ template: e.target.value })} spellCheck=${false}></textarea>
        <p className="l-field-help"><span className="mono">{{selection}}</span> 处放选中文字；没有这个位置时，选中文字附在末尾。应用背景会放在最前面。</p>
      </div>
      <div className="l-field"><span className="l-field-label">目标</span>
        <div className="l-seg" role="radiogroup" aria-label="目标">${TARGET_IDS.map(id => html`<button type="button" role="radio" key=${id} aria-checked=${p.target === id} onClick=${() => set({ target: id, model: '', effort: '' })}>${TARGETS[id].label}</button>`)}</div></div>
      <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <div className="l-field"><label htmlFor="preset-model">模型</label><select id="preset-model" className="l-select" value=${p.model || ''} onChange=${e => set({ model: e.target.value, effort: '' })}><option value="">跟随目标默认</option><option>示例模型</option><option>示例模型 Pro</option></select></div>
        <div className="l-field"><label htmlFor="preset-effort">思考强度</label><select id="preset-effort" className="l-select" value=${p.effort || ''} onChange=${e => set({ effort: e.target.value })}><option value="">跟随目标默认</option><option>标准</option><option>深度</option></select></div>
      </div>
      <p className="l-field-help" style=${{ marginTop: -8 }}>${TARGETS[p.target].local ? '选项读取自本机 CLI，不修改 CLI 全局配置。' : '选项读取自当前登录的网页；网站没有独立思考选项时沿用默认。'} <button type="button" className="l-text-btn" style=${{ height: 'auto', padding: 0, fontSize: 12, textDecoration: 'underline' }}>刷新选项</button></p>
      <div className="l-field"><span className="l-field-label">执行方式</span>
        <div className="l-seg" role="radiogroup" aria-label="执行方式">
          <button type="button" role="radio" aria-checked=${p.mode === 'edit'} onClick=${() => set({ mode: 'edit' })}>先填入，再编辑</button>
          <button type="button" role="radio" aria-checked=${p.mode === 'send'} onClick=${() => set({ mode: 'send' })}>填入后直接发送</button></div></div>
      <ul className="l-group">
        <li><div className="l-row-label"><span>需要内容</span><span>没有选中文字或图片时，这个预设不可用</span></div><button type="button" className="l-switch" role="switch" aria-checked=${p.needsSelection} aria-label="需要内容" onClick=${() => set({ needsSelection: !p.needsSelection })}><span></span></button></li>
        <li><div className="l-row-label"><span>启用</span><span>停用后不出现在动作条和指令面板</span></div><button type="button" className="l-switch" role="switch" aria-checked=${p.enabled} aria-label="启用预设" onClick=${() => set({ enabled: !p.enabled })}><span></span></button></li>
      </ul>
      <button type="button" className="l-btn danger" style=${{ alignSelf: 'flex-start' }} onClick=${() => confirmDelete ? remove(p.id) : setConfirmDelete(true)}><${Icon} n="trash" s="s" />${confirmDelete ? '再点一次删除「' + p.name + '」' : '删除预设'}</button>
    </div>
    ${(dirty || saved) && html`<div className="l-save-bar">${saved ? html`<span className="l-ok"><${Icon} n="check" s="s" />已保存</span>` : '有未保存的更改'}
      <span className="push"></span>${dirty && html`<button type="button" className="l-btn small" onClick=${() => setP(preset)}>放弃</button><button type="button" className="l-btn small primary" disabled=${!p.name.trim() || !p.template.trim()} onClick=${() => { save(p); setSaved(true); }}>保存预设</button>`}</div>`}
  </${Fragment}>`;
}
function AppsSettings() {
  const [rules, setRules] = useState([{ name: 'Safari', bundleId: 'com.apple.Safari', prompt: '选中文字来自网页阅读，请先说明它在讲什么，再回答。', enabled: true }, { name: '钉钉', bundleId: 'com.alibaba.DingTalkMac', prompt: '选中文字来自工作沟通，请保留人物、日期和待办事项。', enabled: true }]);
  const set = (i, change) => setRules(rules.map((r, n) => n === i ? { ...r, ...change } : r));
  return html`<div className="l-set-body l-surface-enter">
    <p className="l-field-help" style=${{ fontSize: 13 }}>只给来自这个应用的划词补充背景，放在预设内容之前，只注入一次。没有选区、图片和后续追问不会注入。</p>
    ${rules.map((r, i) => html`<ul className="l-group" key=${i}><li className="col">
      <div style=${{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style=${{ width: 28, height: 28, borderRadius: 7, background: 'var(--sand)', display: 'grid', placeItems: 'center', fontSize: 13 }}>${r.name.slice(0, 1)}</span>
        <div className="l-row-label"><span>${r.name}</span><span className="mono" style=${{ fontSize: 11 }}>${r.bundleId}</span></div>
        <button type="button" className="l-switch" role="switch" aria-checked=${r.enabled} aria-label=${'启用 ' + r.name} onClick=${() => set(i, { enabled: !r.enabled })}><span></span></button>
      </div>
      <textarea id=${'app-prompt-' + i} className="l-textarea" style=${{ minHeight: 72 }} aria-label=${r.name + ' 的背景提示词'} value=${r.prompt} onChange=${e => set(i, { prompt: e.target.value })}></textarea>
      <button type="button" className="l-text-btn" style=${{ alignSelf: 'flex-end', color: 'var(--danger)' }} onClick=${() => setRules(rules.filter((_, n) => n !== i))}>删除</button>
    </li></ul>`)}
    <div style=${{ display: 'flex', gap: 8 }}><button type="button" className="l-btn" onClick=${() => setRules([...rules, { name: 'Xcode', bundleId: 'com.apple.dt.Xcode', prompt: '', enabled: true }])}>选择应用…</button><button type="button" className="l-btn" onClick=${() => setRules([...rules, { name: '未命名应用', bundleId: '', prompt: '', enabled: true }])}>手动填写 bundle ID</button></div>
  </div>`;
}
function LocalSettings() {
  const [paths, setPaths] = useState({ codex: '/opt/homebrew/bin/codex', pi: '' });
  return html`<div className="l-set-body l-surface-enter">
    ${['codex', 'pi'].map(id => html`<${Fragment} key=${id}>
      <div className="l-set-row-head"><h3>${TARGETS[id].label}</h3><span style=${{ display: 'flex', alignItems: 'center', gap: 6, color: paths[id] ? 'var(--olive)' : 'var(--danger)' }}>${paths[id] ? html`<${Icon} n="check" s="xs" />已找到` : html`<${Icon} n="alert" s="xs" />尚未选择可执行文件`}</span></div>
      <ul className="l-group"><li className="col">
        <div className="l-field"><label htmlFor=${'exec-' + id}>可执行文件（绝对路径）</label><div style=${{ display: 'flex', gap: 6 }}><input id=${'exec-' + id} className="l-input mono" value=${paths[id]} placeholder="/opt/homebrew/bin/pi" onChange=${e => setPaths({ ...paths, [id]: e.target.value })} /><button type="button" className="l-btn">选择…</button></div></div>
        <div className="l-field"><label htmlFor=${'cwd-' + id}>默认工作目录</label><div style=${{ display: 'flex', gap: 6 }}><input id=${'cwd-' + id} className="l-input mono" defaultValue="~" /><button type="button" className="l-btn">选择…</button></div></div>
      </li></ul>
    </${Fragment}>`)}
    <p className="l-field-help">沿用 CLI 自己的登录、模型、MCP、Skills 与扩展。GUI 不读取终端的 PATH，所以需要绝对路径。目录只影响新任务；单次任务可在指令面板里临时选择。</p>
  </div>`;
}
function ShortcutField({ id, label, help, initial }) {
  const [value, setValue] = useState(initial);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const show = v => v ? v.replace(/Command/g, '⌘').replace(/Control/g, '⌃').replace(/Alt|Option/g, '⌥').replace(/Shift/g, '⇧').replace(/\+/g, ' ') : '未绑定';
  function key(e) {
    if (!recording) return;
    e.preventDefault();
    if (e.key === 'Escape') { setRecording(false); return; }
    if (['Meta', 'Alt', 'Control', 'Shift'].includes(e.key)) return;
    const mods = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    if (!mods.length) { setError('需要加上 ⌘、⌥、⌃ 或 ⇧。'); return; }
    const k = e.code === 'Space' ? 'Space' : e.code.replace(/^(Key|Digit)/, '');
    const combo = [...mods, k].join('+');
    if (combo === 'Alt+Space') { setError('⌥ 空格 留给 Raycast，请换一组。'); return; }
    setValue(combo); setRecording(false); setError('');
  }
  return html`<li className="col">
    <div style=${{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div className="l-row-label"><span>${label}</span><span>${help}</span></div>
      <button type="button" id=${id} className=${'l-btn small' + (recording ? ' primary' : '')} onClick=${() => { setRecording(!recording); setError(''); }} onKeyDown=${key} onBlur=${() => setRecording(false)}>
        ${recording ? '请按快捷键…' : html`<span className="mono" style=${{ fontSize: 12 }}>${show(value)}</span>`}</button>
      ${value && !recording && html`<button type="button" className="l-icon" aria-label=${'取消绑定' + label} onClick=${() => setValue('')}><${Icon} n="x" s="s" /></button>`}
    </div>
    ${error && html`<p className="l-field-help" role="alert" style=${{ color: 'var(--danger)' }}>${error}</p>`}
  </li>`;
}
function GeneralSettings({ s, act }) {
  const [selection, setSelection] = useState(true);
  const [fallback, setFallback] = useState(false);
  const resident = s.tasks.filter(t => t.activity !== 'released').length, released = s.tasks.length - resident;
  return html`<div className="l-set-body l-surface-enter">
    <div className="l-set-row-head"><h3>划词</h3></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>划词动作条</span><span style=${{ display: 'flex', alignItems: 'center', gap: 6 }}>${selection ? html`<span className="dot complete"></span>辅助功能已授权 · 正在监听` : html`<span className="dot released"></span>已暂停`}</span></div>
        <button type="button" className="l-switch" role="switch" aria-checked=${selection} aria-label="划词动作条" onClick=${() => setSelection(!selection)}><span></span></button></li>
      <li><div className="l-row-label"><span>允许模拟复制取词</span><span>只在辅助功能取不到文字时模拟 ⌘C，可能改动剪贴板。</span></div>
        <button type="button" className="l-switch" role="switch" aria-checked=${fallback} aria-label="允许模拟复制取词" onClick=${() => setFallback(!fallback)}><span></span></button></li>
    </ul>
    <div className="l-set-row-head" style=${{ marginTop: 10 }}><h3>快捷键</h3><span>默认不绑定</span></div>
    <ul className="l-group">
      <${ShortcutField} id="shortcut-open" label="唤起小窗" help="有选区时同时打开指令面板" initial="" />
      <${ShortcutField} id="shortcut-shot" label="截图" help="选择窗口、消息或任意区域" initial="Control+Shift+A" />
    </ul>
    <div className="l-set-row-head" style=${{ marginTop: 10 }}><h3>窗口与任务</h3></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>始终置顶</span><span>未置顶时，点击窗外会隐藏小窗；任务继续在后台运行。</span></div>
        <button type="button" className="l-switch" role="switch" aria-checked=${s.pinned} aria-label="始终置顶" onClick=${act.pin}><span></span></button></li>
      <li><div className="l-row-label"><span>${resident} 个驻留 · ${released} 个已释放</span><span>后台闲置 10 分钟，只释放已完成、无草稿且能按原链接或原会话恢复的任务。</span></div></li>
    </ul>
    <button type="button" className="l-btn danger" style=${{ alignSelf: 'flex-start', marginTop: 6 }} onClick=${() => act.toast('（系统对话框）退出 Lasso？本次 ' + s.tasks.length + ' 个任务会关闭')}>退出 Lasso</button>
  </div>`;
}
function Settings({ s, act, fontProps }) {
  const tabs = [['presets', '预设'], ['apps', '应用背景'], ['local', '本地 CLI'], ['general', '通用'], ['appearance', '外观']];
  const editing = s.presets.find(p => p.id === s.editing);
  return html`<${Fragment}>
    <header className="l-set-head">
      <button type="button" className="l-text-btn" style=${{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13 }} aria-label="返回任务" onClick=${act.closeSettings}><${Icon} n="chevL" />${s.tasks.length ? '任务' : '小窗'}</button>
      <h2>设置</h2><span className="l-kbd">⌘,</span>
    </header>
    <nav className="l-set-nav" aria-label="设置分类">${tabs.map(([id, label]) => html`<button type="button" key=${id} aria-current=${s.settingsTab === id ? 'page' : undefined} onClick=${() => act.settings(id)}>${label}</button>`)}</nav>
    ${s.settingsTab === 'presets' ? (editing ? html`<${PresetEditor} key=${editing.id} preset=${editing} back=${() => act.edit(null)} save=${p => act.setPresets(s.presets.map(x => x.id === p.id ? p : x))} remove=${id => { act.setPresets(s.presets.filter(x => x.id !== id)); act.edit(null); }} />`
        : html`<div className="l-set-body l-surface-enter"><${PresetList} presets=${s.presets} setPresets=${act.setPresets} edit=${act.edit} /></div>`)
      : s.settingsTab === 'apps' ? html`<${AppsSettings} />`
      : s.settingsTab === 'local' ? html`<${LocalSettings} />`
      : s.settingsTab === 'general' ? html`<${GeneralSettings} s=${s} act=${act} />`
      : html`<div className="l-set-body l-surface-enter"><${FontSettings} ...${fontProps} /></div>`}
  </${Fragment}>`;
}

/* ───────── Window (simulator) ───────── */
const STEP = { open: '打开', model: '模型', upload: '图片', fill: '填入', send: '发送', edit: '交给你' };
const STEP_MSG = { open: '正在打开新对话…', model: '正在应用预设模型与思考强度…', upload: '正在上传图片…', fill: '正在完整填入 14,208 字…', send: '正在发送…', edit: '已填入，请在网页中编辑并发送' };
function plan(preset, image) {
  const ids = ['open', preset.model || preset.effort ? 'model' : null, image ? 'upload' : null, 'fill', preset.mode === 'send' ? 'send' : 'edit'].filter(Boolean);
  return ids.map(id => ({ id, label: STEP[id] }));
}
const SCENES = [
  ['小窗', [['launcher', '启动台 · 没有任务'], ['web', '网页任务'], ['delivering', '投递中 · 直接发送'], ['editing', '先编辑 · 已填入'], ['login', '等待网页登录'], ['failed', '投递失败'], ['restoring', '恢复已释放任务'], ['pageError', '网页加载失败'], ['notice', '截图未能启动'], ['closing', '关闭进行中的任务']]],
  ['指令', [['palette', '⌘K · 有选区'], ['paletteNone', '⌘K · 没有选区'], ['paletteTasks', '+N · 全部任务']]],
  ['本地 CLI', [['chat', '对话 · 等待审批'], ['chatEmpty', '新对话'], ['chatReleased', '已释放 · 待恢复']]],
  ['图片', [['image', '待处理图片']]],
  ['设置', [['setPresets', '预设列表'], ['setEdit', '编辑预设'], ['setApps', '应用背景'], ['setLocal', '本地 CLI'], ['setGeneral', '通用'], ['setAppearance', '外观 · 字体']]],
];
function scene(id, presets) {
  const s = { scene: id, view: 'task', tasks: clone(BASE_TASKS), activeId: 't1', pinned: false, palette: null, settingsTab: 'presets', editing: null, delivery: null, notice: null, web: 'ready', image: false, selection: true, chat: 'approval', hidden: false, dialog: null, presets };
  const running = (preset, extra = {}) => { const t = { id: 't0', target: preset.target, title: preset.name + '：幂等键', activity: 'loading' }; return { ...s, tasks: [t, ...s.tasks.slice(0, 3)], activeId: 't0', delivery: { steps: plan(preset), at: 0, state: 'run', auto: true, mode: preset.mode, message: STEP_MSG.open }, ...extra }; };
  switch (id) {
    case 'launcher': return { ...s, view: 'launcher', tasks: [], activeId: null };
    case 'delivering': return running(presets[2]);
    case 'editing': { const r = running(presets[0]); return { ...r, tasks: r.tasks.map(t => t.id === 't0' ? { ...t, activity: 'draft' } : t), delivery: { ...r.delivery, auto: false, state: 'editing', at: r.delivery.steps.length - 1, message: STEP_MSG.edit } }; }
    case 'login': { const r = running(presets[1]); return { ...r, web: 'login', tasks: r.tasks.map(t => t.id === 't0' ? { ...t, activity: 'waiting' } : t), delivery: { ...r.delivery, auto: false, state: 'login', message: '请先在网页中登录，登录后自动继续' } }; }
    case 'failed': { const r = running(presets[1]); return { ...r, tasks: r.tasks.map(t => t.id === 't0' ? { ...t, activity: 'error' } : t), delivery: { ...r.delivery, auto: false, state: 'fail', at: 1, message: '网页输入框没有就绪，内容未发送，原文已保留' } }; }
    case 'restoring': return { ...s, activeId: 't4', delivery: { kind: 'restore' } };
    case 'pageError': return { ...s, web: 'error', tasks: s.tasks.map(t => t.id === 't1' ? { ...t, activity: 'error' } : t) };
    case 'notice': return { ...s, notice: { message: '截图未能启动：需要屏幕录制权限', action: '打开系统设置' } };
    case 'closing': return { ...s, activeId: 't3', view: 'chat', dialog: 't3' };
    case 'palette': return { ...s, palette: 'all' };
    case 'paletteNone': return { ...s, palette: 'all', selection: false };
    case 'paletteTasks': return { ...s, palette: 'tasks' };
    case 'chat': return { ...s, activeId: 't3', view: 'chat', chat: 'approval' };
    case 'chatEmpty': { const t = { id: 't0', target: 'codex', title: '新对话', activity: 'idle' }; return { ...s, tasks: [t, ...s.tasks], activeId: 't0', view: 'chat', chat: 'empty' }; }
    case 'chatReleased': return { ...s, activeId: 't5', view: 'chat', chat: 'error' };
    case 'image': return { ...s, view: 'image', image: true };
    case 'setPresets': return { ...s, view: 'settings', settingsTab: 'presets' };
    case 'setEdit': return { ...s, view: 'settings', settingsTab: 'presets', editing: 'summarize' };
    case 'setApps': return { ...s, view: 'settings', settingsTab: 'apps' };
    case 'setLocal': return { ...s, view: 'settings', settingsTab: 'local' };
    case 'setGeneral': return { ...s, view: 'settings', settingsTab: 'general' };
    case 'setAppearance': return { ...s, view: 'settings', settingsTab: 'appearance' };
    default: return s;
  }
}

function Simulator({ fontProps, onScene }) {
  const [s, setS] = useState(() => scene('web', clone(DEFAULT_PRESETS)));
  const [toast, setToast] = useState('');
  const [chatKey, setChatKey] = useState(0);
  const patch = change => setS(old => ({ ...old, ...(typeof change === 'function' ? change(old) : change) }));
  useEffect(() => { onScene(s.scene); }, [s.scene]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 1800); return () => clearTimeout(t); }, [toast]);
  // Delivery auto-advance, mirroring TaskManager phases.
  useEffect(() => {
    const d = s.delivery;
    if (!d) return;
    if (d.kind === 'restore') { const t = setTimeout(() => patch(old => ({ delivery: null, tasks: old.tasks.map(x => x.id === old.activeId ? { ...x, activity: 'complete' } : x) })), 1600); return () => clearTimeout(t); }
    if (d.state === 'sent') { const t = setTimeout(() => patch({ delivery: null }), 2600); return () => clearTimeout(t); }
    if (d.state !== 'run' || !d.auto) return;
    const t = setTimeout(() => patch(old => {
      const cur = old.delivery; if (!cur || cur.state !== 'run') return {};
      const at = cur.at + 1, step = cur.steps[at];
      if (!step) return {};
      if (step.id === 'edit') return { delivery: { ...cur, at, state: 'editing', message: STEP_MSG.edit }, tasks: old.tasks.map(x => x.id === old.activeId ? { ...x, activity: 'draft' } : x) };
      if (at === cur.steps.length - 1 && step.id === 'send') return { delivery: { ...cur, at, message: STEP_MSG.send }, tasks: old.tasks.map(x => x.id === old.activeId ? { ...x, activity: 'running' } : x), _finish: true };
      return { delivery: { ...cur, at, message: STEP_MSG[step.id] } };
    }), d.at === 0 ? 700 : 900);
    return () => clearTimeout(t);
  }, [s.delivery]);
  useEffect(() => {
    if (!s._finish) return;
    const t = setTimeout(() => patch(old => ({ _finish: false, delivery: old.delivery && { ...old.delivery, state: 'sent', message: '已发送，可在网页继续追问' } })), 700);
    return () => clearTimeout(t);
  }, [s._finish]);
  const active = s.tasks.find(t => t.id === s.activeId);
  const act = {
    toast: setToast,
    view: view => patch({ view }),
    select: id => patch(old => {
      const t = old.tasks.find(x => x.id === id);
      const view = TARGETS[t.target].local ? 'chat' : 'task';
      if (t.activity === 'released') return { activeId: id, view, delivery: TARGETS[t.target].local ? null : { kind: 'restore' }, web: 'ready', palette: null };
      return { activeId: id, view, web: t.activity === 'error' ? 'error' : 'ready', delivery: old.activeId === id ? old.delivery : null, palette: null };
    }),
    close: id => patch(old => {
      const t = old.tasks.find(x => x.id === id);
      if (['running', 'waiting', 'draft', 'unknown', 'loading'].includes(t.activity) && old.dialog !== id) return { dialog: id };
      const tasks = old.tasks.filter(x => x.id !== id);
      const next = old.activeId === id ? tasks[0] : old.tasks.find(x => x.id === old.activeId);
      return { tasks, dialog: null, activeId: next ? next.id : null, view: !next ? (old.image ? 'image' : 'launcher') : old.activeId === id ? (TARGETS[next.target].local ? 'chat' : 'task') : old.view, delivery: old.activeId === id ? null : old.delivery };
    }),
    pin: () => patch(old => ({ pinned: !old.pinned })),
    palette: scope => patch({ palette: scope }),
    newTask: (target, cwd) => { const id = newId(); setChatKey(k => k + 1); patch(old => ({ tasks: [{ id, target, title: '新对话', activity: 'idle' }, ...old.tasks], activeId: id, view: TARGETS[target].local ? 'chat' : 'task', chat: 'empty', delivery: null, web: 'loading', palette: null })); if (cwd) setToast('（系统对话框）选择工作目录'); setTimeout(() => patch({ web: 'ready' }), 900); },
    runPreset: (preset, target = preset.target, image = false) => {
      const id = newId(); setChatKey(k => k + 1);
      const local = TARGETS[target].local;
      const p = target === preset.target ? preset : { ...preset, target, model: '', effort: '' };
      patch(old => ({ tasks: [{ id, target, title: preset.name + (old.selection && !image ? '：幂等键' : image ? '：截图' : ''), activity: local ? 'running' : 'loading', prompt: preset.name + '：同一个幂等键…' }, ...old.tasks], activeId: id, palette: null,
        image: image ? false : old.image, view: local ? 'chat' : 'task', chat: 'preset', web: 'ready',
        delivery: local ? null : { steps: plan(p, image), at: 0, state: 'run', auto: true, mode: p.mode, message: STEP_MSG.open } }));
    },
    retry: () => patch(old => ({ delivery: { ...old.delivery, state: 'run', auto: true, message: STEP_MSG[old.delivery.steps[old.delivery.at].id] }, tasks: old.tasks.map(x => x.id === old.activeId ? { ...x, activity: 'loading' } : x) })),
    cancelDelivery: () => patch(old => ({ delivery: null, tasks: old.tasks.map(x => x.id === old.activeId && ['loading', 'error', 'waiting'].includes(x.activity) ? { ...x, activity: 'idle' } : x), web: old.web === 'login' ? 'ready' : old.web })),
    dismissDelivery: () => patch({ delivery: null }),
    loggedIn: () => patch(old => ({ web: 'ready', delivery: { ...old.delivery, state: 'run', auto: true, message: STEP_MSG.open }, tasks: old.tasks.map(x => x.id === old.activeId ? { ...x, activity: 'loading' } : x) })),
    reload: () => { patch({ web: 'loading', palette: null }); setTimeout(() => patch(old => ({ web: 'ready', tasks: old.tasks.map(x => x.id === old.activeId && x.activity === 'error' ? { ...x, activity: 'complete' } : x) })), 1100); },
    dismissNotice: () => patch({ notice: null }),
    openImage: () => patch({ image: true, view: 'image', palette: null }),
    removeImage: () => patch(old => ({ image: false, view: old.tasks.length ? (old.tasks.find(t => t.id === old.activeId) && TARGETS[old.tasks.find(t => t.id === old.activeId).target].local ? 'chat' : 'task') : 'launcher' })),
    hide: () => patch({ hidden: true, palette: null }),
    settings: tab => patch(old => ({ view: 'settings', settingsTab: tab, editing: null, palette: null, returnView: old.view === 'settings' ? old.returnView : old.view })),
    closeSettings: () => patch(old => ({ view: old.returnView || (old.tasks.length ? 'task' : 'launcher'), editing: null })),
    edit: id => patch({ editing: id }),
    setPresets: presets => patch({ presets }),
    activity: (id, activity) => patch(old => ({ tasks: old.tasks.map(t => t.id === id ? { ...t, activity } : t) })),
  };
  function key(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); act.palette(s.palette ? null : 'all'); }
    else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); act.settings('general'); }
  }
  const dialogTask = s.tasks.find(t => t.id === s.dialog);
  const win = s.hidden ? html`<div className="l-win" style=${{ alignItems: 'center', justifyContent: 'center', background: 'transparent', border: '0.5px dashed var(--line-heavy)', boxShadow: 'none', gap: 12 }}>
      <span style=${{ color: 'var(--ink-3)', fontSize: 13 }}>小窗已隐藏，任务在后台继续。</span><button type="button" className="l-btn" onClick=${() => patch({ hidden: false })}><${Mark} size=${14} />从菜单栏打开</button></div>`
    : html`<div className="l-win" onKeyDown=${key} tabIndex="-1" aria-label="Lasso 小窗原型">
    ${s.view === 'settings' ? html`<${Settings} s=${s} act=${act} fontProps=${fontProps} />` : html`<${Fragment}>
      <${TitleBar} s=${s} act=${act} />
      <main className="l-main">
        ${s.view === 'launcher' ? html`<${Launcher} s=${s} act=${act} />`
          : s.view === 'image' ? html`<${ImageEntry} s=${s} act=${act} />`
          : s.view === 'chat' && active ? html`<${Chat} key=${active.id + '-' + chatKey} task=${active} kind=${s.chat === 'empty' && active.activity !== 'idle' ? 'approval' : active.id === 't3' ? 'approval' : active.id === 't5' ? 'error' : s.chat} act=${act} />`
          : html`<${WebArea} s=${s} act=${act} />`}
      </main>
      ${s.notice && s.view !== 'settings' && html`<${NoticeFoot} n=${s.notice} act=${act} />`}
      ${s.delivery && s.view === 'task' && html`<${DeliveryFoot} d=${s.delivery} act=${act} />`}
      ${s.palette && html`<${Palette} key=${s.palette} s=${s} act=${act} />`}
    </${Fragment}>`}
    ${dialogTask && html`<div className="l-scrim" style=${{ display: 'grid', placeItems: 'start center', paddingTop: 80 }}>
      <div role="alertdialog" aria-label="关闭任务确认" style=${{ width: 300, padding: 18, borderRadius: 12, background: 'rgba(246,245,241,.98)', boxShadow: 'var(--shadow-float)', fontFamily: 'system-ui, PingFang SC, sans-serif', display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' }}>
        <strong style=${{ fontSize: 13 }}>关闭「${dialogTask.title}」？</strong>
        <span style=${{ fontSize: 11.5, color: '#5E5D59', lineHeight: 1.5 }}>这个任务${ACTIVITY[dialogTask.activity]}。关闭后不能恢复未保存的内容，其他任务不受影响。</span>
        <div style=${{ display: 'flex', gap: 8, marginTop: 6 }}><button type="button" className="l-btn small" style=${{ flex: 1 }} onClick=${() => patch({ dialog: null })}>取消</button><button type="button" className="l-btn small primary" style=${{ flex: 1 }} onClick=${() => act.close(dialogTask.id)}>关闭任务</button></div>
        <span style=${{ fontSize: 10.5, color: '#73726C' }}>系统对话框，样式由 macOS 绘制</span>
      </div></div>`}
    ${toast && html`<div role="status" style=${{ position: 'absolute', zIndex: 40, left: '50%', bottom: 64, transform: 'translateX(-50%)', padding: '7px 12px', borderRadius: 9, background: 'var(--ink)', color: 'var(--on-ink)', fontSize: 12.5, whiteSpace: 'nowrap', animation: 'l-rise 180ms var(--ease-out)' }}>${toast}</div>`}
  </div>`;
  return html`<div className="stage">
    <nav className="stage-scenes" aria-label="原型场景">
      ${SCENES.map(([group, items]) => html`<${Fragment} key=${group}><p>${group}</p>${items.map(([id, label]) => html`<button type="button" key=${id} aria-pressed=${s.scene === id} onClick=${() => { setChatKey(k => k + 1); setS(scene(id, s.presets)); }}>${label}</button>`)}</${Fragment}>`)}
    </nav>
    <div className="stage-desk">${win}</div>
    <${SceneNotes} id=${s.scene} />
  </div>`;
}

const NOTES = {
  launcher: { title: '启动台', rules: ['只在关闭了全部任务后出现；启动时仍直接进入上次目标的新对话。', '套索圈每次启动只描一次（900ms），之后静止。', '目标卡标出上次使用；本地 CLI 显示默认工作目录。', '底栏：粘贴图片（也接受直接 ⌘V）与截图。'], m: [['标题', '展示 34 / 1.32 · Light'], ['卡片', '2 列 · 间距 8 · 圆角 12'], ['底栏', '52 · Sunken 底']] },
  web: { title: '网页任务', rules: ['标题栏 44px：任务标签、新建、置顶、⌘K。双击空白处放大，拖动空白处移动窗口。', '标签最多显示 3 个，放不下时出现 +N；当前任务始终可见。目标徽标只在当前标签显示，其余标签悬停可见目标与关闭按钮。', '标签状态点以形状加颜色区分，悬停提示包含目标、标题与状态。', '网页区域是原生视图，React 只负责其上方 44px 与下方提示行。'], m: [['标题栏', '44'], ['标签', '高 30 · 最大宽 150 · 圆角 8'], ['图标按钮', '28 × 28 · 圆角 7']] },
  delivering: { title: '投递进度', rules: ['步骤按预设生成：打开 →（模型）→（图片）→ 填入 → 发送 / 交给你。', '当前步骤用荧光笔底；完成的步骤显示对勾，未开始的为空心点。', '直接发送成功后显示 2.6 秒再收起；进行中可随时复制原文或取消。', '网页输入框在填入后出现柔橙外圈，提示内容已在网页里。'], m: [['提示行', '48 · 位于网页下方'], ['步骤连线', '14 × 1'], ['收起', '发送成功 2.6s']] },
  editing: { title: '先编辑', rules: ['填入完成即停，焦点交给网页输入框。', '提示保留到网页草稿被发送或清空；也可以点「完成」收起。', '标签状态为「有草稿」，关闭时需要确认。'], m: [['状态点', '有草稿 · 空心墨色圈']] },
  login: { title: '等待登录', rules: ['网页要求登录时，进度停在「打开」，状态点为空心柔橙圈。', '登录完成后自动继续，不需要再次运行预设。', '待发送内容一直保留，可随时复制原文。'], m: [] },
  failed: { title: '投递失败', rules: ['提示行变为错误色，失败步骤用菱形标记。', '「重试」从失败步骤继续，不会重复已完成的步骤，也不会重复提交。', '原文与图片保留；关闭提示即放弃这次待发送动作。'], m: [['错误底', '#F8E7E1'], ['错误字', '#B3412E · 5.3:1']] },
  restoring: { title: '恢复已释放任务', rules: ['点击虚线圈的标签即恢复：网页打开原链接，CLI 恢复原会话。', '提示明确「不会重发提示词」。'], m: [] },
  pageError: { title: '网页加载失败', rules: ['整块区域换成说明与重新加载；标签状态为异常（菱形）。', '待发送内容不丢失。'], m: [] },
  notice: { title: '应用级提示', rules: ['截图启动失败、剪贴板图片读取失败等不属于某个任务的错误，统一出现在底部提示行。', '与投递进度同一位置；两者同时存在时提示在上、进度在下，各 48px。', '可直接给出修复动作，例如打开系统设置。'], m: [['主进程', 'bottomInset = 行数 × 48']] },
  closing: { title: '关闭确认', rules: ['进行中、等待处理、有草稿、状态未知的任务关闭前确认；已完成、新对话直接关闭。', '使用 macOS 系统对话框，这里只示意文案。'], m: [] },
  palette: { title: '⌘K 指令面板', rules: ['替代运行预设、新对话、更多任务三个系统菜单。打开时网页视图隐藏，背后显示冻结的页面截图。', '顶部显示当前选区长度、来源应用与是否匹配应用背景。', '↑↓ 选择，↵ 运行，⇥ / ⇧⇥ 为选中的预设临时切换目标；换目标后提示「跟随目标默认」模型。', '搜索同时匹配预设、任务与指令。Esc 或点击外部关闭。'], m: [['面板', '宽 460 · 距顶 52 · 圆角 14'], ['行', '36 · 圆角 8'], ['打开', '180ms · 下移 4px + 缩放 .985']] },
  paletteNone: { title: '没有选区', rules: ['需要选区的预设保留在列表里但不可选，右侧写明「需要选区」。', '有选区时，全局快捷键唤起小窗会直接打开面板。'], m: [] },
  paletteTasks: { title: '全部任务', rules: ['标签栏 +N 打开面板的任务视图，按状态列出全部任务。', '已释放任务选中后按原链接或原会话恢复。'], m: [] },
  chat: { title: '本地 CLI 对话', rules: ['回答用「回答正文」字体，用户消息用沙色气泡。', '工具记录折叠成一行摘要，展开为等宽清单。', '审批单出现在消息流末尾；允许或拒绝后收成一行记录。', '模型、强度、工作目录收进输入卡底部；运行中不可改。⌘↵ 发送，运行中可以先写下一条。'], m: [['回答', '16 / 1.75'], ['输入卡', '圆角 16 · 内边 12'], ['发送', '32 圆 · Clay']] },
  chatEmpty: { title: 'CLI 新对话', rules: ['说明沿用 CLI 自己的配置和权限，并给出工作目录。', 'Pi 额外说明终端专属扩展不在小窗显示。'], m: [] },
  chatReleased: { title: '已释放的 CLI 任务', rules: ['进程已释放时，在输入卡上方说明；发送下一条或点「立即恢复」时按原会话恢复。', '恢复不会重发历史内容。'], m: [] },
  image: { title: '图片入口', rules: ['待处理图片作为临时标签出现在最前面，切到其他任务后可以回来。', '目标默认沿用每个预设自己的目标，也可以一次性改成别的目标。', '运行后标签消失，图片随任务一起投递；失败时保留。'], m: [['预览', '高 160 · 外框 10 · 圆角 14']] },
  setPresets: { title: '预设列表', rules: ['按「动作条 · 前 4 个」与「更多菜单」分组，直接反映动作条的规则。', '拖动排序；开关立即生效，停用的预设沉到更多菜单并变淡。', '模板预览里的 {{selection}} 显示为「选区」标签。'], m: [['行', '最小 52'], ['开关', '32 × 20']] },
  setEdit: { title: '编辑预设', rules: ['「插入选区位置」把占位符放到光标处。', '目标、执行方式用分段控件；模型与强度选项读取自目标本身。', '有改动时底部出现保存条；保存后显示「已保存」。删除需要再点一次确认。'], m: [] },
  setApps: { title: '应用背景', rules: ['每个应用一张卡片：名称、bundle ID、开关、背景提示词。', '可以从应用程序目录选择，也可以手动填写 bundle ID。'], m: [] },
  setLocal: { title: '本地 CLI', rules: ['路径和目录用等宽字体；右上角直接显示是否找到可执行文件。'], m: [] },
  setGeneral: { title: '通用', rules: ['划词状态写在开关下方，授权问题直接给出修复按钮。', '两个快捷键都用录制方式，⌥ 空格 会被拒绝并说明原因。', '后台任务数实时显示。'], m: [] },
  setAppearance: { title: '外观 · 字体', rules: ['四个角色分别设置：标题、回答正文、界面文字、代码与数据。', '默认前三个都是 Anthropic Serif Text，代码保持等宽。', '可从本机字体中选择、直接输入字体名，或导入 .otf / .ttf / .woff2 文件。', '字体缺失时标出「未找到」，并自动使用内置后备字体。'], m: [] },
};
function SceneNotes({ id }) {
  const n = NOTES[id] || NOTES.web;
  return html`<aside className="stage-notes" aria-live="polite">
    <h3>${n.title}</h3>
    <ul className="doc-rules">${n.rules.map(r => html`<li key=${r}>${r}</li>`)}</ul>
    ${n.m.length > 0 && html`<div className="measure">${n.m.map(([k, v]) => html`<${Fragment} key=${k}><span>${v}</span><span>${k}</span></${Fragment}>`)}</div>`}
  </aside>`;
}

/* ───────── Selection action bar demo ───────── */
function ActionBarDemo({ presets }) {
  const scene = useRef(null), mark = useRef(null);
  const [pos, setPos] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [pressed, setPressed] = useState(null);
  const [tip, setTip] = useState(null);
  const [menu, setMenu] = useState(false);
  const [result, setResult] = useState('');
  const [initial, setInitial] = useState(true);
  const shown = presets.filter(p => p.enabled).slice(0, 4);
  const place = rect => { const box = scene.current.getBoundingClientRect(); setPos({ x: Math.max(8, rect.left - box.left - 24), y: rect.top - box.top - 52 }); };
  useLayoutEffect(() => { if (mark.current) place(mark.current.getBoundingClientRect()); }, []);
  function up() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !scene.current.contains(sel.anchorNode)) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width) return;
    setInitial(false); place(rect); setPhase('idle'); setMenu(false); setResult('');
  }
  function run(p) {
    setPressed(p.id); setMenu(false); setTip(null);
    setTimeout(() => { setPhase('sending'); setPressed(null); }, 120);
    setTimeout(() => { setPos(null); setPhase('idle'); setResult('小窗在选区附近打开，新任务「' + p.name + '」开始投递。'); window.getSelection()?.removeAllRanges(); }, 560);
  }
  return html`<div className="ab-scene">
    <div className="ab-doc" ref=${scene} onMouseUp=${up} onMouseDown=${e => { if (!e.target.closest('.ab-bar, .ab-menu')) { setPos(null); setMenu(false); } }}>
      <div className="ab-doc-bar"><i></i><i></i><i></i><span style=${{ marginLeft: 12 }}>任意来源应用 · 阅读器</span></div>
      <article>
        <h4>为什么重试不会生成两笔订单？</h4>
        <p>网络超时后，客户端并不知道上一次请求是否已经到达服务端。如果直接重发，就可能在服务端留下两条一模一样的订单记录。</p>
        <p>解决办法是让每次下单携带${initial ? html`<span ref=${mark} style=${{ background: 'rgba(42,120,214,.24)', borderRadius: 2 }}>同一个幂等键</span>` : '同一个幂等键'}。服务端第一次处理时记下这个键与结果，之后再收到同一个键，就直接返回第一次的结果，而不是再创建一笔。</p>
        <p>这个键通常由客户端在用户点击「提交」时生成，并在所有重试中保持不变。试着拖选这里的任意文字。</p>
      </article>
      ${pos && (phase === 'sending' ? html`<div className="ab-bar sending" style=${{ left: pos.x, top: pos.y }} role="status"><${Mark} size=${16} ink="#FAF9F5" />正在交给 ChatGPT…</div>`
        : html`<div className="ab-bar" style=${{ left: pos.x, top: pos.y }} role="toolbar" aria-label="Lasso 动作条">
          <span style=${{ display: 'flex', marginRight: 4 }}><${Mark} size=${16} ink="#FAF9F5" /></span>
          ${shown.map(p => html`<button type="button" key=${p.id} className=${pressed === p.id ? 'pressed' : ''} onMouseEnter=${e => { const b = e.currentTarget.getBoundingClientRect(), box = scene.current.getBoundingClientRect(); setTip({ x: b.left - box.left, y: b.bottom - box.top + 8, text: TARGETS[p.target].label + ' · ' + (p.mode === 'edit' ? '先编辑' : '直接发送') }); }} onMouseLeave=${() => setTip(null)} onClick=${() => run(p)}>${p.name}</button>`)}
          <span className="ab-sep"></span>
          <button type="button" aria-label="更多预设" aria-expanded=${menu} onClick=${() => setMenu(!menu)}><${Icon} n="dots" /></button>
        </div>`)}
      ${tip && pos && phase === 'idle' && html`<div className="ab-tip" style=${{ left: tip.x, top: tip.y }}>${tip.text}</div>`}
      ${menu && pos && html`<div className="ab-menu" role="menu" style=${{ left: pos.x + 260, top: pos.y + 46 }}>
        ${presets.filter(p => p.enabled).slice(4).map(p => html`<button type="button" role="menuitem" key=${p.id} onClick=${() => run(p)}>${p.name}</button>`)}<hr /><button type="button" role="menuitem" onClick=${() => setMenu(false)}>预设设置…</button></div>`}
    </div>
    <div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3>墨色胶囊，停在选区上方</h3>
      <ul className="doc-rules">
        <li>独立的不可聚焦窗口，<strong>不抢源应用焦点</strong>；只放启用的前 4 个预设，其余在「···」系统菜单。</li>
        <li>默认在选区上方 12px；上方空间不足时放到选区下方，并避开屏幕边缘。</li>
        <li>悬停显示目标与执行方式；点击后按钮变柔橙 120ms，胶囊原位显示「正在交给…」，在小窗出现时淡出。</li>
        <li>点击动作条外、选区消失或开始截图时立即隐藏；没有启用的预设时不出现。</li>
      </ul>
      <div className="measure"><span>40</span><span>高度 · 圆角 12</span><span>30</span><span>按钮高 · 内边 10</span><span>120ms</span><span>出现：淡入 + 上移 4px</span><span>150ms</span><span>隐藏：淡出（WindowMotion）</span></div>
      ${result && html`<p role="status" className="l-field-help" style=${{ fontSize: 13, color: 'var(--olive)' }}>${result}</p>`}
    </div>
  </div>`;
}

/* ───────── Screenshot overlay demo ───────── */
const SCREEN = { w: 1440, h: 900 };
const BOXES = [
  { id: 'app', source: 'window', x: .11, y: .10, w: .78, h: .78 },
  { id: 'side', source: 'element', x: .11, y: .10, w: .1872, h: .78 },
  { id: 'row1', source: 'element', x: .12, y: .17, w: .168, h: .075 },
  { id: 'row2', source: 'element', x: .12, y: .255, w: .168, h: .075 },
  { id: 'pane', source: 'element', x: .2972, y: .10, w: .5928, h: .78 },
  { id: 'b1', source: 'element', x: .33, y: .19, w: .31, h: .10 },
  { id: 'b2', source: 'element', x: .60, y: .34, w: .26, h: .07 },
  { id: 'b3', source: 'element', x: .33, y: .46, w: .37, h: .15 },
  { id: 'input', source: 'element', x: .32, y: .78, w: .54, h: .065 },
];
const SOURCE = { window: '窗口', element: '界面区域', screen: '全屏', drag: '手动框选' };
function CaptureDemo() {
  const box = useRef(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [point, setPoint] = useState(null);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState(null);
  const [draft, setDraft] = useState(null);
  const [toast, setToast] = useState('');
  const gesture = useRef(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(box.current); return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 1600); return () => clearTimeout(t); }, [toast]);
  const px = b => ({ x: b.x * size.w, y: b.y * size.h, width: b.w * size.w, height: b.h * size.h, source: b.source });
  const candidates = point ? [...BOXES.map(px), { x: 0, y: 0, width: size.w, height: size.h, source: 'screen' }]
    .filter(r => point.x >= r.x && point.y >= r.y && point.x <= r.x + r.width && point.y <= r.y + r.height).sort((a, b) => a.width * a.height - b.width * b.height) : [];
  const hovered = candidates[Math.min(level, candidates.length - 1)];
  const shown = draft || result || hovered;
  const local = e => { const r = box.current.getBoundingClientRect(); return { x: Math.max(0, Math.min(size.w, e.clientX - r.left)), y: Math.max(0, Math.min(size.h, e.clientY - r.top)) }; };
  function down(e) {
    if (e.target.closest('.cap-tools')) return;
    box.current.focus();
    const p = local(e), handle = e.target.dataset.handle || '';
    if (result && !handle) return;
    gesture.current = { ...p, handle, original: result, dragged: false };
    box.current.setPointerCapture(e.pointerId);
  }
  function move(e) {
    const p = local(e), g = gesture.current;
    if (!g) { if (!result) { if (!point || Math.hypot(p.x - point.x, p.y - point.y) > 5) setLevel(0); setPoint(p); } return; }
    if (Math.hypot(p.x - g.x, p.y - g.y) > 3) g.dragged = true;
    if (g.handle && g.original) {
      let { x, y, width, height } = g.original; const dx = p.x - g.x, dy = p.y - g.y;
      if (g.handle === 'move') { x = Math.max(0, Math.min(size.w - width, x + dx)); y = Math.max(0, Math.min(size.h - height, y + dy)); }
      else { if (g.handle.includes('w')) { x = p.x; width = g.original.x + g.original.width - p.x; } if (g.handle.includes('e')) width = p.x - x; if (g.handle.includes('n')) { y = p.y; height = g.original.y + g.original.height - p.y; } if (g.handle.includes('s')) height = p.y - y; }
      setDraft({ x, y, width: Math.max(4, width), height: Math.max(4, height), source: g.original.source });
    } else if (g.dragged) setDraft({ x: Math.min(g.x, p.x), y: Math.min(g.y, p.y), width: Math.abs(p.x - g.x), height: Math.abs(p.y - g.y), source: 'drag' });
  }
  function up() {
    const g = gesture.current; if (!g) return; gesture.current = null;
    const r = draft || (!g.handle && hovered); setDraft(null);
    if (r && r.width >= 4 && r.height >= 4) setResult(r);
  }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); setResult(null); }
    else if (e.key.toLowerCase() === 'f' && !e.metaKey) { e.preventDefault(); setResult({ x: 0, y: 0, width: size.w, height: size.h, source: 'screen' }); }
    else if (result && (e.key === 'Enter' || (e.metaKey && e.key.toLowerCase() === 'c'))) { e.preventDefault(); setToast('已复制 ' + label(result)); }
    else if (result && e.key.startsWith('Arrow')) {
      e.preventDefault(); const n = (e.shiftKey ? 10 : 1) * size.w / SCREEN.w, r = { ...result };
      if (e.key === 'ArrowLeft') r.x -= n; if (e.key === 'ArrowRight') r.x += n; if (e.key === 'ArrowUp') r.y -= n; if (e.key === 'ArrowDown') r.y += n;
      r.x = Math.max(0, Math.min(size.w - r.width, r.x)); r.y = Math.max(0, Math.min(size.h - r.height, r.y)); setResult(r);
    }
  }
  const wheel = useRef(null);
  wheel.current = e => { if (!result && candidates.length) { e.preventDefault(); setLevel(l => Math.max(0, Math.min(candidates.length - 1, l + (e.deltaY > 0 ? 1 : -1)))); } };
  // React registers wheel listeners as passive; layer cycling must stop page scroll.
  useEffect(() => { const el = box.current, on = e => wheel.current(e); el.addEventListener('wheel', on, { passive: false }); return () => el.removeEventListener('wheel', on); }, []);
  const label = r => Math.round(r.width / size.w * SCREEN.w) + ' × ' + Math.round(r.height / size.h * SCREEN.h);
  const toolTop = shown && (shown.y + shown.height + 56 < size.h ? shown.y + shown.height + 12 : Math.max(12, shown.y - 56));
  const toolLeft = shown && Math.max(12, Math.min(size.w - 420, shown.x));
  return html`<div className="doc-grid" style=${{ gridTemplateColumns: 'minmax(0, 2.2fr) minmax(min(260px, 100%), 1fr)', alignItems: 'start' }}>
    <div ref=${box} className="cap" tabIndex="0" aria-label="截图覆盖层原型：悬停选择区域，滚轮切换层级，拖动框选" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerLeave=${() => !result && !gesture.current && setPoint(null)} onKeyDown=${key}>
      <div className="cap-app" style=${{ left: '11%', top: '10%' }}></div>
      <div style=${{ position: 'absolute', left: '11%', top: '10%', width: '18.72%', height: '78%', background: '#F4F5F7', borderRadius: '10px 0 0 10px', pointerEvents: 'none' }}></div>
      ${BOXES.slice(2).map(b => html`<div key=${b.id} style=${{ position: 'absolute', left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%', pointerEvents: 'none', borderRadius: 8,
        background: b.id === 'b2' ? '#CFE3FF' : b.id.startsWith('row') ? (b.id === 'row1' ? '#E6E9EE' : 'transparent') : b.id === 'pane' ? 'transparent' : '#FFFFFF', border: b.id.startsWith('b') || b.id === 'input' ? '1px solid #E6E9EE' : 0 }}></div>`)}
      ${!shown && html`<div className="cap-dim"></div>`}
      ${shown && html`<div className=${'cap-rect' + (draft ? ' live' : '')} style=${{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}>
        <span className=${'cap-size' + (shown.y < 36 ? ' inside' : '')}><span className="mono">${label(shown)}</span><span style=${{ opacity: .75 }}>${SOURCE[shown.source]}</span>
          ${!result && !draft && candidates.length > 1 && html`<span className="cap-levels" aria-label=${'第 ' + (level + 1) + ' 层，共 ' + candidates.length + ' 层'}>${candidates.map((_, i) => html`<i key=${i} className=${i === level ? 'on' : ''}></i>`)}</span>`}</span>
        ${result && !draft && html`<${Fragment}><div data-handle="move" style=${{ position: 'absolute', inset: 0, cursor: 'move', pointerEvents: 'auto' }}></div>
          ${[['nw', -5, -5, 'nwse'], ['n', '50%', -5, 'ns'], ['ne', 'r', -5, 'nesw'], ['e', 'r', '50%', 'ew'], ['se', 'r', 'b', 'nwse'], ['s', '50%', 'b', 'ns'], ['sw', -5, 'b', 'nesw'], ['w', -5, '50%', 'ew']].map(([h, x, y, c]) => html`<i key=${h} data-handle=${h} className="cap-handle" style=${{ pointerEvents: 'auto', cursor: c + '-resize', left: x === 'r' ? undefined : x === '50%' ? 'calc(50% - 4.5px)' : x, right: x === 'r' ? -5 : undefined, top: y === 'b' ? undefined : y === '50%' ? 'calc(50% - 4.5px)' : y, bottom: y === 'b' ? -5 : undefined }}></i>`)}</${Fragment}>`}
      </div>`}
      ${result && !draft && html`<div className="cap-tools" role="toolbar" aria-label="截图操作" style=${{ left: toolLeft, top: toolTop }}>
        <button type="button" onClick=${() => setResult(null)}><${Icon} n="crop" s="s" />重新选区</button>
        <button type="button" onClick=${() => setToast('已保存到「下载」')}><${Icon} n="download" s="s" />保存</button>
        <button type="button" onClick=${() => setToast('已送到小窗的图片入口')}><${Mark} size=${15} />问 AI</button>
        <span className="l-sep"></span>
        <button type="button" className="primary" onClick=${() => setToast('已复制 ' + label(result))}>复制<span className="mono" style=${{ fontSize: 11, opacity: .7 }}>⌘C</span></button>
        <button type="button" aria-label="取消截图" onClick=${() => setResult(null)}><${Icon} n="x" s="s" /></button>
      </div>`}
      <div className="cap-guide">${result ? html`<span><b>方向键</b> 微调</span><span><b>⇧</b> 10 点</span><span><b>↵</b> 复制</span><span><b>Esc</b> 重选</span>` : html`<span>悬停选区域</span><span><b>滚轮</b> 切换层级</span><span><b>拖动</b> 框选</span><span><b>F</b> 全屏</span>`}</div>
      ${toast && html`<div className="cap-toast" role="status">${toast}</div>`}
    </div>
    <div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h3>冻结屏幕，先选再定稿</h3>
      <ul className="doc-rules">
        <li>候选按面积从小到大排成层级，滚轮逐层放大；尺寸标签用点阵显示当前层，方便判断还有几层。</li>
        <li>单击定稿当前候选，拖动则手动框选。定稿后可拖动移动、拖动 8 个手柄缩放，方向键 1 点微调，⇧ 加速到 10 点。</li>
        <li>工具栏在选区下方 12px，下方放不下时移到上方；键位提示常驻底部，随阶段切换。</li>
        <li>「问 AI」把原尺寸图片送进小窗的图片入口；复制与保存不打开小窗。</li>
      </ul>
      <div className="measure"><span>1.5</span><span>选区描边 · Clay</span><span>52%</span><span>遮罩 · Slate</span><span>9</span><span>手柄 · 白底 Clay 边</span><span>44</span><span>工具栏高 · 圆角 13</span></div>
    </div>
  </div>`;
}

/* ───────── Motion specimens ───────── */
const MOTION = [
  { id: 'window', name: '小窗显隐', d: '显示 240ms · 隐藏 150ms', e: '余弦缓动（整窗透明度）', t: '唤起 / 失焦隐藏', r: '直接显隐', demo: () => html`<div className="l-btn" style=${{ animation: 'l-fade 240ms ease-in-out' }}>小窗</div>` },
  { id: 'palette', name: '指令面板', d: '180ms', e: 'ease-out (.22,.68,0,1)', t: '⌘K / + / +N', r: '直接出现', demo: () => html`<div className="l-palette" style=${{ position: 'static', width: 180, height: 70, animation: 'l-pop 180ms var(--ease-out)' }}></div>` },
  { id: 'tab', name: '标签进入', d: '160ms', e: 'ease-out', t: '新建任务', r: '直接出现', demo: () => html`<span className="l-tab" aria-selected="true"><span className="dot running"></span><span className="l-badge">Ch</span>新任务</span>` },
  { id: 'step', name: '投递步骤推进', d: '每步 180ms 上移 + 进行中脉冲 1.4s', e: 'ease-out', t: 'TaskManager 推送阶段', r: '静态点', demo: () => html`<span className="l-step now" style=${{ animation: 'l-rise 180ms var(--ease-out)' }}><span className="dot running" style=${{ width: 6, height: 6, boxShadow: 'none' }}></span>填入</span>` },
  { id: 'loop', name: '套索描线', d: '900ms · 延迟 200ms', e: 'ease-out', t: '每次启动后首次显示启动台', r: '直接显示完整线条', demo: () => html`<span className="l-hero-loop" style=${{ fontFamily: 'var(--font-display)', fontSize: 26 }}><svg viewBox="0 0 220 80" preserveAspectRatio="none" aria-hidden="true"><path d="M30 44 C28 18 110 6 180 16 C214 22 216 56 170 66 C110 78 36 72 22 50 C14 36 40 22 70 20" /></svg><span style=${{ position: 'relative' }}>问一句</span></span>` },
  { id: 'bar', name: '动作条出现', d: '120ms · 上移 4px', e: 'ease-out', t: '选区稳定后', r: '直接出现', demo: () => html`<div className="ab-bar" style=${{ position: 'static' }}><button type="button">解释</button><button type="button">总结</button></div>` },
  { id: 'message', name: '消息出现', d: '180ms', e: 'ease-out', t: '用户消息、审批单', r: '直接出现；流式文字从不动画', demo: () => html`<p className="l-user" style=${{ alignSelf: 'center' }}>帮我看看这段</p>` },
  { id: 'switch', name: '开关', d: '180ms', e: 'ease-out', t: '切换', r: '直接切换', demo: () => html`<span className="l-switch" aria-checked="true" style=${{ display: 'inline-flex' }}><span style=${{ animation: 'l-rise 180ms var(--ease-out)' }}></span></span>` },
];
function MotionGrid() {
  const [keys, setKeys] = useState({});
  return html`<div className="mo-grid">${MOTION.map(m => html`<div className="doc-card mo-card" key=${m.id}>
    <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><h3 style=${{ fontSize: 17 }}>${m.name}</h3>
      <button type="button" className="l-btn small" onClick=${() => setKeys({ ...keys, [m.id]: (keys[m.id] || 0) + 1 })}><${Icon} n="play" s="xs" />重播</button></div>
    <div className="mo-box"><div key=${keys[m.id] || 0}>${m.demo()}</div></div>
    <dl><dt>时长</dt><dd>${m.d}</dd><dt>曲线</dt><dd>${m.e}</dd><dt>触发</dt><dd>${m.t}</dd><dt>减少动态</dt><dd>${m.r}</dd></dl>
  </div>`)}</div>`;
}

/* ───────── Spec book ───────── */
const SECTIONS = [['foundations', '基础规范'], ['fonts', '字体配置'], ['window', '小窗原型'], ['bar', '划词动作条'], ['capture', '截图'], ['states', '状态清单'], ['motion', '动效'], ['build', '实现映射']];
const COLORS = [['--bg', '#FAF9F5', 'Ivory · 窗口底'], ['--surface', '#FFFFFF', 'Paper · 卡片、当前标签'], ['--sunken', '#F5F4ED', '凹面 · 底栏、代码'], ['--sand', '#F0EEE6', '悬停、气泡、分段底'], ['--oat', '#E3DACC', '按下的图标按钮'], ['--ink', '#141413', 'Slate · 正文、主按钮'], ['--ink-2', '#3D3D3A', '次要正文'], ['--ink-3', '#5E5D59', '说明文字'], ['--ink-4', '#73726C', '占位、只用在白底与象牙底'], ['--clay', '#D97757', '唯一强调色 · 只做填充'], ['--clay-ink', '#A4502F', '强调文字'], ['--marker', 'rgba(217,119,87,.3)', '荧光笔：选区、当前步骤'], ['--olive', '#5C6E45', '完成'], ['--danger', '#B3412E', '错误文字与标记'], ['--danger-wash', '#F8E7E1', '错误底']];
const STATES = [
  ['标题栏', '无任务显示字标；1–3 个标签；溢出 +N；待处理图片临时标签', '标签悬停才显示关闭', '—'],
  ['网页区域', '加载线 · 登录页 · 已填入外圈', '网页还没打开（重新加载）', '待发送内容保留'],
  ['投递提示行', '打开 / 模型 / 图片 / 填入 / 发送 / 交给你；恢复中', '失败步骤 + 重试', '复制原文 · 取消'],
  ['应用提示行', '截图启动失败、图片读取失败', '带修复动作', '可关闭'],
  ['指令面板', '有选区 · 无选区 · 全部任务 · 新任务', '无匹配结果', '需要选区的预设不可选'],
  ['CLI 对话', '新对话 · 运行中 · 等待审批 · 完成 · 已停止', '进程异常 / 已释放（立即恢复）', '运行中禁用模型与强度'],
  ['审批单', 'confirm · select · input · editor · questions', '提交失败行内提示', '处理后收成一行记录'],
  ['图片入口', '截图 / 剪贴板来源 · 目标覆盖', '读取失败（提示行）', '运行中禁用预设行'],
  ['预设设置', '列表 · 编辑 · 未保存 · 已保存', '名称或提示词为空时不能保存', '停用的预设变淡'],
  ['外观 · 字体', '本机 · 内置 · 已导入', '未找到 · 使用后备字体', '导入失败说明支持的格式'],
  ['动作条', '默认 · 悬停 · 按下 · 交付中 · 更多', '—', '无启用预设时不出现'],
  ['截图', '选择中（层级）· 拖动 · 定稿 · 微调', '未授权屏幕录制（系统对话框）', '复制 / 保存成功短提示'],
];
function SpecBook() {
  const [fonts, setFontsState] = useState(loadStored);
  const [imported, setImported] = useState([]);
  const [current, setCurrent] = useState('foundations');
  const setFonts = next => { setFontsState(next); try { localStorage.setItem('lasso-v2-fonts', JSON.stringify(next)); } catch (error) {} };
  useEffect(() => { ROLES.forEach(r => document.documentElement.style.setProperty('--font-' + r.id, stackFor(r.id, fonts[r.id]))); }, [fonts]);
  useEffect(() => {
    const io = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) setCurrent(e.target.id); }), { rootMargin: '-30% 0px -60% 0px' });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  const fontProps = { fonts, setFonts, imported, addImported: f => setImported(list => [...list.filter(x => x.family !== f.family), f]) };
  return html`<div className="doc">
    <nav className="doc-nav" aria-label="章节">
      <div className="doc-brand"><${Mark} size=${20} />Lasso 2</div>
      ${SECTIONS.map(([id, label]) => html`<a key=${id} href=${'#' + id} className=${current === id ? 'on' : ''}>${label}</a>`)}
      <small>详细设计 · 2026-10-25<br />浅色主题 · 第一版</small>
    </nav>
    <main className="doc-main">
      <header className="doc-hero">
        <span className="doc-kicker">详细设计 · 已确认方向「纸上的套索」</span>
        <h1>Lasso 2 · 每个界面，每个状态。</h1>
        <p>这份文档既是规范也是原型：小窗、指令面板、CLI 对话、设置、动作条和截图都能直接操作。左侧切换场景，右侧是该场景的规则与尺寸。所有颜色和字体都以实现时的变量名给出。</p>
        <div className="doc-meta"><span>小窗 520 × 640</span><span>默认字体 Anthropic Serif Text</span><span>强调色只用一处</span><span>遵循「减少动态效果」</span></div>
      </header>

      <section className="doc-section" id="foundations">
        <header><span className="doc-kicker">基础规范</span><h2>暖灰为底，一笔陶土色。</h2>
          <p className="doc-lead">色彩只有一套浅色主题。强调色 Clay 只做填充，从不直接做小字；需要强调的文字用 Clay Ink。状态从不只靠颜色区分。</p></header>
        <div className="swatches">${COLORS.map(([name, value, use]) => html`<div className="swatch" key=${name}><i style=${{ background: value }}></i><b>${use}</b><span>${name} ${value}</span></div>`)}</div>
        <div className="doc-grid">
          <div className="doc-card">
            <h3 style=${{ marginBottom: 8 }}>字号与角色</h3>
            ${[['display', 34, '启动台标题 · Light', '34 / 1.32'], ['display', 28, '页面标题', '28 / 1.3'], ['text', 16, '回答正文读起来像一页纸。', '16 / 1.75'], ['ui', 14, '界面文字 · 列表与按钮', '14 / 1.5'], ['ui', 12, '说明与提示文字', '12 / 1.6'], ['mono', 11, '1788 × 693 · ⌘K', '11–13']].map(([role, size, text, spec], i) => html`<div className="type-row" key=${i}><span style=${{ fontFamily: 'var(--font-' + role + ')', fontSize: size, fontWeight: role === 'display' ? 300 : 400 }}>${text}</span><span>${ROLES.find(r => r.id === role).name} · ${spec}</span></div>`)}
            <p className="l-field-help" style=${{ marginTop: 10 }}>Anthropic Serif Text 只有 Light 一个字重，并关闭字体合成：<strong>层级靠字号与墨色，不靠加粗</strong>。</p>
          </div>
          <div className="doc-card" style=${{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h3>间距 · 圆角 · 阴影</h3>
            <div className="scale-bar">${[2, 4, 6, 8, 10, 12, 16, 20, 24, 32].map(n => html`<div key=${n}><i style=${{ width: n, height: n }}></i>${n}</div>`)}</div>
            <div style=${{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>${[[4, '标记'], [7, '图标按钮'], [8, '标签 · 行'], [9, '按钮'], [12, '卡片 · 窗口'], [14, '面板'], [16, '输入卡']].map(([r, n]) => html`<div key=${r} style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ink-3)' }}><span style=${{ width: 44, height: 32, borderRadius: r, border: '1px solid var(--line-heavy)', background: 'var(--surface)' }}></span>${r} · ${n}</div>`)}</div>
            <div style=${{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>${[['--shadow-tab', '当前标签'], ['--shadow-card', '卡片悬停'], ['--shadow-window', '小窗'], ['--shadow-float', '面板 · 浮层']].map(([v, n]) => html`<div key=${v} style=${{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: 'var(--ink-3)' }}><span style=${{ width: 70, height: 44, borderRadius: 10, background: 'var(--surface)', boxShadow: 'var(--' + v.slice(2) + ')' }}></span>${n}</div>`)}</div>
          </div>
          <div className="doc-card" style=${{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h3>任务状态</h3>
            <div style=${{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 14px', fontSize: 13.5 }}>
              ${['idle', 'loading', 'running', 'waiting', 'draft', 'complete', 'unknown', 'released', 'error'].map(a => html`<span key=${a} style=${{ display: 'flex', alignItems: 'center', gap: 8 }}><span className=${'dot ' + a}></span>${ACTIVITY[a].replace(' · 点击恢复', '')}</span>`)}
            </div>
            <p className="l-field-help">进行中与加载中带 1.4 秒脉冲；等待、草稿、未知、已释放是不同线型的空心圈；异常是菱形。</p>
            <h3 style=${{ marginTop: 6 }}>图标</h3>
            <div style=${{ display: 'flex', flexWrap: 'wrap', gap: 10, color: 'var(--ink-2)' }}>${Object.keys(ICONS).map(n => html`<span key=${n} title=${n}><${Icon} n=${n} /></span>`)}</div>
            <p className="l-field-help">Lucide，描边 1.6，16 / 14 / 12 三档；实现继续使用 lucide-react。</p>
          </div>
        </div>
      </section>

      <section className="doc-section" id="fonts">
        <header><span className="doc-kicker">字体配置</span><h2>默认全部衬线，也能换成本机任何字体。</h2>
          <p className="doc-lead">设置 → 外观 → 字体。这里与小窗里是同一个组件：在本页更换或导入的字体会立刻作用到整份文档和原型。</p></header>
        <div className="doc-grid" style=${{ gridTemplateColumns: 'minmax(0, 1.1fr) minmax(min(320px, 100%), 1fr)', alignItems: 'start' }}>
          <div className="doc-card" style=${{ background: 'var(--bg)' }}><${FontSettings} ...${fontProps} /></div>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <ul className="doc-rules">
              <li><strong>默认</strong>：标题、回答正文、界面文字都用 Anthropic Serif Text；代码与数据用内置 JetBrains Mono，保持对齐。</li>
              <li><strong>后备</strong>：衬线角色依次退到内置 Newsreader（拉丁）与系统宋体（中文）；不内置中文字体，安装包不增大。</li>
              <li><strong>本机字体</strong>：应用内通过系统字体列表读取，可搜索；也可以直接输入字体名。</li>
              <li><strong>导入</strong>：支持 .otf / .ttf / .ttc / .woff / .woff2，文件复制到数据目录的 <span className="mono">fonts/</span>，字体名从文件读取。</li>
              <li><strong>缺失</strong>：配置的字体在新机器上不存在时，标出「未找到」并使用后备字体，不阻止启动。</li>
              <li>只作用于 Lasso 本地界面；ChatGPT、Gemini 网页仍由网站控制。</li>
            </ul>
            <div className="doc-card doc-scroll" style=${{ padding: 0 }}><pre style=${{ margin: 0, padding: 18, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, color: 'var(--ink-2)' }}>${'// settings.json\n"fonts": {\n  "display": "' + fonts.display + '",\n  "text": "' + fonts.text + '",\n  "ui": "' + fonts.ui + '",\n  "mono": "' + fonts.mono + '"\n},\n"importedFonts": [' + (imported.length ? '\n' + imported.map(f => '  { "family": "' + f.family + '", "file": "' + f.file + '" }').join(',\n') + '\n' : '') + ']'}</pre></div>
          </div>
        </div>
      </section>

      <section className="doc-section" id="window">
        <header><span className="doc-kicker">小窗原型</span><h2>一条标题栏，一个指令面板。</h2>
          <p className="doc-lead">左侧选场景，窗口内可以直接操作：切换和关闭标签、⌘K（先点一下窗口）、运行预设看投递进度、在 Codex 里发送和审批、编辑预设、更换字体。</p></header>
        <${Simulator} fontProps=${fontProps} onScene=${() => {}} />
      </section>

      <section className="doc-section" id="bar">
        <header><span className="doc-kicker">划词动作条</span><h2>选中，就在旁边。</h2>
          <p className="doc-lead">在下面的阅读器里拖选任意文字，动作条会跟到选区上方。悬停看目标，点击看交付过程。</p></header>
        <${ActionBarDemo} presets=${DEFAULT_PRESETS} />
      </section>

      <section className="doc-section" id="capture">
        <header><span className="doc-kicker">截图</span><h2>从窗口到一条消息，滚一下就到。</h2>
          <p className="doc-lead">把指针移到下面的屏幕上：悬停选候选，滚轮切换层级，单击定稿或拖动框选。定稿后先点一下画面，再用方向键微调，F 全屏，Esc 重选。</p></header>
        <${CaptureDemo} />
      </section>

      <section className="doc-section" id="states">
        <header><span className="doc-kicker">状态清单</span><h2>每个界面需要画到的状态。</h2></header>
        <div className="doc-card doc-scroll" style=${{ padding: 0 }}><table className="doc-table"><thead><tr><th>界面</th><th>正常状态</th><th>错误</th><th>边界与禁用</th></tr></thead>
          <tbody>${STATES.map(r => html`<tr key=${r[0]}>${r.map((c, i) => html`<td key=${i}>${c}</td>`)}</tr>`)}</tbody></table></div>
      </section>

      <section className="doc-section" id="motion">
        <header><span className="doc-kicker">动效</span><h2>短、可打断，只在状态变化时出现。</h2>
          <p className="doc-lead">网页内容由原生视图承载，整窗动效用窗口透明度完成；流式文字从不动画。系统开启「减少动态效果」时全部改为直接切换。</p></header>
        <${MotionGrid} />
      </section>

      <section className="doc-section" id="build">
        <header><span className="doc-kicker">实现映射</span><h2>改哪里，怎么验收。</h2></header>
        <div className="doc-card doc-scroll" style=${{ padding: 0 }}><table className="doc-table"><thead><tr><th>范围</th><th>改动</th><th>文件</th></tr></thead><tbody>
          ${[
            ['样式基础', '用本页变量替换 style.css；按组件拆分样式；打包 Newsreader 与 JetBrains Mono 到 assets/fonts', 'src/renderer/styles/*'],
            ['标题栏', 'TaskTabs 改为单行；移除工具行与 8 个图标按钮；双击放大', 'TaskTabs.tsx · main.tsx'],
            ['布局常量', 'HEADER_HEIGHT 80 → 44；网页下方让出提示行高度（行数 × 48）', 'src/main/index.ts layout()'],
            ['指令面板', '新组件；打开时隐藏网页视图并显示 capturePage 截图作背景；替代 showPresetMenu、showNewTaskMenu 与溢出菜单（托盘菜单保留）', 'Palette.tsx · index.ts · tasks.ts'],
            ['提示行', 'screenshotError 与图片读取错误合并为 ShellState.notice；投递阶段增加 steps 供步骤显示', 'contracts.ts · tasks.ts'],
            ['待处理图片', '标签栏显示临时标签，切走后保留 inputImage', 'TaskTabs.tsx · ImageEntry.tsx'],
            ['CLI 对话', '回答用 --font-text；工具记录折叠；审批单与处理记录；模型/强度/目录进入输入卡', 'AgentChat.tsx'],
            ['设置', '新增「外观」；预设分组列表 + 编辑页 + 保存条；两个快捷键都用录制', 'PresetSettings.tsx · Settings*.tsx'],
            ['字体', 'Settings 增加 fonts 与 importedFonts；导入文件复制到 userData/fonts，经 lasso-font:// 协议提供；CSP 增加 font-src；本地窗口允许 local-fonts 权限', 'settings.ts · index.ts · index.html'],
            ['动作条', '深色胶囊；悬停提示；点击后原位显示交付中，小窗出现时淡出', 'ActionBar.tsx · action-bar.ts'],
            ['截图', '新工具栏与层级点阵；常驻键位提示', 'capture/Screenshot.tsx · capture.css'],
          ].map(r => html`<tr key=${r[0]}><td>${r[0]}</td><td>${r[1]}</td><td><code>${r[2]}</code></td></tr>`)}
        </tbody></table></div>
        <div className="doc-grid">
          <div className="doc-card"><h3 style=${{ marginBottom: 10 }}>验收</h3><ul className="doc-rules">
            <li>网页视图上沿与标题栏下沿对齐，提示行出现与消失时网页高度同步变化，无遮挡。</li>
            <li>⌘K 打开时网页不可点击、截图背景与实际页面一致；关闭后网页焦点恢复。</li>
            <li>投递每个阶段与 TaskManager 的 delivery 一致；失败重试不重复提交。</li>
            <li>四种字体角色可单独更换；导入字体重启后仍生效；字体缺失时界面正常显示。</li>
            <li>文字对比度 ≥ 4.5:1；所有按钮可用键盘操作并有可见焦点。</li>
            <li>开启「减少动态效果」后没有位移动画。</li>
          </ul></div>
          <div className="doc-card"><h3 style=${{ marginBottom: 10 }}>保持不变</h3><ul className="doc-rules">
            <li>网页先编辑直接进网页输入框，不增加本地文字中转。</li>
            <li>默认不绑定全局快捷键；⌥ 空格 留给 Raycast。</li>
            <li>失败保留原文与图片，不降级、不重复提交。</li>
            <li>退出不恢复任务列表，不保存完整聊天副本。</li>
            <li>托盘菜单仍使用系统菜单。</li>
          </ul></div>
        </div>
      </section>
    </main>
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${SpecBook} />`);
