import type { Preset } from '../shared/contracts';
import { PresetPicker } from './ImageEntry';

export function TextEntry({ input, presets }: { input: { id: string; text: string }; presets: Preset[] }) {
  return <div className="l-image">
    <div className="l-image-head"><span className="l-small">图中所选文字</span><h2>这段文字，想问什么？</h2></div>
    <figure className="l-image-fig">
      <pre className="l-print l-text-preview">{input.text}</pre>
      <figcaption>
        <span>仅使用所选文字，不附带图片 · <span className="mono">{input.text.length.toLocaleString()}</span> 字</span>
        <button className="l-text-btn push" onClick={() => void window.desktop.removeText()}>移除</button>
      </figcaption>
    </figure>
    <PresetPicker key={input.id} presets={presets} input={{ textId: input.id }} />
  </div>;
}
