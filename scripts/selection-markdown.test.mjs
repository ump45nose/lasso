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
