'use strict';
/* Lasso × Nook · 常驻系统工具集详细设计 (v3)
   Interactive SpecBook covering all 7 modules and cross-process Nook bridge. */
const { useState, useEffect } = React;
const html = htm.bind(React.createElement);

/* ───────── Lucide Icons (1.6 stroke, no emojis) ───────── */
const ICONS = {
  timer: html`<g><line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" /></g>`,
  coffee: html`<g><path d="M17 8h1a4 4 0 1 1 0 8h-1" /><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" /><line x1="6" x2="6" y1="2" y2="4" /><line x1="10" x2="10" y1="2" y2="4" /><line x1="14" x2="14" y1="2" y2="4" /></g>`,
  bell: html`<g><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></g>`,
  check: html`<g><path d="M5 12.5l4.5 4.5L19 7.5" /></g>`,
  plus: html`<g><path d="M12 5v14M5 12h14" /></g>`,
  x: html`<g><path d="M6 6l12 12M18 6L6 18" /></g>`,
  copy: html`<g><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></g>`,
  pin: html`<g><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7" /></g>`,
  search: html`<g><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></g>`,
  scan: html`<g><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3" /></g>`,
  languages: html`<g><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></g>`,
  zap: html`<g><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></g>`,
  note: html`<g><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" /><path d="M15 3v6h6" /></g>`,
  folder: html`<g><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></g>`,
  terminal: html`<g><path d="M5 7l5 5-5 5M12 18h7" /></g>`,
  code: html`<g><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></g>`,
  layout: html`<g><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" /></g>`,
  grid: html`<g><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></g>`,
  server: html`<g><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></g>`,
  retry: html`<g><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></g>`,
  play: html`<g><polygon points="6 4 20 12 6 20 6 4" /></g>`,
  pause: html`<g><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></g>`,
  trash: html`<g><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></g>`,
  image: html`<g><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M4 16l4.5-4.5 3.5 3.5 2.5-2.5L20 18" /></g>`,
  send: html`<g><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></g>`,
  alert: html`<g><circle cx="12" cy="12" r="8" /><path d="M12 8v5M12 16v.01" /></g>`,
  replace: html`<g><path d="M14 4c0-1.1.9-2 2-2" /><path d="M20 2c1.1 0 2 .9 2 2" /><path d="M22 8c0 1.1-.9 2-2 2" /><path d="M16 10c-1.1 0-2-.9-2-2" /><path d="m3 7 3 3 3-3" /><path d="M6 10V5c0-1.7 1.3-3 3-3h1" /><rect width="8" height="8" x="2" y="14" rx="2" /></g>`,
  external: html`<g><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></g>`,
  sliders: html`<g><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></g>`,
};

function Icon({ n, s }) {
  return html`<svg className=${'ic' + (s ? ' ' + s : '')} viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ICONS.zap}</svg>`;
}

