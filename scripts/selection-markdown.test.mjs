import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: ['src/main/selection-markdown.ts'], bundle: true, platform: 'node',
  format: 'cjs', external: ['electron'], write: false
});
const html = '<p>Other issues:</p><ol><li>Check orca.</li><li>Harden ape.</li></ol><p>Another paragraph with <code>6eb89c3</code>.</p>';

class Item {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) {
    const value = this.values[type];
    return typeof value === 'string' ? new Blob([value]) : value;
  }
}

function fixture({ noCopy = false, concurrentCopy = false, readError = false, concealed = false } = {}) {
  let count = 10, reads = 0;
  let items = [new Item({
    'text/plain': 'Original clipboard', 'text/html': '<b>Original clipboard</b>',
    'application/x-custom': new Blob(['opaque']),
    'electron application/bookmark': { title: 'Bookmark', url: 'https://example.com' }
  })];
  const clipboard = {
    read: async () => {
      if (++reads === 2) {
        if (readError) throw Error('Copy read failed');
        if (concurrentCopy) { items = [new Item({ 'text/plain': 'New user copy' })]; ++count; }
      }
      return items;
    },
    write: async values => { items = values; ++count; },
    clear: () => { items = []; ++count; }
  };
  const ax = {
    frontmostApp: () => ({ pid: 123, bundleId: 'com.google.Chrome' }),
    pasteboardMeta: () => ({ changeCount: count, concealed }),
    copySelectionToProcess: () => {
      if (!noCopy) { items = [new Item({ 'text/plain': 'Other issues:1. Check orca.2. Harden ape.Another paragraph with 6eb89c3.', 'text/html': html })]; ++count; }
      return true;
    }
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: name => name === 'electron' ? { clipboard, ClipboardItem: Item } : require(name),
    Blob, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, console, process
  });
  return { ...module.exports, ax, clipboard };
}

test('rich selection restores two list items, separate paragraphs, and code', async () => {
  const f = fixture();
  const markdown = await f.readSelectionMarkdown(123, f.ax);
  assert.match(markdown, /^Other issues:\n\n1\.\s+Check orca\.\n2\.\s+Harden ape\.\n\nAnother paragraph with `6eb89c3`\.$/);
  const [restored] = await f.clipboard.read();
  assert.equal(await (await restored.getType('text/plain')).text(), 'Original clipboard');
  assert.equal(await (await restored.getType('text/html')).text(), '<b>Original clipboard</b>');
  assert.equal(await (await restored.getType('application/x-custom')).text(), 'opaque');
  assert.deepEqual(await restored.getType('electron application/bookmark'), { title: 'Bookmark', url: 'https://example.com' });
});

test('a concurrent user copy is retained', async () => {
  const f = fixture({ concurrentCopy: true });
  assert.equal(await f.readSelectionMarkdown(123, f.ax), null);
  const [current] = await f.clipboard.read();
  assert.equal(await (await current.getType('text/plain')).text(), 'New user copy');
});

test('copy failure leaves original clipboard intact', async () => {
  const f = fixture({ noCopy: true });
  assert.equal(await f.readSelectionMarkdown(123, f.ax), null);
  const [current] = await f.clipboard.read();
  assert.equal(await (await current.getType('text/plain')).text(), 'Original clipboard');
});

test('read failure still restores every original format', async () => {
  const f = fixture({ readError: true });
  await assert.rejects(f.readSelectionMarkdown(123, f.ax), /Copy read failed/);
  const [current] = await f.clipboard.read();
  assert.equal(await (await current.getType('text/plain')).text(), 'Original clipboard');
  assert.equal(current.types.length, 4);
});

test('source process mismatch and concealed clipboard do not trigger copy', async () => {
  for (const f of [fixture(), fixture({ concealed: true })]) {
    f.ax.copySelectionToProcess = () => { throw Error('Must not copy'); };
    assert.equal(await f.readSelectionMarkdown(f.ax.pasteboardMeta().concealed ? 123 : 456, f.ax), null);
  }
});

