import { BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { RecordingAction, RecordingFormat, RecordingSessionState } from '../shared/recording';
import type { RecordingManager } from './capture/recording';
import type { CaptureManager } from './capture';
import { fromMainFrame, sealLocal } from './ipc';
import { fitToWorkArea } from './position';

export interface RecordingPanelDeps {
  quitting: () => boolean;
  recording: () => RecordingManager | undefined;
  screenshots: () => CaptureManager;
  notice: (message: string) => void;
  assertLocal: (event: IpcMainInvokeEvent) => void;
}

export class RecordingPanel {
  private panel: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  constructor(private deps: RecordingPanelDeps) {
    const { assertLocal } = deps;
    const assertRecording=(event:IpcMainInvokeEvent)=>{if(!this.owns(event))assertLocal(event);};
    ipcMain.handle('shell:recording-panel',async (event,open:boolean)=>{if(!this.owns(event))assertLocal(event);if(typeof open!=='boolean')throw Error('录制窗口操作无效');if(open)await this.show();else await this.close();});
    ipcMain.handle('shell:recording-state',async event=>{assertRecording(event);await deps.recording()?.initialized();return deps.recording()?.state()??null;});
    ipcMain.handle('shell:recording-action',(event,action:RecordingAction)=>{assertRecording(event);return this.act(action);});
  }
  get window() { return this.panel; }
  owns(event: IpcMainInvokeEvent) { return fromMainFrame(event, this.panel); }
  private layout(session: RecordingSessionState | null) {
    if (!this.panel || this.panel.isDestroyed()) return;
    const live = session && ['countdown', 'recording', 'paused'].includes(session.status);
    const [width, height] = live ? [720, 200] : session?.status === 'review' ? [680, 680] : [520, 350];
    const old = this.panel.getBounds(), area = screen.getDisplayMatching(old).workArea;
    if(old.width!==width||old.height!==height)this.panel.setBounds(fitToWorkArea({ ...old, width, height }, area));
  }
  async show() {
    if (this.deps.quitting()) return;
    if (!this.panel || this.panel.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const panel = new BrowserWindow({ ...fitToWorkArea({ x: area.x + area.width - 540, y: area.y + 28, width: 520, height: 350 }, area), frame: false, show: false, resizable: false, fullscreenable: false, alwaysOnTop: true, backgroundColor: '#FAF9F5', title: 'Lasso 屏幕录制', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
      this.panel = panel;
      sealLocal(panel.webContents);
      panel.on('close', event => { if (!this.deps.quitting()) { event.preventDefault(); panel.webContents.send('shell:recording-close-request'); } });
      panel.on('closed', () => { if (this.panel === panel) { this.panel = null; this.ready = null; } });
      panel.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.meta && input.key.toLowerCase() === 'w') { event.preventDefault(); panel.webContents.send('shell:recording-close-request'); } });
      this.ready = panel.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'recording' } }).catch(error => { panel.destroy(); throw error; });
    }
    await this.ready;
    if (!this.panel || this.panel.isDestroyed() || this.deps.quitting()) return;
    this.layout(this.deps.recording()?.state() ?? null); this.panel.showInactive();
  }
  async close() {
    const panel = this.panel;
    const result = await this.act({ type: 'cancel' });
    if (!result.error && panel && !panel.isDestroyed()) panel.destroy();
  }
  async act(action:RecordingAction){
    const recording=this.deps.recording();
    if(!recording)return {state:null,error:'录制尚未就绪'};
    if(action?.type==='cancel')this.deps.screenshots().cancelRecordingSelection();
    if(action?.type==='start')this.panel?.hide();
    const result=await recording.action(action);
    if(result.error)this.deps.notice(result.error);
    if(action?.type==='start' && !this.deps.quitting())await this.show();
    return result;
  }
  changed(session: RecordingSessionState | null) {
    if(this.panel&&!this.panel.isDestroyed()){this.panel.webContents.send('shell:recording-changed',session);this.layout(session);}
    if(session&&!this.deps.quitting()&&!this.panel?.isVisible())void this.show();
  }
  trayItems():Electron.MenuItemConstructorOptions[]{
    const recording=this.deps.recording(),screenshots=this.deps.screenshots();
    const session=recording?.state(),run=(action:RecordingAction)=>()=>{void this.act(action);};
    if(!session)return [{label:'打开录制面板…',click:()=>{void this.show();}},...(['rect','window','screen'] as const).map(mode=>({label:{rect:'区域录制…',window:'窗口录制…',screen:'全屏录制'}[mode],enabled:!!recording&&!screenshots?.active,click:run({type:'start',mode})}))];
    if(session.status==='recoverable')return [{label:'恢复未完成录制',click:run({type:'recover'})},{label:'删除未完成录制',click:run({type:'discard-recovery'})}];
    if(session.status==='review')return [
      ...(['mp4','gif','webp'] as RecordingFormat[]).map(format=>({label:format.toUpperCase(),submenu:(['save','quick-save','copy-file'] as const).map(action=>({label:{save:'保存…','quick-save':'快速保存','copy-file':'复制文件'}[action],click:run({type:'export',format,action})}))})),
      {label:'动态贴图',click:run({type:'export',format:'gif',action:'pin'})},
      {label:'结束本次录制',click:run({type:'cancel'})}
    ];
    return [
      ...(session.status==='recording'?[{label:'暂停录制',click:run({type:'pause'})}]:session.status==='paused'?[{label:'继续录制',click:run({type:'resume'})}]:[]),
      {label:'停止录制',enabled:session.frameCount>0,click:run({type:'stop'})},
      {label:'取消录制',click:run({type:'cancel'})}
    ];
  }
}
