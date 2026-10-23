import type { WebContents } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutionCatalog, ExecutionProfile } from '../../shared/contracts';

type Kind = 'model' | 'effort';
type Command = 'inspect' | 'open' | 'choose' | 'dismiss' | 'focus-slider';
interface Option { id: string; label: string; selected: boolean }
interface Slider { min: number; max: number; value: number; label: string; disabled: boolean; announcedPosition: number | null }
type MenuAction = 'popup' | 'models' | 'effort' | 'gemini-effort';
interface Control { options: Option[]; trigger: string; opened: boolean; clicked: boolean; slider: Slider | null; shared: boolean; action: MenuAction | null }
type SliderChoice = Option & { index: number };
interface SliderCatalog { min: number; max: number; choices: SliderChoice[] }
// Shared across page instances; only native option labels/positions are retained.
const sliderCatalogs = new Map<string, SliderCatalog>();
const sameVisibleLabel = (left: string, right: string) => Boolean(left && right) && left.replace(/\s+/g, '') === right.replace(/\s+/g, '');
// Site-native controls only: no cookies, private APIs or hardcoded model catalog.
function profileBridge(target: 'chatgpt' | 'gemini', kind: Kind, command: Command, wanted: string): Control {
  const visible = (el: Element) => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]');
  const norm = (s: string | null) => (s || '').replace(/\s+/g, ' ').trim();
  const label = (el: Element) => norm(el.getAttribute('aria-label') || el.textContent);
  const buttons = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(visible);
  const shared = target === 'chatgpt' ? [...document.querySelectorAll<HTMLElement>('[data-codex-intelligence-trigger]')].find(visible) : null;
  const modelTrigger = shared || [...document.querySelectorAll<HTMLElement>('[data-testid="model-switcher-dropdown-button"], [data-test-id="bard-mode-menu-button"], [data-test-id="model-selector"]')].find(visible)
    || buttons.find(el => target === 'chatgpt' ? /^(选择 ChatGPT 模型|Select ChatGPT model|Choose ChatGPT model)$/i.test(label(el)) : /^(打开模式选择器|Open mode picker|Show model picker)/i.test(label(el)));
  const legacy = buttons.filter(el => kind === 'model'
    ? /^(ChatGPT|Gemini)(\s|$)|^(模型|选择模型|切换模型|Choose model|Select model|Model picker)/i.test(label(el))
    : /^(思考时间|思考强度|Thinking time|Reasoning effort|Standard|Extended|标准|延长)$/i.test(label(el)));
  const trigger = kind === 'model' || shared || target === 'gemini' ? modelTrigger || (legacy.length === 1 ? legacy[0] : null)
    : [...document.querySelectorAll<HTMLElement>('[data-testid="reasoning-effort-button"], [data-testid="thinking-time-button"]')].find(visible) || (legacy.length === 1 ? legacy[0] : null);
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"], .mat-mdc-menu-panel')].filter(el => visible(el) && el.getAttribute('data-state') !== 'closed');
  const controlled = trigger?.getAttribute('aria-controls');
  const root = !trigger ? null : target === 'gemini' && document.querySelector('[data-test-id="gem-mode-menu"]')
    ? menus.find(el => el.matches('[data-test-id="gem-mode-menu"]')) || null
    : menus.find(el => el.id === controlled || (trigger.id && el.getAttribute('aria-labelledby') === trigger.id))
      || (trigger.getAttribute('aria-expanded') === 'true' && menus.length === 1 ? menus[0] : null);
  const gemEffort = root?.querySelector<HTMLElement>('gem-menu-item[value="thinking_level"]');
  const sliderControl = root ? [...root.querySelectorAll<HTMLElement>('[data-reasoning-slider]')].find(visible) : null;
  const thumb = sliderControl?.querySelector('[role="slider"]');
  const announcement = sliderControl?.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)).find(el => el?.getAttribute('role') === 'status');
  const sliderLabel = norm(announcement?.textContent || '').replace(/[，,]\s*(?:第\s*\d+\s*项|\d+\s+of\s+\d+).*$/i, '') || norm(root?.querySelector('[data-effort-only]')?.textContent || '');
  const ordinal = norm(announcement?.textContent || '').match(/第\s*(\d+)\s*项|(?:,|，)\s*(\d+)\s+of\s+\d+/i);
  const slider: Slider | null = kind === 'effort' && thumb ? { min: Number(thumb.getAttribute('aria-valuemin')), max: Number(thumb.getAttribute('aria-valuemax')), value: Number(thumb.getAttribute('aria-valuenow')), label: sliderLabel, disabled: sliderControl?.getAttribute('aria-disabled') === 'true', announcedPosition: ordinal ? Number(ordinal[1] || ordinal[2]) : null } : null;
  let items: HTMLElement[] = [];
  if (root) {
    if (target === 'gemini' && root.matches('[data-test-id="gem-mode-menu"]')) {
      items = [...(kind === 'model' ? root.querySelectorAll<HTMLElement>('gem-menu-item[data-mode-id]') : gemEffort?.querySelectorAll<HTMLElement>('.expand-content gem-menu-item') || [])];
    } else if (shared && kind === 'effort') items = [];
    else items = [...root.querySelectorAll<HTMLElement>(shared && kind === 'model' ? '[role="menuitemradio"]' : '[role="menuitemradio"], [role="option"], [role="menuitem"], [data-test-id*="mode-option"], [data-testid^="model-switcher-"]')];
  }
  const entries: { element: HTMLElement; option: Option }[] = [];
  if (!slider) for (const el of items.filter(el => visible(el) && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled') && el.getAttribute('aria-haspopup') !== 'menu' && !el.closest('a[href]'))) {
    const name = target === 'gemini' ? norm(el.querySelector('.label')?.textContent || label(el)) : label(el);
    if (!name || /升级|Upgrade|订阅|Subscribe|设置|Settings|了解更多|Learn more|更多模型|More models|管理|Manage/i.test(name) || entries.some(entry => entry.element.contains(el))) continue;
    entries.push({ element: el, option: { id: name, label: name, selected: el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('data-state') === 'checked' || el.classList.contains('selected') || Boolean(el.querySelector('[data-state="checked"], [data-test-id="selected-mode-icon"], .selected-indicator')) } });
  }
  const toggle = root ? [...root.querySelectorAll<HTMLElement>('[data-model-picker-view-toggle]')].find(visible) : null;
  const selected = root ? [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')].find(visible) : null;
  const action: MenuAction | null = !root && trigger && trigger.getAttribute('aria-expanded') !== 'true' ? 'popup'
    : root && kind === 'model' && shared && !entries.length && toggle ? 'models'
    : root && kind === 'effort' && shared && !slider && selected ? 'effort'
    : root && kind === 'effort' && gemEffort && gemEffort.getAttribute('aria-expanded') !== 'true' ? 'gemini-effort' : null;
  const result: Control = { options: entries.map(e => e.option), trigger: trigger ? norm(trigger.innerText) || label(trigger) : '', opened: Boolean(root), clicked: false, slider, shared: Boolean(shared), action };
  if (command === 'open' && action && (!wanted || wanted === action)) {
    const element = action === 'popup' ? trigger : action === 'models' ? toggle : action === 'effort' ? selected : gemEffort;
    element?.click(); result.clicked = Boolean(element);
  } else if (command === 'choose') {
    const matches = entries.filter(e => e.option.id === wanted);
    if (matches.length === 1) { matches[0].element.click(); result.clicked = true; }
  } else if (command === 'focus-slider' && slider && !slider.disabled && thumb instanceof HTMLElement) {
    // Arrow keys must reach the focusable thumb, not the surrounding menu.
    thumb.focus({ preventScroll: true }); result.clicked = document.activeElement === thumb;
  } else if (command === 'dismiss' && root && trigger) {
    if (target === 'gemini') trigger.click();
    else root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }
  return result;
}
export class WebProfile {
  constructor(private contents: WebContents, private target: 'chatgpt' | 'gemini') {}
  private key(model: string) { return JSON.stringify([this.target, model]); }
  static hasEffortPosition(target: 'chatgpt' | 'gemini', profile: ExecutionProfile) {
    // A default-model preset must first resolve the site's current model.
    return Boolean(profile.model && sliderCatalogs.get(JSON.stringify([target, profile.model]))?.choices.some(option => option.id === profile.effort));
  }
  private rememberPosition(model: string, slider: Slider) {
    const key = this.key(model); const previous = sliderCatalogs.get(key);
    const sameRange = previous?.min === slider.min && previous.max === slider.max;
    const previousPoint = previous?.choices.find(option => option.index === slider.value);
    const choices = sameRange && (!previousPoint || previousPoint.id === slider.label) ? previous!.choices.filter(option => option.index !== slider.value) : [];
    if (slider.label) choices.push({ id: slider.label, label: slider.label, index: slider.value, selected: true });
    const catalog = { min: slider.min, max: slider.max, choices };
    sliderCatalogs.set(key, catalog); return catalog;
  }
  private knownChoices(model: string, slider: Slider) {
    const cached = sliderCatalogs.get(this.key(model));
    return cached?.min === slider.min && cached.max === slider.max
      && cached.choices.some(option => option.index === slider.value && option.id === slider.label) ? cached.choices : [];
  }
  private modelFromText(text: string) {
    const models = new Set<string>();
    for (const [key, catalog] of sliderCatalogs) {
      const [target, model] = JSON.parse(key) as [string, string];
      if (target === this.target && model && catalog.choices.some(option => sameVisibleLabel(option.id, text))) models.add(model);
    }
    return models.size === 1 ? [...models][0] : null;
  }
  private modelMatches(model: string, text: string) { return sameVisibleLabel(text, model) || this.modelFromText(text) === model; }
  private summaryMatches(profile: ExecutionProfile, control: Control) {
    return control.shared && !control.opened
      && (!profile.model || this.modelMatches(profile.model, control.trigger))
      && (!profile.effort || sameVisibleLabel(control.trigger, profile.effort));
  }
  private read(kind: Kind, command: Command = 'inspect', wanted = ''): Promise<Control> {
    return this.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${profileBridge.toString()})(${JSON.stringify(this.target)},${JSON.stringify(kind)},${JSON.stringify(command)},${JSON.stringify(wanted)})` }], command !== 'inspect');
  }
  private async options(kind: Kind, signal: AbortSignal) {
    const attempted = new Set<MenuAction>();
    for (let i = 0; ; i++) {
      signal.throwIfAborted();
      const result = await this.read(kind);
      if (result.options.length || result.slider || i >= (kind === 'model' ? 80 : 24)) return result;
      if (result.action && !attempted.has(result.action)) {
        const changed = await this.read(kind, 'open', result.action);
        if (changed.clicked && changed.action) attempted.add(changed.action);
      }
      await delay(100, undefined, { signal });
    }
  }
  private async dismiss(kind: Kind) {
    await this.read(kind, 'dismiss');
    // React/Angular may commit the close after click() has returned. Opening the
    // next panel in that gap can cancel the close or operate on a departing view.
    for (let i = 0; i < 20; i++) {
      if (!(await this.read(kind)).opened) return;
      await delay(25);
    }
    throw new Error('网页模型菜单尚未收起，请稍后重试；尚未发送。');
  }
  private async moveSlider(value: number, signal: AbortSignal) {
    for (let i = 0; i < 40; i++) {
      signal.throwIfAborted();
      // The native picker may close or remount after a change. Reacquire it
      // instead of treating a missing frame during that transition as a new UI.
      const current = await this.options('effort', signal);
      if (!current.slider) throw new Error('未找到网页思考强度滑杆；尚未发送。');
      if (value < current.slider.min || value > current.slider.max) throw new Error('网页当前没有这个思考档位；尚未发送。');
      if (current.slider.value === value) {
        if (current.slider.label && (current.slider.announcedPosition === null || current.slider.announcedPosition === value - current.slider.min + 1)) return current.slider;
        await delay(50, undefined, { signal }); continue;
      }
      const focused = await this.read('effort', 'focus-slider');
      if (!focused.clicked || !focused.slider) throw new Error('网页思考强度控件未能获得焦点；尚未发送。');
      signal.throwIfAborted();
      const keyCode = value < focused.slider.value ? 'Left' : 'Right';
      this.contents.sendInputEvent({ type: 'keyDown', keyCode });
      this.contents.sendInputEvent({ type: 'keyUp', keyCode });
      await delay(100, undefined, { signal });
    }
    throw new Error('网页思考强度滑杆暂未响应；尚未发送。');
  }
  private async sliderOptions(model: string, slider: Slider, signal: AbortSignal, refresh = false) {
    if (!Number.isInteger(slider.min) || !Number.isInteger(slider.max) || slider.max - slider.min > 16) throw new Error('网页滑杆范围无法确认。');
    const cached = this.knownChoices(model, slider);
    if (!refresh && cached.length === slider.max - slider.min + 1) return cached.map(option => ({ ...option, selected: option.index === slider.value }));
    const choices: SliderChoice[] = [];
    try {
      for (let index = slider.min; index <= slider.max; index++) {
        const actual = await this.moveSlider(index, signal);
        choices.push({ id: actual.label, label: actual.label, selected: index === slider.value, index });
      }
    } finally { await this.moveSlider(slider.value, AbortSignal.timeout(5000)); }
    sliderCatalogs.set(this.key(model), { min: slider.min, max: slider.max, choices });
    return choices;
  }
  private async select(kind: Kind, value: string, signal: AbortSignal, model = '') {
    const before = await this.options(kind, signal);
    if (before.slider) {
      this.rememberPosition(model, before.slider);
      if (before.slider.label === value) return;
      const option = this.knownChoices(model, before.slider).find(o => o.id === value);
      if (!option) throw new Error(`思考档位「${value}」的位置尚未确认，请刷新预设选项；尚未发送。`);
      const actual = await this.moveSlider(option.index, signal);
      if (actual.label !== value) throw new Error('未能确认网页思考强度切换成功；尚未发送。');
      return;
    }
    const option = before.options.find(o => o.id === value);
    if (!option) throw new Error(`网页当前没有预设指定的${kind === 'model' ? '模型' : '思考强度'}「${value}」。请刷新选项；尚未发送。`);
    if (!option.selected) {
      if (!(await this.read(kind, 'choose', value)).clicked) throw new Error('网页选项未能唯一定位；尚未发送。');
      if (kind === 'model') {
        for (let i = 0; i < 16; i++) {
          signal.throwIfAborted();
          const panel = await this.read('model');
          if (panel.options.some(option => option.id === value && option.selected)) return;
          const strength = await this.read('effort');
          if (this.modelMatches(value, strength.slider?.label || strength.trigger) && (strength.slider || !strength.opened)) return;
          if (strength.slider || !strength.shared) break;
          await delay(50, undefined, { signal });
        }
      } else await delay(200, undefined, { signal });
      const actual = await this.options(kind, signal);
      if (!actual.options.find(o => o.id === value)?.selected && actual.trigger !== value && !actual.trigger.endsWith(' ' + value)) throw new Error('未能确认网页选项切换成功；尚未发送。');
    }
  }
  async choose(kind: Kind, value: string, signal: AbortSignal, model = '') {
    try { await this.select(kind, value, signal, model); }
    finally { await this.dismiss(kind); }
  }
  async apply(profile: ExecutionProfile, signal: AbortSignal) {
    if (!profile.model && !profile.effort) return;
    const initial = await this.read('model');
    if (this.summaryMatches(profile, initial)) return;
    if (!initial.shared) {
      if (profile.model) await this.choose('model', profile.model, signal);
      if (profile.effort) await this.choose('effort', profile.effort, signal, profile.model || '');
      return;
    }
    try {
      if (profile.model && !this.modelMatches(profile.model, initial.trigger)) await this.select('model', profile.model, signal);
      if (profile.effort) await this.select('effort', profile.effort, signal, profile.model || '');
    } finally { await this.dismiss(profile.effort ? 'effort' : 'model'); }
  }
  async verify(profile: ExecutionProfile, signal: AbortSignal) {
    if (!profile.model && !profile.effort) return;
    const initial = await this.read('model');
    if (this.summaryMatches(profile, initial)) return;
    const check = (kind: Kind, actual: Control) => {
      const wanted = profile[kind]!;
      if (actual.slider ? actual.slider.label !== wanted : !actual.options.some(o => o.id === wanted && (o.selected || actual.trigger === wanted || actual.trigger.endsWith(' ' + wanted)))) throw new Error(`发送前未能确认预设${kind === 'model' ? '模型' : '思考强度'}「${wanted}」，内容已保留。`);
    };
    if (initial.shared) {
      try {
        if (profile.model) check('model', await this.options('model', signal));
        if (profile.effort) check('effort', await this.options('effort', signal));
      } finally { await this.dismiss(profile.effort ? 'effort' : 'model'); }
    } else for (const kind of ['model', 'effort'] as const) {
      if (!profile[kind]) continue;
      try { check(kind, await this.options(kind, signal)); } finally { await this.dismiss(kind); }
    }
  }
  async catalog(model: string, signal: AbortSignal, refresh = false): Promise<ExecutionCatalog> {
    const models = await this.options('model', signal);
    await this.dismiss('model');
    if (!models.options.length) throw new Error('未读取到网页模型菜单。请在目标网页完成登录或处理遮挡菜单的提示，再刷新选项。');
    const currentModel = models.options.find(o => o.selected)?.id || models.options.find(o => models.trigger === o.id || models.trigger.endsWith(' ' + o.id))?.id || '';
    const before = await this.options('effort', signal);
    const originalEffort = before.slider?.label || before.options.find(o => o.selected)?.id || '';
    if (before.slider) this.rememberPosition(currentModel, before.slider);
    await this.dismiss('effort');
    const changing = Boolean(model && model !== currentModel);
    if (changing && !currentModel) throw new Error('暂时无法确认网页当前模型，未切换选项。');
    try {
      if (changing) await this.choose('model', model, signal);
      const actual = await this.options('effort', signal);
      const selectedModel = model || currentModel;
      const efforts = actual.slider ? await this.sliderOptions(selectedModel, actual.slider, signal, refresh) : actual.options;
      if (!model && actual.slider) sliderCatalogs.set(this.key(''), sliderCatalogs.get(this.key(selectedModel))!);
      return { models: models.options.map(o => ({ id: o.id, label: o.label })), efforts: efforts.map(o => o.id), currentModel: model || currentModel, currentEffort: efforts.find(o => o.selected)?.id || '' };
    } finally {
      await this.dismiss('effort');
      if (changing) {
        const cleanupSignal = AbortSignal.timeout(8000);
        await this.choose('model', currentModel, cleanupSignal);
        if (originalEffort) await this.choose('effort', originalEffort, cleanupSignal, currentModel);
      }
    }
  }
}
