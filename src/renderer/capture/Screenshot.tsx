import { useEffect, useState } from 'react';
import type { ScreenshotAPI, ScreenshotState } from '../../shared/capture';
import { ScrollControls, ScrollReview } from './ScrollCapture';
import { clearCapturePixels } from './pixels';
import './capture.css';
type EditorView=typeof import('./Editor')['Editor'];
declare global { interface Window { screenshot: ScreenshotAPI } }
/** Selection lives in AppKit. This renderer only receives confirmed results and scroll controls. */
export function Screenshot(){
  const [state,setState]=useState<ScreenshotState|null>(null);
  const [Editor,setEditor]=useState<EditorView|null>(null),[loadError,setLoadError]=useState(false);
  useEffect(()=>{
    let current=true,received=false;
    const update=(next:ScreenshotState|null)=>{if(!next)clearCapturePixels();setState(next);};
    const off=window.screenshot.onState(next=>{received=true;update(next);});
    void window.screenshot.state().then(initial=>{if(current&&!received)update(initial);});
    return()=>{current=false;off();clearCapturePixels();};
  },[]);
  // Resolve the component while hidden so the first result need not suspend for a lazy import.
  useEffect(()=>{
    if(Editor)return;let current=true;setLoadError(false);
    void import('./Editor').then(module=>{if(current)setEditor(()=>module.Editor);}).catch(()=>{if(current)setLoadError(true);});
    return()=>{current=false;};
  },[Editor,state?.editId]);
  useEffect(()=>{if(loadError&&state)window.screenshot.loadError(state.editId);},[loadError,state?.editId]);
  if(!state)return null;
  if(state.phase==='scrolling')return <ScrollControls state={state}/>;
  if(state.phase==='review')return <ScrollReview state={state}/>;
  if(state.phase==='result'&&state.selection&&Editor)return <Editor key={state.editId} state={state}/>;
  return null;
}
