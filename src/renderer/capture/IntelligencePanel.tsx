import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, Download, ExternalLink, Pin, RotateCw, X } from 'lucide-react';
import type { BarcodeItem, CaptureFrame, OCRLine } from '../../shared/capture';
import { webURL, type IntelligenceKind, type IntelligenceResult, type TranslationBlock } from '../../shared/intelligence';
import { Segmented, rise } from '../motion';
import { Switch } from '../Switch';

export type IntelligenceView = IntelligenceKind | 'barcode';
const languages = [['简体中文', '中文'], ['English', '英文'], ['日本語', '日文'], ['한국어', '韩文']] as const;
const labels = { translate: '翻译', table: '表格', formula: '公式', barcode: '条码' };
interface Props {
  id: string; revision: number; kind: IntelligenceView; barcodes: BarcodeItem[]; lines: OCRLine[];
  frame(): Promise<CaptureFrame>; change(kind: IntelligenceView): void; close(): void;
  overlay(blocks: TranslationBlock[]): void;
}

export function IntelligencePanel({ id, revision, kind, barcodes, lines, frame, change, close, overlay }: Props) {
  const [language, setLanguage] = useState(''), [result, setResult] = useState<IntelligenceResult | null>(null);
  const [loading, setLoading] = useState(false), [working, setWorking] = useState(false), [retry, setRetry] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [cover, setCover] = useState(false);
  const [rows, setRows] = useState<string[][]>([]), [cell, setCell] = useState([0, 0]);
  const [latex, setLatex] = useState(''), [svg, setSvg] = useState(''), [previewError, setPreviewError] = useState('');
  useEffect(() => {
    let canceled = false;
    void window.screenshot.visionLanguage().then(value => { if (!canceled) setLanguage(value); }).catch(e => { if (!canceled) setError(e.message); });
    return () => { canceled = true; };
  }, []);
  useEffect(() => {
    overlay([]); setCover(false); setResult(null); setError(''); setNotice(''); setRows([]); setLatex('');
    if (kind === 'barcode' || !language) { setLoading(false); return; }
    let canceled = false; setLoading(true);
    void (async () => {
      const image = await frame();
      if (canceled) return;
      const response = await window.screenshot.analyze({ ...image, png: image.png!, kind, targetLanguage: language, lines });
      if (canceled) return;
      if (response.error || !response.result) throw Error(response.error || '未返回识别结果');
      setResult(response.result);
      if (response.result.table) {
        const width = response.result.table.reduce((columns, row) => Math.max(columns, row.length), 1);
        setRows(response.result.table.map(row => Array.from({ length: width }, (_, x) => row[x] ?? ''))); setCell([0, 0]);
      }
      setLatex(response.result.latex ?? '');
    })().catch(e => { if (!canceled) setError(e.message); }).finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [kind, language, retry]);
  useEffect(() => {
    setSvg(''); setPreviewError('');
    if (!latex.trim() || result?.kind !== 'formula') return;
    if (latex === result.latex && result.formulaSvg) { setSvg(result.formulaSvg); return; }
    let canceled = false;
    const timer = setTimeout(() => {
      void window.screenshot.previewFormula({ id, revision, latex }).then(value => {
        if (!canceled) { setSvg(value.svg ?? ''); setPreviewError(value.error ?? ''); }
      }).catch(e => { if (!canceled) setPreviewError(e.message); });
    }, 220);
    return () => { canceled = true; clearTimeout(timer); };
  }, [latex, result, id, revision]);
  async function act(operation: () => Promise<string>) {
    if (working) return; setWorking(true); setError(''); setNotice('');
    try { setNotice(await operation()); } catch (e) { setError((e as Error).message); } finally { setWorking(false); }
  }
  const copy = (text: string, message: string) => act(async () => { await window.screenshot.copyText({ id, revision, text }); return message; });
  const tableText = (format: 'markdown' | 'tsv') => {
    if (format === 'tsv') return rows.map(row => row.map(value => /[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join('\t')).join('\n');
    const line = (row: string[]) => '| ' + row.map(value => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r\n|[\r\n]/g, '<br>')).join(' | ') + ' |';
    return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
  };
  const translation = useMemo(() => (result?.blocks ?? []).map(block => {
    if (block.box) return block;
    const line = lines.find(line => line.text === block.original);
    return line ? { ...block, box: { x: line.x, y: line.y, width: line.width, height: line.height } } : block;
  }), [result, lines]);
  useEffect(() => overlay(cover ? translation.filter(block => block.box) : []), [cover, translation, overlay]);
  const width = rows[0]?.length ?? 0;
  const targets: readonly (readonly [string, string])[] = languages.some(([value]) => value === language) || !language ? languages : [...languages, [language, language]];
  const options: [IntelligenceView, string][] = [...(barcodes.length ? [['barcode', '条码'] as [IntelligenceView, string]] : []), ['translate', '翻译'], ['table', '表格'], ['formula', '公式']];
  return <motion.aside className="ed-intelligence" aria-label="智能处理" aria-busy={loading || working} onDoubleClick={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } e.stopPropagation(); }} {...rise}>
    <header><strong>智能处理</strong><button className="ed-tool" aria-label="关闭智能处理" onClick={close}><X /></button></header>
    <Segmented label="智能处理类型" value={kind} options={options} onChange={change} />
    {kind === 'translate' && <Segmented label="翻译目标语言" value={language} options={targets} onChange={setLanguage} />}
    {loading && <p className="ed-intel-status" role="status">正在{labels[kind]}识别…</p>}
    {kind === 'barcode' && <div className="ed-barcode-list" aria-label="条码结果">{barcodes.map((item, index) => <article key={index}>
      <span className="mono">{item.symbology}</span><p>{item.payload}</p><div className="ed-intel-actions">
        <button className="l-btn" disabled={working} onClick={() => void copy(item.payload, '已复制条码内容')}><Copy />复制内容</button>
        {webURL(item.payload) && <button className="l-btn" disabled={working} onClick={() => void act(async () => { const value = await window.screenshot.openURL({ id, revision, url: item.payload }); if (value.error) throw Error(value.error); return '已打开链接'; })}><ExternalLink />打开链接</button>}
      </div></article>)}</div>}
    {result?.kind === 'translate' && <>
      <div className="ed-translation-list">{translation.map((block, index) => <article key={index}><div><small>原文</small><p>{block.original}</p></div><div><small>译文</small><p>{block.translated}</p></div></article>)}</div>
      <label className="ed-intel-toggle"><span>图上译文覆盖 · 仅预览</span><Switch label="图上译文覆盖" value={cover} disabled={!translation.some(block => block.box)} change={() => setCover(!cover)} /></label>
      {!translation.some(block => block.box) && <p className="ed-intel-status">未匹配到文字位置，可查看对照或复制译文。</p>}
      <button className="l-btn" disabled={working || !result.translatedText?.trim()} onClick={() => void copy(result.translatedText!, '已复制全部译文')}><Copy />复制全部译文</button>
    </>}
    {result?.kind === 'table' && rows.length > 0 && <>
      <div className="ed-intel-grid"><table aria-label="识别表格"><tbody>{rows.map((row, y) => <tr key={y}>{row.map((value, x) => <td key={x} className={cell[0] === y && cell[1] === x ? 'selected' : ''}><input aria-label={`第 ${y + 1} 行第 ${x + 1} 列`} value={value} onFocus={() => setCell([y, x])} onChange={e => setRows(current => current.map((row, rowIndex) => rowIndex === y ? row.map((text, column) => column === x ? e.target.value : text) : row))} /></td>)}</tr>)}</tbody></table></div>
      <div className="ed-intel-actions" aria-label="表格行列操作">
        <button className="l-btn" onClick={() => setRows(current => [...current, Array(width).fill('')])}>添加行</button>
        <button className="l-btn" disabled={rows.length < 2} onClick={() => { setRows(current => current.filter((_, y) => y !== cell[0])); setCell([Math.max(0, cell[0] - 1), cell[1]]); }}>删除所选行</button>
        <button className="l-btn" onClick={() => setRows(current => current.map(row => [...row, '']))}>添加列</button>
        <button className="l-btn" disabled={width < 2} onClick={() => { setRows(current => current.map(row => row.filter((_, x) => x !== cell[1]))); setCell([cell[0], Math.max(0, cell[1] - 1)]); }}>删除所选列</button>
      </div>
      <div className="ed-intel-actions">
        <button className="l-btn" disabled={working} onClick={() => void copy(tableText('markdown'), '已复制 Markdown')}><Copy />复制 Markdown</button>
        <button className="l-btn" disabled={working} onClick={() => void copy(tableText('tsv'), '已复制 TSV')}>复制 TSV</button>
        <button className="l-btn" disabled={working} onClick={() => void act(async () => { const value = await window.screenshot.exportTable(rows); if (value.error) throw Error(value.error); return value.path ? `已导出 ${value.path}` : '已取消导出'; })}><Download />导出 XLSX</button>
      </div>
    </>}
    {result?.kind === 'formula' && <>
      <label className="ed-intel-source">LaTeX 源码<textarea aria-label="LaTeX 源码" spellCheck={false} value={latex} onChange={e => setLatex(e.target.value)} /></label>
      <div className="ed-formula-preview" aria-label="公式排版预览">{svg ? <img alt="公式排版" src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)} /> : <span role="status">{previewError || (latex.trim() ? '正在排版…' : '请输入 LaTeX')}</span>}</div>
      <div className="ed-intel-actions">
        <button className="l-btn" disabled={working || !latex.trim()} onClick={() => void copy(latex, '已复制 LaTeX')}><Copy />复制 LaTeX</button>
        <button className="l-btn primary" disabled={working || !svg || Boolean(previewError)} onClick={() => void act(async () => { const value = await window.screenshot.pinFormula(latex); if (value.error) throw Error(value.error); return '已创建公式贴图'; })}><Pin />转为公式贴图</button>
      </div>
    </>}
    {error && <p className="ed-intel-error" role="alert">{error}</p>}
    {notice && <p className="ed-intel-status" role="status">{notice}</p>}
    {kind !== 'barcode' && <button className="l-ghost" disabled={loading || working || !language} onClick={() => setRetry(value => value + 1)}><RotateCw />重新识别{labels[kind]}</button>}
  </motion.aside>;
}