function Mark({ size = 18, ink = '#141413' }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 64 64" aria-hidden="true">
    <path fill="none" stroke="#D97757" strokeWidth="15" strokeLinecap="round" d="M10 35C22 33 32 32.4 41 31.4" />
    <path fill="none" stroke=${ink} strokeWidth="5" strokeLinecap="round" d="M8 35.2C20 34 31 33.4 40 32.4M50 31.4L58 30.6M48 23.5L54 18.6M49.5 39L56 43.5" />
  </svg>`;
}

/* ───────── 1 & 4. Notch Island + Nook Reminder / Pomodoro Stage ───────── */
function IslandSimulator() {
  const [scene, setScene] = useState('focus');
  const [glow, setGlow] = useState(false);
  const [taskDone, setTaskDone] = useState(false);
  const [paused, setPaused] = useState(false);

  const selectScene = s => {
    setScene(s);
    setTaskDone(false);
    setGlow(s === 'slacking' || s === 'nook-alert');
  };

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>刘海岛与提醒状态</p>
      <button aria-pressed=${scene === 'idle'} onClick=${() => selectScene('idle')}><span>静默融合态</span><small>184×28</small></button>
      <button aria-pressed=${scene === 'focus'} onClick=${() => selectScene('focus')}><span>番茄钟 · Nook 任务</span><small>专注中</small></button>
      <button aria-pressed=${scene === 'focus-hover'} onClick=${() => selectScene('focus-hover')}><span>番茄钟 · 悬停卡片</span><small>356px</small></button>
      <button aria-pressed=${scene === 'slacking'} onClick=${() => selectScene('slacking')}><span>摸鱼 / 间歇提醒</span><small>+四边光效</small></button>
      <button aria-pressed=${scene === 'nook-alert'} onClick=${() => selectScene('nook-alert')}><span>Nook 强提醒挂起</span><small>任务/服务</small></button>
      <button aria-pressed=${scene === 'toast'} onClick=${() => selectScene('toast')}><span>瞬态吐司反馈</span><small>1.6s</small></button>
      <button aria-pressed=${scene === 'board'} onClick=${() => selectScene('board')}><span>IslandBoard 控制板</span><small>点击展开</small></button>
      <p>屏幕边缘光效 (ReminderGlow)</p>
      <button aria-pressed=${glow} onClick=${() => setGlow(v => !v)}>
        <span>四边 28pt 呼吸微光</span><small>${glow ? '开启' : '关闭'}</small>
      </button>
    </div>

    <div className="stage-desk">
      ${glow && html`<div className="glow-frame" />`}
      <div className="menubar-strip">
        <div className="left"><span>Finder</span><span>文件</span><span>编辑</span><span>视图</span></div>
        <div className="right"><span className="mono">18:42</span></div>
      </div>

      <div className="island-wrap">
        ${scene === 'idle' && html`
          <div className="island idle" onClick=${() => selectScene('board')} title="点击展开控制板">
            <span className="cam" />
          </div>
        `}

        ${scene === 'focus' && html`
          <div className="island compact" onClick=${() => selectScene('focus-hover')}>
            <span style=${{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <span className="island-ring" />
              <span>核对 Hub 账单同步脚本</span>
            </span>
            <span className="mono" style=${{ fontSize: 12.5, color: 'var(--clay)' }}>${paused ? '已暂停' : '18:42'}</span>
          </div>
        `}

        ${scene === 'focus-hover' && html`
          <div className="island card">
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style=${{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'rgba(250,249,245,0.62)' }}>
                <${Icon} n="timer" s="sm" /><span>Nook 今日待办 · 番茄专注 (25m)</span>
              </span>
              <span className="mono" style=${{ fontSize: 14, color: 'var(--clay)' }}>${taskDone ? '已完成' : paused ? '暂停 18:42' : '18:42'}</span>
            </div>
            <div style=${{ fontSize: 14, color: 'var(--on-ink)' }}>核对 Hub 账单同步脚本与订阅汇率边界</div>
            <div style=${{ height: 4, borderRadius: 4, background: 'rgba(250,249,245,0.12)', overflow: 'hidden' }}>
              <div style=${{ width: taskDone ? '100%' : '64%', height: '100%', background: 'var(--clay)' }} />
            </div>
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 }}>
              <button className="island-btn primary" onClick=${() => setTaskDone(true)}>
                <${Icon} n="check" s="sm" /><span>${taskDone ? '已同步回 Nook' : '完成 Nook 任务'}</span>
              </button>
              <div style=${{ display: 'flex', gap: 5 }}>
                <button className="island-btn" onClick=${() => setPaused(p => !p)}>
                  <${Icon} n=${paused ? 'play' : 'pause'} s="sm" /><span>${paused ? '继续' : '暂停'}</span>
                </button>
                <button className="island-btn" onClick=${() => selectScene('slacking')}>
                  <${Icon} n="coffee" s="sm" /><span>摸鱼 5m</span>
                </button>
              </div>
            </div>
          </div>
        `}

        ${scene === 'slacking' && html`
          <div className="island card">
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style=${{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--clay)' }}>
                <${Icon} n="coffee" s="sm" /><span>间歇提醒 · 已连续活跃 50 分钟</span>
              </span>
              <span className="mono" style=${{ fontSize: 11.5, color: 'rgba(250,249,245,0.55)' }}>09:30–18:30</span>
            </div>
            <div style=${{ fontSize: 14 }}>起来接杯水、看远处 5 分钟，别一直盯屏幕。</div>
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <button className="island-btn primary" onClick=${() => { setGlow(false); setScene('focus'); }}>
                <${Icon} n="timer" s="sm" /><span>进入 5 分钟摸鱼倒计时</span>
              </button>
              <div style=${{ display: 'flex', gap: 5 }}>
                <button className="island-btn" onClick=${() => setGlow(false)}>10m 后再催</button>
                <button className="island-btn" onClick=${() => { setGlow(false); setScene('idle'); }}>跳过本次</button>
              </div>
            </div>
          </div>
        `}

        ${scene === 'nook-alert' && html`
          <div className="island card">
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style=${{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--clay)' }}>
                <${Icon} n="bell" s="sm" /><span>Nook 强提醒 · 2 项待处理</span>
              </span>
              <span className="mono" style=${{ fontSize: 11, color: 'rgba(250,249,245,0.55)' }}>常驻至确认</span>
            </div>
            <div className="island-list">
              <div className="island-item">
                <${Icon} n="check" s="sm" />
                <div style=${{ flex: 1, minWidth: 0 }}>
                  <div>下午 16:30 复盘与周报汇总</div>
                  <div style=${{ fontSize: 11, color: 'rgba(250,249,245,0.55)' }}>Google Tasks · 准点提醒</div>
                </div>
                <button className="island-btn primary" onClick=${() => setGlow(false)}>完成</button>
                <button className="island-btn">延后 10m</button>
              </div>
              <div className="island-item">
                <${Icon} n="alert" s="sm" />
                <div style=${{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style=${{ fontSize: 12 }}>com.cliproxy.api 异常退出 (Exit 1)</div>
                  <div style=${{ fontSize: 11, color: 'rgba(250,249,245,0.55)' }}>Nook Launchd 监控 · 1 分钟前</div>
                </div>
                <button className="island-btn primary">重启服务</button>
              </div>
            </div>
          </div>
        `}

        ${scene === 'toast' && html`
          <div className="island compact">
            <span style=${{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
              <${Icon} n="check" s="sm" />
              <span>已复制译文并替换输入框选中文字</span>
            </span>
            <span className="kbd dark">180ms</span>
          </div>
        `}

        ${scene === 'board' && html`
          <div className="island board">
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style=${{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
                <${Mark} size=${15} ink="#FAF9F5" /><span>Lasso × Nook 顶部中枢</span>
              </span>
              <span className="mono" style=${{ fontSize: 11, color: 'rgba(250,249,245,0.55)' }}>点击刘海切换</span>
            </div>
            <div className="island-grid">
              <button className="island-tile on" onClick=${() => selectScene('focus')}><${Icon} n="timer" /><span>番茄专注</span></button>
              <button className="island-tile"><${Icon} n="scan" /><span>区域截图</span></button>
              <button className="island-tile"><${Icon} n="note" /><span>速记便签</span></button>
              <button className="island-tile"><${Icon} n="layout" /><span>双窗排布</span></button>
            </div>
            <div style=${{ fontSize: 11, color: 'rgba(250,249,245,0.5)', padding: '2px 2px 0' }}>Nook 今日焦点待办（点击直接开启 25m 番茄钟）</div>
            <div className="island-list">
              <div className="island-item" onClick=${() => selectScene('focus')} style=${{ cursor: 'pointer' }}>
                <${Icon} n="play" s="sm" />
                <span>核对 Hub 账单同步脚本与订阅汇率边界</span>
                <span className="meta">进行中 · 18:42</span>
              </div>
              <div className="island-item">
                <${Icon} n="timer" s="sm" />
                <span>收敛 Lasso 常驻工具集设计稿</span>
                <span className="meta">25m</span>
              </div>
              <div className="island-item">
                <${Icon} n="zap" s="sm" />
                <span>Claude Max 5h 窗口将于 22 分钟后自然重置</span>
                <span className="meta">Nook Token</span>
              </div>
            </div>
          </div>
        `}
      </div>

      <div style=${{ marginTop: 'auto', width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ink-3)', paddingTop: 24 }}>
        <span>提示：可直接点击上方墨色刘海岛内的按钮交互切换状态</span>
        <span>进程通信：<code className="mono">DistributedNotificationCenter</code></span>
      </div>
    </div>

    <div className="stage-notes">
      <h3>尺寸与交互准则</h3>
      <div className="measure">
        <span>窗口尺寸</span><span>固定 400 × 380 透明无边框窗口，仅图形区响应鼠标，其余穿透</span>
        <span>静默态</span><span>184 × 28px，与物理刘海重合，0 视觉打扰</span>
        <span>紧凑态</span><span>高 34px，左图标/任务名 + 右等宽倒计时</span>
        <span>展开卡片</span><span>宽 356px（控制板 384px），圆角 16px，墨色底配实心陶土主按钮</span>
        <span>四边光效</span><span>4 条 28pt 宽点击穿透窄窗，呼吸周期 2.4s，内存小于 2MB</span>
      </div>
      <ul className="doc-rules">
        <li><strong>数据不重造</strong>：任务、日程、额度重置与自定义规则仍在 Nook 的 <code>Reminders.swift</code> 规划；触发时发本地广播点亮刘海岛。</li>
        <li><strong>双向闭环</strong>：在刘海岛点击「完成任务」或「延后 10m」直接回调 Nook 更新 Google Tasks / Hub 状态。</li>
      </ul>
    </div>
  </div>`;
}

/* ───────── 2. Fast API Inline Translation / Polish / OCR Stage ───────── */
function FastApiSimulator() {
  const [scene, setScene] = useState('translate');
  const [replaced, setReplaced] = useState(false);
  const [targetLang, setTargetLang] = useState('zh');

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>原位快速 API 场景</p>
      <button aria-pressed=${scene === 'translate'} onClick=${() => { setScene('translate'); setReplaced(false); }}>
        <span>划词 · 原位流式翻译</span><small>180ms</small>
      </button>
      <button aria-pressed=${scene === 'polish'} onClick=${() => { setScene('polish'); setReplaced(false); }}>
        <span>划词 · 润色并替换原文</span><small>↵ 回填</small>
      </button>
      <button aria-pressed=${scene === 'ocr'} onClick=${() => setScene('ocr')}>
        <span>截图 OCR · 原位翻译</span><small>双语对照</small>
      </button>
      <button aria-pressed=${scene === 'settings'} onClick=${() => setScene('settings')}>
        <span>预设设置 · Fast API</span><small>New API</small>
      </button>
    </div>

    <div className="stage-desk">
      ${(scene === 'translate' || scene === 'polish') && html`
        <div className="reader-card">
          <div style=${{ fontSize: 11.5, color: 'var(--ink-4)', marginBottom: 6 }}>示例编辑器 / 网页输入框</div>
          ${replaced ? html`
            <div>
              <span className="hl-sel">该窗口保持无边框与非激活状态，使先前的应用程序始终维持在最前台，同时通过按形状命中测试放行背景点击。</span>
              <span style=${{ marginLeft: 8 }} className="l-pill olive"><${Icon} n="check" s="sm" />已原地替换选中文本</span>
            </div>
          ` : html`
            <div>
              The borderless panel <span className="hl-sel">takes keyboard input without activating the host app, keeping the previous application frontmost while forwarding clicks outside the shape.</span>
            </div>
          `}
        </div>

        <div style=${{ marginTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="bar-capsule">
            <button className=${'bar-btn ' + (scene === 'translate' ? 'on' : '')} onClick=${() => setScene('translate')}>
              <${Icon} n="languages" s="sm" /><span>翻译</span>
            </button>
            <button className=${'bar-btn ' + (scene === 'polish' ? 'on' : '')} onClick=${() => setScene('polish')}>
              <${Icon} n="zap" s="sm" /><span>润色</span>
            </button>
            <button className="bar-btn"><span>解释</span></button>
            <button className="bar-btn"><${Icon} n="note" s="sm" /><span>入便签</span></button>
            <span className="bar-sep" />
            <button className="bar-btn" title="更多预设">···</button>
          </div>

          <div className="fast-card">
            <div className="fast-head">
              <span style=${{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="tag-dot clay" />
                <span>${scene === 'translate' ? '快速翻译 · New API (gpt-4.1-mini)' : '英文润色 · New API (claude-haiku-4-5)'}</span>
              </span>
              <div style=${{ display: 'flex', alignItems: 'center', gap: 6 }}>
                ${scene === 'translate' && html`
                  <div className="l-seg" style=${{ transform: 'scale(0.92)' }}>
                    <button className=${targetLang === 'zh' ? 'on' : ''} onClick=${() => setTargetLang('zh')}>中</button>
                    <button className=${targetLang === 'en' ? 'on' : ''} onClick=${() => setTargetLang('en')}>EN</button>
                  </div>
                `}
                <span className="mono" style=${{ fontSize: 11, color: 'var(--clay-ink)' }}>TTFT 172ms</span>
              </div>
            </div>

            <div className="fast-body">
              ${scene === 'translate' ? (
                targetLang === 'zh'
                  ? '在不激活宿主应用的情况下接收键盘输入，使原先的应用保持在最前台，同时将图形外部的点击穿透传递。'
                  : 'Receives keyboard input without activating the host application, keeping the prior app frontmost while passing through outside clicks.'
              ) : (
                'accepts keyboard focus without activating the app, leaving the frontmost window undisturbed while passing through outside clicks.'
              )}
            </div>

            <div className="fast-foot">
              <div style=${{ display: 'flex', gap: 6 }}>
                <button className="l-btn primary" onClick=${() => setReplaced(true)}>
                  <${Icon} n="replace" s="sm" /><span>替换选中文本</span><span className="kbd dark">↵</span>
                </button>
                <button className="l-btn">
                  <${Icon} n="copy" s="sm" /><span>复制</span><span className="kbd">⌘C</span>
                </button>
              </div>
              <div style=${{ display: 'flex', gap: 5 }}>
                <button className="l-btn" title="钉为桌面贴图"><${Icon} n="pin" s="sm" /><span>贴图</span></button>
                <button className="l-btn" title="转入主窗口继续追问"><${Icon} n="external" s="sm" /></button>
              </div>
            </div>
          </div>
        </div>
      `}

      ${scene === 'ocr' && html`
        <div className="reader-card" style=${{ background: 'var(--sunken)', borderStyle: 'dashed' }}>
          <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="l-pill clay"><${Icon} n="scan" s="sm" />截图原地编辑器 · Vision OCR 已识别 3 行</span>
            <span className="mono" style=${{ fontSize: 11.5, color: 'var(--ink-3)' }}>512 × 240</span>
          </div>
          <div className="mono" style=${{ fontSize: 12.5, padding: 10, background: 'var(--surface)', borderRadius: 8, border: '0.5px solid var(--line)' }}>
            Error: EACCES: permission denied, open '/usr/local/etc/nginx/nginx.conf'
          </div>
          <div className="fast-card" style=${{ width: '100%', marginTop: 10 }}>
            <div className="fast-head">
              <span>OCR 翻译与速解 · New API</span>
              <span className="mono">195ms</span>
            </div>
            <div className="fast-body" style=${{ fontSize: 13.5 }}>
              权限不足：无法写入 <code>/usr/local/etc/nginx/nginx.conf</code>。检查当前用户对该目录的所有权，或确认 Homebrew 服务是否曾用 sudo 启动。
            </div>
            <div className="fast-foot">
              <button className="l-btn primary"><${Icon} n="copy" s="sm" /><span>复制译文</span></button>
              <button className="l-btn"><${Icon} n="terminal" s="sm" /><span>发给 Codex 诊断</span></button>
            </div>
          </div>
        </div>
      `}

      ${scene === 'settings' && html`
        <div className="doc-card" style=${{ width: '100%', maxWidth: 480 }}>
          <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style=${{ margin: 0 }}>编辑预设 · 翻译</h3>
            <span className="l-pill clay">target: 'api'</span>
          </div>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
            <div>
              <div style=${{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 4 }}>执行渠道 (Target)</div>
              <div className="l-seg">
                <button className="on"><${Icon} n="zap" s="sm" /> New API (直连极速)</button>
                <button>ChatGPT</button>
                <button>Gemini</button>
                <button>Codex</button>
              </div>
            </div>
            <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style=${{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 4 }}>模型 (复用 media-service 列表)</div>
                <div className="mono" style=${{ padding: '6px 10px', background: 'var(--sunken)', borderRadius: 7, border: '0.5px solid var(--line-strong)', fontSize: 12 }}>gpt-4.1-mini</div>
              </div>
              <div>
                <div style=${{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 4 }}>结果呈现方式</div>
                <div style=${{ padding: '6px 10px', background: 'var(--clay-wash-2)', color: 'var(--clay-ink)', borderRadius: 7, border: '0.5px solid var(--clay-line)', fontSize: 12.5 }}>动作条原位流式卡片</div>
              </div>
            </div>
            <div>
              <div style=${{ fontSize: 11.5, color: 'var(--ink-3)', marginBottom: 4 }}>提示词模板</div>
              <div className="mono" style=${{ padding: 10, background: 'var(--sunken)', borderRadius: 8, border: '0.5px solid var(--line)', fontSize: 12, lineHeight: 1.55 }}>
                中英互译以下内容，保持原有术语与代码格式，只输出译文：\n\n{'{{selection}}'}
              </div>
            </div>
          </div>
        </div>
      `}
    </div>

    <div className="stage-notes">
      <h3>为什么能压到 200ms 内</h3>
      <div className="measure">
        <span>凭证复用</span><span>直接复用 <code>media-service.ts</code> 已有的 <code>baseURL</code> 与 <code>safeStorage</code> 加密密钥</span>
        <span>流式协议</span><span>主进程直连 <code>/v1/chat/completions</code> SSE，不走网页 DOM 注入或 CLI 冷启动</span>
        <span>原位生长</span><span><code>ActionBar</code> 窗口在空闲侧动态增高 160–220px 容纳 <code>.fast-card</code></span>
        <span>一键回填</span><span>按 <code>↵</code> 将译文/润色结果写回剪贴板并向原焦点窗口发送粘贴，随后恢复原剪贴板</span>
      </div>
    </div>
  </div>`;
}

/* ───────── 3. EdgeNotes (Raycast Notes + EdgeMark) Stage ───────── */
function EdgeNotesSimulator() {
  const [scene, setScene] = useState('scratchpad');
  const [pinned, setPinned] = useState(false);
  const [tagFilter, setTagFilter] = useState('all');

  const notes = [
    { id: 'scratch', title: 'Scratchpad · 速记', tag: 'clay', updated: '刚刚', preview: '常驻置顶槽位，无需起标题，划词/截图可一键追加' },
    { id: 'n1', title: 'release-checklist.md', tag: 'olive', updated: '14:20', preview: 'npm run build && npm run ui:shots 截图逐张验收' },
    { id: 'n2', title: 'hub-sync-api.md', tag: 'clay', updated: '昨天', preview: 'GET /api/v1/modules/subscription_usage 字段对齐' },
    { id: 'n3', title: 'worktree-commands.md', tag: 'ink', updated: '周一', preview: 'git worktree add .worktree/feature-island -b feat/island' },
  ];

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>便签交互形态</p>
      <button aria-pressed=${scene === 'scratchpad'} onClick=${() => setScene('scratchpad')}>
        <span>右边缘滑出 · 速记板</span><small>Scratchpad</small>
      </button>
      <button aria-pressed=${scene === 'files'} onClick=${() => setScene('files')}>
        <span>本地 .md 列表与颜色标签</span><small>EdgeMark</small>
      </button>
      <button aria-pressed=${scene === 'slash'} onClick=${() => setScene('slash')}>
        <span>斜杠命令 · 转 Nook 待办</span><small>/ 命令</small>
      </button>
      <button aria-pressed=${scene === 'pin-note'} onClick=${() => setScene('pin-note')}>
        <span>撕下为桌面贴图 (Pin)</span><small>常驻对照</small>
      </button>
    </div>

    <div className="stage-desk" style=${{ alignItems: 'stretch', gap: 10 }}>
      <div className="edge-trigger" title="屏幕右边缘 5px 触发条（防误触延迟 0.25s）" />

      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ink-3)' }}>
        <span>右边缘停靠 <code>0.25s</code> 滑出抽屉 · 全局热键直达置顶 <code>Scratchpad.md</code></span>
        <span className="l-pill clay">纯本地 .md 目录</span>
      </div>

      ${scene === 'pin-note' && html`
        <div className="doc-card" style=${{ background: 'var(--bg)', boxShadow: 'var(--shadow-window)', border: '1px solid var(--clay-line)', maxWidth: 360 }}>
          <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 8, borderBottom: '0.5px solid var(--line)' }}>
            <span style=${{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--clay-ink)' }}>
              <${Icon} n="pin" s="sm" /><span>已撕下钉在桌面 · Scratchpad.md</span>
            </span>
            <span className="mono" style=${{ fontSize: 11, color: 'var(--ink-4)' }}>280 × 190</span>
          </div>
          <div style=${{ paddingTop: 10, fontFamily: 'var(--font-text)', fontSize: 13.5, lineHeight: 1.65 }}>
            <div>- [x] 检查 Nook <code>Reminders.swift</code> 通知分类</div>
            <div>- [ ] 联调 <code>DistributedNotificationCenter</code> 载荷</div>
            <div className="mono" style=${{ fontSize: 12, marginTop: 6, padding: 6, background: 'var(--sunken)', borderRadius: 6 }}>
              launchctl print gui/$UID/com.cliproxy.api
            </div>
          </div>
        </div>
      `}

      <div className="edge-drawer">
        <div className="edge-top">
          <div className="edge-tabs">
            <button className=${'edge-tab ' + (scene !== 'files' ? 'on' : '')} onClick=${() => setScene('scratchpad')}>
              <span className="tag-dot clay" /><span>Scratchpad</span>
            </button>
            <button className=${'edge-tab ' + (scene === 'files' ? 'on' : '')} onClick=${() => setScene('files')}>
              <${Icon} n="folder" s="sm" /><span>笔记库 (14)</span>
            </button>
          </div>
          <button className=${'l-btn ' + (pinned ? 'clay' : '')} style=${{ height: 26, padding: '0 8px' }} onClick=${() => setPinned(p => !p)} title="固定面板不自动收起">
            <${Icon} n="pin" s="sm" /><span>${pinned ? '已固定' : '固定'}</span>
          </button>
          <button className="l-btn" style=${{ height: 26, padding: '0 8px' }} onClick=${() => setScene('pin-note')} title="撕下为独立桌面贴图">
            <${Icon} n="external" s="sm" />
          </button>
        </div>

        ${scene === 'files' ? html`
          <div className="edge-editor" style=${{ gap: 8 }}>
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <div style=${{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className=${'l-pill ' + (tagFilter === 'all' ? 'clay' : '')} onClick=${() => setTagFilter('all')}>全部</button>
                <button className="l-pill" onClick=${() => setTagFilter('clay')}><span className="tag-dot clay" /> 进行中</button>
                <button className="l-pill" onClick=${() => setTagFilter('olive')}><span className="tag-dot olive" /> 归档</button>
              </div>
              <button className="l-btn" style=${{ height: 25, padding: '0 8px' }}><${Icon} n="plus" s="sm" /><span>新建 .md</span></button>
            </div>
            ${notes.filter(n => tagFilter === 'all' || n.tag === tagFilter).map(n => html`
              <div key=${n.id} onClick=${() => setScene('scratchpad')} style=${{ padding: '9px 11px', borderRadius: 9, background: 'var(--surface)', border: '0.5px solid var(--line-strong)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style=${{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, color: 'var(--ink)' }}>
                    <span className=${'tag-dot ' + n.tag} /><span>${n.title}</span>
                  </span>
                  <span className="mono" style=${{ fontSize: 11, color: 'var(--ink-4)' }}>${n.updated}</span>
                </div>
                <div style=${{ fontSize: 12, color: 'var(--ink-3)' }}>${n.preview}</div>
              </div>
            `)}
          </div>
        ` : html`
          <div className="edge-editor">
            <div style=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--ink-3)' }}>
              <span>Scratchpad.md · 置顶速记（自动保存）</span>
              <span className="mono">⌘1..9 切历史槽</span>
            </div>
            <div style=${{ color: 'var(--ink)' }}>
              <div style=${{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 6 }}>今日临时草稿与接口摘录</div>
              <div>- [x] 复用 <code>media-service.ts</code> 的 New API 密钥存储</div>
              <div>- [ ] 把选中行一键推入 Nook 今日待办</div>
              <div className="mono" style=${{ fontSize: 12, margin: '8px 0', padding: '8px 10px', background: 'var(--sunken)', borderRadius: 8, border: '0.5px solid var(--line)' }}>
                # 划词追加于 17:45\nAXUIElementSetAttributeValue(win, kAXPositionAttribute, posRef);
              </div>
            </div>

            ${scene === 'slash' && html`
              <div className="super-menu" style=${{ width: '100%' }}>
                <div className="super-head"><span>斜杠命令 (/)</span><span className="mono">↑↓ 选择 · ↵ 插入</span></div>
                <button className="super-item on"><${Icon} n="check" s="sm" /><span>任务列表 (- [ ])</span><span className="right">/task</span></button>
                <button className="super-item"><${Icon} n="code" s="sm" /><span>代码块 (Code Block)</span><span className="right">/code</span></button>
                <button className="super-item"><${Icon} n="send" s="sm" /><span>将当前未完成项推送至 Nook 待办</span><span className="right">/nook</span></button>
              </div>
            `}
          </div>
        `}

        <div className="edge-foot">
          <span className="mono">~/Documents/Notes/Scratchpad.md</span>
          <span>外部修改自动同步 · <button style=${{ color: 'var(--clay-ink)' }} onClick=${() => setScene(scene === 'slash' ? 'scratchpad' : 'slash')}>点此预览 / 命令</button></span>
        </div>
      </div>
    </div>

    <div className="stage-notes">
      <h3>Raycast Notes + EdgeMark 融合点</h3>
      <div className="measure">
        <span>置顶速记</span><span>第一栏永远是 <code>Scratchpad.md</code>，快捷键秒开即写，动作条点「入便签」直接追加</span>
        <span>边缘滑出</span><span>左右屏幕边缘皆可配置，带 <code>0.15s / 0.35s / 0.7s</code> 激活延迟与四角排除</span>
        <span>纯本地 .md</span><span>直接读写本地目录，支持文件监听（外部用 Cursor/Obsidian 改完立即刷新）</span>
        <span>撕下贴图</span><span>点右上角撕下按钮，直接复用 Lasso 现有 <code>pins.ts</code> 变成常驻桌面贴图</span>
      </div>
    </div>
  </div>`;
}

/* ───────── 5. Finder Super Action Panel (iRightMouse Route B) Stage ───────── */
function FinderSimulator() {
  const [scene, setScene] = useState('selected');
  const [lastAction, setLastAction] = useState('在 Finder 内按鼠标中键 / 长按右键 0.25s 弹出');

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>Finder 触发上下文</p>
      <button aria-pressed=${scene === 'selected'} onClick=${() => setScene('selected')}>
        <span>选中文件 / 图片时</span><small>打开/转换/AI</small>
      </button>
      <button aria-pressed=${scene === 'empty'} onClick=${() => setScene('empty')}>
        <span>目录空白处触发</span><small>新建模板/终端</small>
      </button>
      <button aria-pressed=${scene === 'move'} onClick=${() => setScene('move')}>
        <span>发送 / 软链到 Worktree</span><small>个人化</small>
      </button>
    </div>

    <div className="stage-desk" style=${{ gap: 14 }}>
      <div className="finder-mock">
        <div className="finder-bar">
          <${Icon} n="folder" s="sm" />
          <span className="mono">~/WorkSpace/Code/Github/mac-ai-prompt/docs</span>
          <span style=${{ marginLeft: 'auto', color: 'var(--clay-ink)' }}>${lastAction}</span>
        </div>
        <div className=${'finder-row ' + (scene === 'selected' || scene === 'move' ? 'sel' : '')}>
          <${Icon} n="image" s="sm" /><span>architecture-diagram.png</span>
          <span className="mono" style=${{ marginLeft: 'auto', fontSize: 11.5 }}>1.8 MB · PNG</span>
        </div>
        <div className=${'finder-row ' + (scene === 'selected' || scene === 'move' ? 'sel' : '')}>
          <${Icon} n="note" s="sm" /><span>handoff.md</span>
          <span className="mono" style=${{ marginLeft: 'auto', fontSize: 11.5 }}>14 KB · Markdown</span>
        </div>
      </div>

      <div className="super-menu">
        ${scene === 'selected' && html`
          <div className="super-head">
            <span>已选 2 项 · mac-ai-prompt/docs</span>
            <span className="mono">中键 / ⌥右键</span>
          </div>
          <div className="super-quick">
            <button className="super-qbtn on" onClick=${() => setLastAction('已用 Cursor 打开选中项')}><${Icon} n="code" /><span>Cursor</span></button>
            <button className="super-qbtn" onClick=${() => setLastAction('已在当前目录打开终端')}><${Icon} n="terminal" /><span>终端</span></button>
            <button className="super-qbtn" onClick=${() => setLastAction('已复制 2 条绝对路径')}><${Icon} n="copy" /><span>复制路径</span></button>
            <button className="super-qbtn" onClick=${() => setLastAction('已彻底删除（跳过废纸篓）')}><${Icon} n="trash" /><span>彻底删除</span></button>
          </div>
          <div className="super-group-label">图像与 AI 处理</div>
          <button className="super-item" onClick=${() => setLastAction('已原地生成 architecture-diagram.webp')}><${Icon} n="image" s="sm" /><span>转为 WebP / HEIC / JPG</span><span className="right">原地生成</span></button>
          <button className="super-item" onClick=${() => setLastAction('已提取图片 OCR 文字到剪贴板')}><${Icon} n="scan" s="sm" /><span>OCR 提取文字 / 钉为桌面贴图</span><span className="right">Vision</span></button>
          <button className="super-item" onClick=${() => setLastAction('已携带 2 个文件路径唤起 Codex 任务')}><${Icon} n="zap" s="sm" /><span>发给 Codex / Claude 分析此文件</span><span className="right">⌘↵</span></button>
          <div className="super-group-label">文件整理</div>
          <button className="super-item" onClick=${() => setScene('move')}><${Icon} n="folder" s="sm" /><span>移动到常用目录 / 活跃 Worktree…</span><span className="right">→</span></button>
          <button className="super-item" onClick=${() => setLastAction('已切换隐藏文件显示状态 (⌘⇧.)')}><${Icon} n="sliders" s="sm" /><span>显示 / 隐藏点文件与扩展名</span><span className="right">⌘⇧.</span></button>
        `}

        ${scene === 'empty' && html`
          <div className="super-head">
            <span>当前目录 · mac-ai-prompt/docs</span>
            <span className="mono">在此新建</span>
          </div>
          <div className="super-group-label">在此新建文件（新建后可直接用编辑器打开）</div>
          <button className="super-item on" onClick=${() => setLastAction('已创建 untitled.md 并用 Cursor 打开')}><${Icon} n="note" s="sm" /><span>Markdown 文档 (.md)</span><span className="right">1</span></button>
          <button className="super-item" onClick=${() => setLastAction('已创建 script.ts')}><${Icon} n="code" s="sm" /><span>TypeScript / Python / Shell 脚本</span><span className="right">2</span></button>
          <button className="super-item" onClick=${() => setLastAction('已创建纯文本与 Office 模板')}><${Icon} n="note" s="sm" /><span>TXT / Word (.docx) / Excel (.xlsx)</span><span className="right">3</span></button>
          <div className="super-group-label">目录快捷动作</div>
          <button className="super-item" onClick=${() => setLastAction('已将剪贴板图片存为 shot-1842.png')}><${Icon} n="image" s="sm" /><span>将剪贴板图片直接存为当前目录文件</span><span className="right">⌘V</span></button>
          <button className="super-item" onClick=${() => setLastAction('已在 Cursor 中打开整个仓库目录')}><${Icon} n="terminal" s="sm" /><span>在 Cursor / Ghostty 中打开当前目录</span><span className="right">⌘O</span></button>
        `}

        ${scene === 'move' && html`
          <div className="super-head">
            <span>移动 / 软链选中项到…</span>
            <button style=${{ color: 'var(--clay)', fontSize: 11.5 }} onClick=${() => setScene('selected')}>← 返回</button>
          </div>
          <div className="super-group-label">当前活跃 Git Worktree（自动扫描）</div>
          <button className="super-item on" onClick=${() => setLastAction('已复制到 mac-ai-prompt 主工作区')}><${Icon} n="code" s="sm" /><span>mac-ai-prompt (main)</span><span className="right">复制 / 软链</span></button>
          <button className="super-item" onClick=${() => setLastAction('已移动到 personal-data-hub')}><${Icon} n="code" s="sm" /><span>personal-data-hub (Nook)</span><span className="right">移动</span></button>
          <div className="super-group-label">常用收藏目录（对标 iRightMouse）</div>
          <button className="super-item"><${Icon} n="folder" s="sm" /><span>~/Downloads</span><span className="right">移动</span></button>
          <button className="super-item"><${Icon} n="folder" s="sm" /><span>~/Pictures/Screenshots</span><span className="right">移动</span></button>
          <button className="super-item"><${Icon} n="folder" s="sm" /><span>~/Documents/Notes</span><span className="right">移动</span></button>
        `}
      </div>
    </div>

    <div className="stage-notes">
      <h3>路线 B 相比 .appex 的优势</h3>
      <div className="measure">
        <span>零签名包袱</span><span>无需维护独立 Finder Sync <code>.appex</code> 插件与沙盒 App Group，不与 iCloud/网盘图标冲突</span>
        <span>秒读选中项</span><span>原生模块通过 <code>ScriptingBridge</code> / AX 读取当前 Finder 窗口路径与选中文件列表（小于 15ms）</span>
        <span>深度定制</span><span>支持顶部 4 宫格高频按钮、剪贴板图片直接落盘、一键发给 Codex 或软链到活跃 Worktree</span>
        <span>服务兜底</span><span>同时保留 <code>file-services.mm</code> 系统右键「服务」菜单项</span>
      </div>
    </div>
  </div>`;
}

/* ───────── 6. Window Snap & Workspace Layout (Rectangle Replacement) Stage ───────── */
const SNAP_LAYOUTS = {
  'left-half': { label: '左半屏', key: '⌃⌥←', a: { left: '2%', top: '10%', width: '47%', height: '86%' }, b: { left: '52%', top: '18%', width: '44%', height: '70%' } },
  'right-half': { label: '右半屏', key: '⌃⌥→', a: { left: '51%', top: '10%', width: '47%', height: '86%' }, b: { left: '4%', top: '18%', width: '44%', height: '70%' } },
  'maximize': { label: '最大化', key: '⌃⌥↵', a: { left: '2%', top: '10%', width: '96%', height: '86%' }, b: { left: '8%', top: '20%', width: '40%', height: '60%' } },
  'center': { label: '居中阅读', key: '⌃⌥C', a: { left: '15%', top: '13%', width: '70%', height: '80%' }, b: { left: '4%', top: '22%', width: '35%', height: '60%' } },
  'thirds': { label: '左 2/3 + 右 1/3', key: '⌃⌥E', a: { left: '2%', top: '10%', width: '63%', height: '86%' }, b: { left: '67%', top: '10%', width: '31%', height: '86%' } },
  'workspace-dev': { label: '双窗编码工作区', key: '⌃⌥W', a: { left: '2%', top: '10%', width: '58%', height: '86%' }, b: { left: '61%', top: '10%', width: '37%', height: '86%' } },
};

function WindowSnapSimulator() {
  const [layout, setLayout] = useState('workspace-dev');
  const cur = SNAP_LAYOUTS[layout];

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>Rectangle 快捷键分屏</p>
      ${Object.entries(SNAP_LAYOUTS).map(([id, item]) => html`
        <button key=${id} aria-pressed=${layout === id} onClick=${() => setLayout(id)}>
          <span>${item.label}</span><small>${item.key}</small>
        </button>
      `)}
    </div>

    <div className="stage-desk">
      <div className="snap-screen">
        <div className="menubar-strip" style=${{ height: 22, fontSize: 11 }}>
          <span>Cursor · mac-ai-prompt</span>
          <span className="mono">${cur.label} (${cur.key})</span>
        </div>

        <div className="snap-win" style=${{ ...cur.b, zIndex: 1, opacity: layout === 'maximize' ? 0.25 : 0.92 }}>
          <div className="snap-win-head"><${Icon} n="terminal" s="sm" /><span>Ghostty / Chrome 对照窗</span></div>
          <div className="mono" style=${{ padding: 10, fontSize: 11, color: 'var(--ink-3)' }}>npm run build · UI rule check passed.</div>
        </div>

        <div className="snap-win" style=${{ ...cur.a, zIndex: 2, borderColor: 'var(--clay)' }}>
          <div className="snap-win-head" style=${{ background: 'var(--clay-wash)', color: 'var(--clay-ink)' }}>
            <${Icon} n="code" s="sm" /><span>焦点窗口 · Cursor</span>
            <span className="mono" style=${{ marginLeft: 'auto' }}>${cur.a.width} × ${cur.a.height}</span>
          </div>
          <div style=${{ padding: 12, fontSize: 12.5, color: 'var(--ink-2)' }}>
            通过 <code>AXUIElementSetAttributeValue</code> 直接设置 <code>kAXPositionAttribute</code> 与 <code>kAXSizeAttribute</code>，原生零延迟。
          </div>
        </div>

        <div className="snap-hud">
          ${Object.entries(SNAP_LAYOUTS).map(([id, item]) => html`
            <button key=${id} className=${layout === id ? 'on' : ''} onClick=${() => setLayout(id)}>
              <span>${item.label}</span>
            </button>
          `)}
        </div>
      </div>
    </div>

    <div className="stage-notes">
      <h3>极简高维护性方案</h3>
      <div className="measure">
        <span>代码体积</span><span>约 150 行 Objective-C++，直接合入现有 <code>native/</code> 模块</span>
        <span>键位兼容</span><span>默认保留你现有的 Rectangle 键位（<code>⌃⌥ + 方向键/↵/C/⌫</code>），卸载 Rectangle 立省 61MB 内存</span>
        <span>多窗工作区</span><span>比 Rectangle 多一步：支持一键把「编辑器 + 浏览器/终端」同时按比例排好</span>
        <span>克制边界</span><span>不做鼠标拖拽撞屏幕边缘（macOS 15+ 原生已内置）</span>
      </div>
    </div>
  </div>`;
}

/* ───────── 7. Nook Launchd Module (launchd-ui merged into Nook) Stage ───────── */
const SAMPLE_AGENTS = [
  { label: 'com.sm5145.codexhost', mode: 'KeepAlive', pid: '982', exit: '0', status: 'run', desc: 'CodexHost 守护服务' },
  { label: 'com.personal-hub.agent', mode: 'RunAtLoad', pid: '1156', exit: '0', status: 'run', desc: 'Nook 本地同步代理' },
  { label: 'com.cliproxy.api', mode: 'KeepAlive', pid: '—', exit: '1', status: 'err', desc: 'CLI Proxy 本地网关（端口占用退出）' },
  { label: 'com.BrowserRelay.server', mode: 'KeepAlive', pid: '1122', exit: '0', status: 'run', desc: 'Chrome Browser Relay 桥接' },
  { label: 'cc.See.server', mode: 'StartInterval · 60s', pid: '1137', exit: '0', status: 'run', desc: 'See 本地服务' },
];

function NookLaunchdSimulator() {
  const [scene, setScene] = useState('list');
  const [agents, setAgents] = useState(SAMPLE_AGENTS);

  const kickstart = label => {
    setAgents(list => list.map(a => a.label === label ? { ...a, status: 'run', pid: '48210', exit: '0' } : a));
  };

  return html`<div className="stage">
    <div className="stage-scenes">
      <p>Nook · 本机服务 (Launchd)</p>
      <button aria-pressed=${scene === 'list'} onClick=${() => setScene('list')}>
        <span>服务总览与异常高亮</span><small>~/Library</small>
      </button>
      <button aria-pressed=${scene === 'logs'} onClick=${() => setScene('logs')}>
        <span>尾部日志与一键重启</span><small>stderr</small>
      </button>
      <button aria-pressed=${scene === 'plist'} onClick=${() => setScene('plist')}>
        <span>Plist 参数检视与告警</span><small>联动刘海岛</small>
      </button>
    </div>

    <div className="stage-desk">
      <div className="nook-win">
        <div className="nook-head">
          <div>
            <div style=${{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style=${{ margin: 0, fontSize: 18 }}>本机守护进程 · LaunchAgents</h3>
              <span className="l-pill olive">4 运行中</span>
              ${agents.some(a => a.status === 'err') && html`<span className="l-pill danger">1 异常退出</span>`}
            </div>
            <div style=${{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>
              扫描 <code>~/Library/LaunchAgents/*.plist</code> · 实时状态来自 <code>launchctl print gui/501</code>
            </div>
          </div>
          <div className="l-seg">
            <button className=${scene === 'list' ? 'on' : ''} onClick=${() => setScene('list')}>全部服务</button>
            <button className=${scene === 'logs' ? 'on' : ''} onClick=${() => setScene('logs')}>错误日志</button>
            <button className=${scene === 'plist' ? 'on' : ''} onClick=${() => setScene('plist')}>配置与提醒</button>
          </div>
        </div>

        <div className="nook-body">
          ${agents.map(a => html`
            <div key=${a.label} className=${'agent-row ' + (a.status === 'err' ? 'bad' : '')}>
              <span className=${'status-dot ' + a.status} />
              <div style=${{ minWidth: 0 }}>
                <div className="mono" style=${{ fontSize: 12.5, color: 'var(--ink)' }}>${a.label}</div>
                <div style=${{ fontSize: 11.5, color: 'var(--ink-3)' }}>${a.desc}</div>
              </div>
              <span className="mono" style=${{ fontSize: 11.5, color: 'var(--ink-3)' }}>${a.mode}</span>
              <span className="mono" style=${{ fontSize: 11.5, color: a.status === 'err' ? 'var(--danger)' : 'var(--ink-2)' }}>
                ${a.status === 'err' ? 'Exit ' + a.exit : 'PID ' + a.pid}
              </span>
              <div style=${{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                <button className=${'l-btn ' + (a.status === 'err' ? 'primary' : '')} style=${{ height: 26, padding: '0 9px' }} onClick=${() => kickstart(a.label)}>
                  <${Icon} n="retry" s="sm" /><span>${a.status === 'err' ? '修复重启' : '重启'}</span>
                </button>
                <button className="l-btn" style=${{ height: 26, padding: '0 8px' }} onClick=${() => setScene('logs')}>日志</button>
              </div>
            </div>
          `)}

          ${scene === 'logs' && html`
            <div className="log-box">
              <div style=${{ display: 'flex', justifyContent: 'space-between', color: 'rgba(250,249,245,0.55)', marginBottom: 4 }}>
                <span>StandardErrorPath: ~/.cliproxy/stderr.log (最后 5 行)</span>
                <span>launchctl kickstart -k gui/501/com.cliproxy.api</span>
              </div>
              <div>2026-11-05 18:04:11 [ERR] listen tcp 127.0.0.1:8317: bind: address already in use</div>
              <div>2026-11-05 18:04:11 [FTL] server exited with code 1</div>
            </div>
          `}

          ${scene === 'plist' && html`
            <div className="doc-card" style=${{ background: 'var(--sunken)', padding: '11px 14px', fontSize: 12.5 }}>
              <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span><strong>异常退出自动推刘海岛提醒</strong>（当关键服务 <code>last exit code ≠ 0</code> 时通过 Nook <code>Reminders.swift</code> 告警）</span>
                <span className="l-pill clay">已启用</span>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>

    <div className="stage-notes">
      <h3>并入 Nook 的工程边界</h3>
      <div className="measure">
        <span>无需 Root</span><span>只管理用户级 <code>gui/$UID</code>（即 <code>~/Library/LaunchAgents</code>），无需安装特权 Helper</span>
        <span>原生解析</span><span>Swift 标准库 <code>PropertyListSerialization</code> 直接解析二进制/XML plist</span>
        <span>一键动作</span><span>支持 <code>kickstart -k</code>（立即重启）、<code>bootout / bootstrap</code>（停用/启用）及尾部日志预览</span>
        <span>异常联动</span><span>关键守护进程崩溃时自动触发 Nook 提醒并推上 Lasso 刘海岛</span>
      </div>
    </div>
  </div>`;
}

/* ───────── Main SpecBook Document ───────── */
const NAV_ITEMS = [
  ['architecture', '双核架构与边界', '总览'],
  ['island', '1 & 4. 刘海岛与番茄/摸鱼提醒', '批一'],
  ['fast-api', '2. 快速 API 与原位翻译卡', '批一'],
  ['launchd', '7. Nook 守护进程管理', '批一'],
  ['notes', '3. 边缘抽屉便签 (EdgeNotes)', '批二'],
  ['window-snap', '6. 窗口分屏与工作区', '批二'],
  ['finder', '5. Finder 超级动作面板', '批二'],
  ['mapping', '状态清单与代码映射', '验收'],
];

function App() {
  const [active, setActive] = useState('architecture');

  useEffect(() => {
    const io = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) setActive(e.target.id); }),
      { rootMargin: '-25% 0px -60% 0px' }
    );
    NAV_ITEMS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);

  return html`<div className="doc">
    <nav className="doc-nav" aria-label="设计稿导航">
      <div className="doc-brand"><${Mark} size=${20} /><span>Lasso × Nook</span></div>
      <div className="doc-nav-group">常驻系统工具集 · v3</div>
      ${NAV_ITEMS.map(([id, label, badge]) => html`
        <a key=${id} href=${'#' + id} className=${active === id ? 'on' : ''}>
          <span>${label}</span>
          <span className="badge">${badge}</span>
        </a>
      `)}
      <small>
        详细设计稿 · 2026-11-05<br />
        严格遵循纸上的套索与 Nook 暖纸面规范
      </small>
    </nav>

    <main className="doc-main">
      <header className="doc-hero">
        <span className="doc-kicker"><${Icon} n="zap" s="sm" /><span>LASSO × NOOK · 常驻系统工具集详细设计稿 (v3)</span></span>
        <h1>收编六个常驻小工具，共用一套纸面与墨色。</h1>
        <p>
          把 Raycast Notes、Shottr、EdgeMark、iRightMouse、Rectangle 与 launchd-ui 收敛进 <strong>Lasso（全局系统交互壳）</strong>与 <strong>Nook（个人数据与本机运维台）</strong>。
          左侧切换模块与状态，中间画布可直接点击交互，右侧给出尺寸、跨进程协议与代码改动点。
        </p>
        <div className="doc-meta">
          <span><${Icon} n="timer" s="sm" />刘海岛 + 四边呼吸光效</span>
          <span><${Icon} n="languages" s="sm" />New API 180ms 原位流式翻译</span>
          <span><${Icon} n="note" s="sm" />边缘抽屉便签 + 撕下贴图</span>
          <span><${Icon} n="folder" s="sm" />Finder 超级面板 (路线 B)</span>
          <span><${Icon} n="layout" s="sm" />快捷键分屏 + 双窗工作区</span>
          <span><${Icon} n="server" s="sm" />Nook Launchd 运维</span>
        </div>
      </header>

      <section className="doc-section" id="architecture">
        <header>
          <span className="doc-kicker">架构总览</span>
          <h2>系统交互壳归 Lasso，个人数据与运维归 Nook。</h2>
          <p className="doc-lead">
            两应用在各自最擅长的技术栈内演进，不重复建设任务存储或配置中心；本机通过 macOS 原生 <code>DistributedNotificationCenter</code> 零配置双向联动。
          </p>
        </header>

        <div className="doc-grid">
          <div className="doc-card">
            <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3>Lasso · 全局系统交互壳</h3>
              <span className="l-pill clay">mac-ai-prompt</span>
            </div>
            <ul className="doc-rules">
              <li><strong>职责</strong>：管所有「全屏浮层、鼠标/键盘钩子、原位气泡与高频快捷动作」。</li>
              <li><strong>批一新增</strong>：<code>2. 快速 API 原位翻译/润色卡片</code>、<code>4. 刘海岛 (NotchIsland) + 四边微光 (ReminderGlow)</code>。</li>
              <li><strong>批二新增</strong>：<code>3. 边缘抽屉便签 (EdgeNotes)</code>、<code>6. 窗口分屏与双窗排布 (WindowSnap)</code>、<code>5. Finder 超级动作面板</code>。</li>
            </ul>
          </div>

          <div className="doc-card">
            <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3>Nook · 个人数据与本机运维台</h3>
              <span className="l-pill olive">personal-data-hub/apps/macos</span>
            </div>
            <ul className="doc-rules">
              <li><strong>职责</strong>：管所有「带状态的个人数据、任务日程、定时规划与本机服务监控」。</li>
              <li><strong>批一新增</strong>：<code>1. 番茄钟会话 + 间歇摸鱼规则 + 刘海岛桥接</code>（扩展现有 <code>Reminders.swift</code>）、<code>7. LaunchAgents 守护进程管理模块</code>。</li>
              <li><strong>跨进程协议</strong>：<code>com.lasso.island.present</code> 推送强提醒上岛；<code>com.nook.bridge.action</code> 从刘海岛回写完成任务或重启服务。</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="doc-section" id="island">
        <header>
          <span className="doc-kicker">第一批 · 模块 1 & 4</span>
          <h2>刘海岛 + 番茄钟 / 摸鱼提醒 / Nook 任务联动</h2>
          <p className="doc-lead">
            平时与 MacBook 物理刘海融为一体；番茄专注或任务到点时向下生长为墨色卡片，配合四边 28pt 鼠标穿透呼吸光效，在任何全屏应用里都不会漏看。
          </p>
        </header>
        <${IslandSimulator} />
      </section>

      <section className="doc-section" id="fast-api">
        <header>
          <span className="doc-kicker">第一批 · 模块 2</span>
          <h2>快速直连 API 预设 & 原位流式翻译卡片</h2>
          <p className="doc-lead">
            复用 <code>media-service.ts</code> 已有的 New API 密钥与模型列表，在动作条或截图 OCR 旁原位展开轻量纸面卡片，首字延迟小于 200ms，按 <code>↵</code> 直接替换原输入框选中文本。
          </p>
        </header>
        <${FastApiSimulator} />
      </section>

      <section className="doc-section" id="launchd">
        <header>
          <span className="doc-kicker">第一批 · 模块 7</span>
          <h2>Nook 本机守护进程管理（收编 launchd-ui）</h2>
          <p className="doc-lead">
            直接并入 Nook 原生客户端，扫描 <code>~/Library/LaunchAgents/*.plist</code> 与实时退出码，一键 <code>kickstart -k</code> 重启、看错误日志尾部，关键服务异常退出时自动推上刘海岛报警。
          </p>
        </header>
        <${NookLaunchdSimulator} />
      </section>

      <section className="doc-section" id="notes">
        <header>
          <span className="doc-kicker">第二批 · 模块 3</span>
          <h2>边缘抽屉便签（吸收 Raycast Notes + EdgeMark）</h2>
          <p className="doc-lead">
            鼠标停靠屏幕边缘或按快捷键滑出抽屉：顶部永远保留零负担置顶速记板 <code>Scratchpad.md</code>，底层直接读写本地 Markdown 文件夹，并支持一键「撕下」变成桌面常驻贴图。
          </p>
        </header>
        <${EdgeNotesSimulator} />
      </section>

      <section className="doc-section" id="window-snap">
        <header>
          <span className="doc-kicker">第二批 · 模块 6</span>
          <h2>窗口快捷键分屏与双窗工作区（收编 Rectangle）</h2>
          <p className="doc-lead">
            复用 Lasso 原生 AX 权限，150 行 Objective-C++ 实现全部 <code>⌃⌥</code> 分屏快捷键与跨屏移动，并新增「一键排布编码/调研双窗工作区」。
          </p>
        </header>
        <${WindowSnapSimulator} />
      </section>

      <section className="doc-section" id="finder">
        <header>
          <span className="doc-kicker">第二批 · 模块 5</span>
          <h2>Finder 超级动作面板（收编 iRightMouse · 路线 B）</h2>
          <p className="doc-lead">
            在 Finder 内按鼠标中键或长按右键，秒读当前选中文件与目录，弹出墨色定制面板：一键用 Cursor/终端打开、原地新建模板文件、图片转 WebP/OCR、发给 Codex 或软链到活跃 Worktree。
          </p>
        </header>
        <${FinderSimulator} />
      </section>

      <section className="doc-section" id="mapping">
        <header>
          <span className="doc-kicker">工程落地与验收</span>
          <h2>分批改动映射表</h2>
        </header>
        <div className="doc-card" style=${{ padding: 0, overflow: 'hidden' }}>
          <table className="doc-table">
            <thead>
              <tr><th>批次</th><th>模块</th><th>核心改动与新增文件</th><th>所属仓库</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="l-pill clay">第一批</span></td>
                <td>快速 API 与原位翻译卡</td>
                <td>扩展 <code>contracts.ts</code> 预设模式；在 <code>media-service.ts</code> 增加流式 <code>/v1/chat/completions</code> 调用；<code>action-bar.ts</code> 与 <code>ActionBar.tsx</code> 增加原位结果卡片与替换原文动作</td>
                <td><code>mac-ai-prompt</code></td>
              </tr>
              <tr>
                <td><span className="l-pill clay">第一批</span></td>
                <td>刘海岛与四边光效</td>
                <td>新增 <code>src/main/island.ts</code> 与 <code>src/renderer/island/NotchIsland.tsx</code>；在 <code>native/capture-native.mm</code> 增加四边穿透呼吸窗 <code>ReminderGlow</code> 与 <code>DistributedNotificationCenter</code> 桥接</td>
                <td><code>mac-ai-prompt</code></td>
              </tr>
              <tr>
                <td><span className="l-pill clay">第一批</span></td>
                <td>Nook 提醒/番茄钟/摸鱼联动</td>
                <td>在 <code>ReminderSettings.swift</code> 与 <code>ReminderPlanner.swift</code> 增加 <code>interval</code> 间歇规则与番茄钟状态；<code>Reminders.swift</code> 增加向刘海岛广播与回调处理</td>
                <td><code>personal-data-hub</code></td>
              </tr>
              <tr>
                <td><span className="l-pill clay">第一批</span></td>
                <td>Nook Launchd 守护进程管理</td>
                <td>新增 <code>Sources/PersonalHub/Modules/LaunchdModule.swift</code>，封装 <code>~/Library/LaunchAgents</code> 解析、<code>launchctl</code> 状态查询、重启启停与日志尾部读取</td>
                <td><code>personal-data-hub</code></td>
              </tr>
              <tr>
                <td><span className="l-pill">第二批</span></td>
                <td>边缘抽屉便签 (EdgeNotes)</td>
                <td>新增 <code>src/main/edge-notes.ts</code>（屏幕边缘检测 + 本地 <code>.md</code> 读写监听）与 <code>src/renderer/notes/EdgeNotes.tsx</code>，打通动作条「入便签」与撕下转 <code>Pin</code></td>
                <td><code>mac-ai-prompt</code></td>
              </tr>
              <tr>
                <td><span className="l-pill">第二批</span></td>
                <td>窗口分屏与双窗工作区</td>
                <td>在 <code>native/capture-ax.mm</code> 增加焦点窗口与指定应用窗口的 AX 帧设置；在设置页增加分屏快捷键与工作区预设</td>
                <td><code>mac-ai-prompt</code></td>
              </tr>
              <tr>
                <td><span className="l-pill">第二批</span></td>
                <td>Finder 超级动作面板</td>
                <td>在 <code>native/file-services.mm</code> 增加 Finder 选中路径与当前目录读取；新增 <code>src/main/finder-panel.ts</code> 与墨色快捷面板组件</td>
                <td><code>mac-ai-prompt</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
