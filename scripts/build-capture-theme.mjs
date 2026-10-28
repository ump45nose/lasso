import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScanLine, AppWindow, ScanText, Monitor } from 'lucide-react';
const css=readFileSync('src/renderer/styles/tokens.css','utf8');
const theme=Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(([,key,value])=>[key,value]));
const families=role=>css.match(new RegExp('--font-'+role+':([^;]+)'))[1].replace(/var\([^)]*\)/g,'').split(',').map(x=>x.trim().replace(/^['"]|['"]$/g,'')).filter(Boolean);
theme.uiFonts=[...families('ui'),'Songti SC'];theme.monoFonts=[...families('mono'),'Menlo'];
mkdirSync('dist/native/icons',{recursive:true});theme.icons={};
for(const [name,Icon] of Object.entries({area:ScanLine,rect:ScanLine,window:AppWindow,scroll:ScanText,screen:Monitor})){
 const file='dist/native/icons/'+name+'.svg';writeFileSync(file,renderToStaticMarkup(createElement(Icon,{size:16,strokeWidth:1.6})));theme.icons[name]='icons/'+name+'.svg';
}
writeFileSync('dist/native/capture-theme.json',JSON.stringify(theme));