test('plain-text line separators and rich links, tables, and fenced code survive', () => {
  const f = fixture();
  assert.equal(f.selectionMarkdown('First\rSecond\u2028Third\u2029Fourth', ''), 'First\nSecond\nThird\nFourth');
  const converted = f.selectionMarkdown('', '<h2>Notes</h2><p><strong>Bold</strong> <a href="https://example.com">Link</a></p><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table><pre><code>\\- literal\n</code></pre>');
  assert.match(converted, /## Notes/);
  assert.match(converted, /\*\*Bold\*\* \[Link\]\(https:\/\/example\.com\)/);
  assert.match(converted, /\| Name \|/);
  assert.match(converted, /```\n\\- literal\n```/);
});

test('compact numbered selections remain separate list items without changing decimal or code text', () => {
  const f = fixture();
  assert.equal(f.selectionMarkdown('其它问题：\n1.查一下 orca 为什么会并发调用 2 次\n2.ape 会做一下加固', ''),
    '其它问题：\n1. 查一下 orca 为什么会并发调用 2 次\n2. ape 会做一下加固');
  assert.equal(f.selectionMarkdown('Other issues:\n1. Why does orca make concurrent calls twice\n2.ape will harden this', ''),
    'Other issues:\n1. Why does orca make concurrent calls twice\n2. ape will harden this');
  assert.equal(f.selectionMarkdown('1.25 is a decimal\nVersion 2.ape\n```\n2.ape\n```\n`1.literal`', ''),
    '1.25 is a decimal\nVersion 2.ape\n```\n2.ape\n```\n`1.literal`');
});

test('rich Gemini list with bold, inline code, and links converts cleanly to Markdown', () => {
  const f = fixture();
  const geminiHtml = [
    '<p>但今天周三（<code>2026-11-18</code>）这四笔账你可别想滑过去，老实报数：</p>',
    '<ul>',
    '<li><p><strong>19:00 约陈逸静与球课群招人</strong>：按你日历上锁好的 <a href="https://www.google.com/calendar/event?eid=abc&amp;ctz=Asia/Taipei">联系陈逸静约球＋原羽毛球课群招人</a>，记住<strong>明天（周四）下午 <code>14:00</code></strong>。</p></li>',
    '<li><p><strong>今日身体与睡眠补血</strong>：今天白天在工位还困不困？</p></li>',
    '</ul>'
  ].join('');
  const md = f.selectionMarkdown('plain fallback', geminiHtml);
  assert.match(md, /^但今天周三（`2026-11-18`）这四笔账你可别想滑过去，老实报数：/);
  assert.match(md, /\n- \*\*19:00 约陈逸静与球课群招人\*\*：按你日历上锁好的 \[联系陈逸静约球＋原羽毛球课群招人\]\(https:\/\/www\.google\.com\/calendar\/event\?eid=abc&ctz=Asia\/Taipei\)/);
  assert.match(md, /\*\*明天（周四）下午 `14:00`\*\*/);
  assert.match(md, /\n- \*\*今日身体与睡眠补血\*\*：今天白天在工位还困不困？$/);
});

test('styled editor HTML wrapping raw Markdown preserves Markdown syntax without escaping', () => {
  const f = fixture();
  const rawMd = [
    '## Design Principle',
    '',
    '- **Focused**: run `npm run build`',
    '- See [guide](https://example.com)',
    '',
    '| Key | Value |',
    '| --- | --- |',
    '| Mode | Markdown |'
  ].join('\n');
  const vscodeHtml = `<div style="font-family: Menlo"><div><span>## Design Principle</span></div><br><div><span>- **Focused**: run \`npm run build\`</span></div><div><span>- See [guide](https://example.com)</span></div><br><div><span>| Key | Value |</span></div><div><span>| --- | --- |</span></div><div><span>| Mode | Markdown |</span></div></div>`;
  const result = f.selectionMarkdown(rawMd, vscodeHtml);
  assert.equal(result, rawMd);
  assert.ok(!result.includes('\\#'));
  assert.ok(!result.includes('\\*'));
  assert.ok(!result.includes('\\|'));
});
