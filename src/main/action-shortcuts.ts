import { globalShortcut, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { canonicalShortcut, globalActionIds, globalActionLabels, isValidShortcut, type GlobalActionId } from '../shared/shortcuts';
import { captureModes, type CaptureMode } from '../shared/capture';
import type { Settings, ShellState } from '../shared/contracts';
import { ignoresApplication } from './selection';
import { nativeAx } from './native-ax';

export interface ActionShortcutDeps {
  state: () => Pick<ShellState, 'settings' | 'shortcutError'>;
  persistSettings: (next: Settings) => void;
  run: (action: GlobalActionId) => Promise<void>;
  notice: (message: string) => void;
  changed: () => void;
  assertLocal: (event: IpcMainInvokeEvent) => void;
}

export class ActionShortcuts {
  private registeredActions = new Map<GlobalActionId, string>();
  constructor(private deps: ActionShortcutDeps) {
    ipcMain.handle('shell:action-shortcut', (event, action: GlobalActionId, shortcut: string) => { deps.assertLocal(event); return this.save(action, shortcut); });
  }
  private register(action: GlobalActionId, shortcut: string): string | null {
    if (!shortcut) return null;
    try {
      return globalShortcut.register(shortcut, () => {
        void (async () => {
          if (ignoresApplication(this.deps.state().settings.ignoredApps, nativeAx().frontmostApp().bundleId, 'shortcuts')) return;
          await this.deps.run(action);
        })().catch(error => { this.deps.notice((error as Error).message); });
      }) ? null : `${shortcut} 已被占用，请换一组快捷键。`;
    } catch { return '快捷键格式无效。'; }
  }
  configure(settings: Settings): string[] {
    const state=this.deps.state();
    for(const shortcut of this.registeredActions.values())globalShortcut.unregister(shortcut);
    this.registeredActions.clear();state.shortcutError=null;
    const conflicts:string[]=[],keys=new Set<string>();
    for(const action of globalActionIds){
      const shortcut=settings.actionShortcuts[action]||'',key=canonicalShortcut(shortcut);
      const error=!isValidShortcut(shortcut)?'快捷键格式无效':key==='alt+space'?'Option+Space 已留给 Raycast':key&&keys.has(key)?'快捷键与其他动作重复':this.register(action,shortcut);
      if(key)keys.add(key);
      if(error){conflicts.push(`${globalActionLabels[action]}：${error}`);if(action==='open-launcher')state.shortcutError=error;}
      else if(shortcut)this.registeredActions.set(action,shortcut);
    }
    return conflicts;
  }
  save(action: GlobalActionId, shortcut: string) {
    const state = this.deps.state();
    if (!globalActionIds.includes(action)) return { error: '未知的全局动作' };
    if (!isValidShortcut(shortcut)) return { error: '支持 F1–F24 单键，其他按键请搭配修饰键；留空则取消绑定。' };
    const key = canonicalShortcut(shortcut);
    if (key === 'alt+space') return { error: 'Option+Space 已留给 Raycast，请选择其他快捷键。' };
    const conflict = globalActionIds.find(id => id !== action && key && canonicalShortcut(state.settings.actionShortcuts[id] || '') === key);
    if (conflict) return { error: `已用于「${globalActionLabels[conflict]}」。` };
    const current = this.registeredActions.get(action), changed = !current || canonicalShortcut(current) !== key;
    if (changed) { const error = this.register(action, shortcut); if (error) return { error }; }
    const next = { ...state.settings, actionShortcuts: { ...state.settings.actionShortcuts, [action]: shortcut },
      shortcut: action === 'open-launcher' ? shortcut : state.settings.shortcut,
      captureShortcuts: captureModes.includes(action as CaptureMode) ? { ...state.settings.captureShortcuts, [action]: shortcut } : state.settings.captureShortcuts };
    try { this.deps.persistSettings(next); }
    catch (error) { if (changed && shortcut) globalShortcut.unregister(shortcut); return { error: (error as Error).message }; }
    if (changed && current) globalShortcut.unregister(current);
    if (shortcut) this.registeredActions.set(action, shortcut); else this.registeredActions.delete(action);
    if (action === 'open-launcher') state.shortcutError = null;
    this.deps.changed(); return { error: null };
  }
}
