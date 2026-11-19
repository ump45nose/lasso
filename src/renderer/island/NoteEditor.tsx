import { useEffect, useRef } from 'react';
import { Annotation, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { GFM } from '@lezer/markdown';

const externalChange = Annotation.define<boolean>();

class ListBullet extends WidgetType {
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'en-md-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) { super(); }
  eq(other: TaskCheckbox) { return this.checked === other.checked && this.from === other.from; }
  toDOM(view: EditorView) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'en-task-checkbox';
    button.setAttribute('role', 'checkbox');
    button.setAttribute('aria-label', '切换待办状态');
    button.setAttribute('aria-checked', String(this.checked));
    button.textContent = this.checked ? '✓' : '';
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: this.checked ? ' ' : 'x' } }));
    return button;
  }
  ignoreEvent() { return false; }
}

const liveMarkdown = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) this.decorations = this.build(update.view);
  }
  build(view: EditorView): DecorationSet {
    const { state } = view;
    const decorations: ReturnType<Decoration['range']>[] = [];
    const mark = (from: number, to: number, className: string) => { if (from < to) decorations.push(Decoration.mark({ class: className }).range(from, to)); };
    const hide = (from: number, to: number) => { if (from < to) decorations.push(Decoration.replace({}).range(from, to)); };
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({ from, to, enter: node => {
        const name = node.name;
        if (/^ATXHeading[1-6]$/.test(name)) {
          decorations.push(Decoration.line({ class: `en-md-heading en-md-heading-${name.slice(-1)}` }).range(state.doc.lineAt(node.from).from));
        } else if (name === 'StrongEmphasis') mark(node.from, node.to, 'en-md-strong');
        else if (name === 'Emphasis') mark(node.from, node.to, 'en-md-emphasis');
        else if (name === 'Strikethrough') mark(node.from, node.to, 'en-md-strike');
        else if (name === 'InlineCode') mark(node.from, node.to, 'en-md-code');
        else if (name === 'Link') mark(node.from, node.to, 'en-md-link');
        else if (name === 'Blockquote') {
          for (let pos = state.doc.lineAt(node.from).from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            decorations.push(Decoration.line({ class: 'en-md-quote' }).range(line.from));
            if (line.to >= node.to || line.to === state.doc.length) break;
            pos = line.to + 1;
          }
        } else if (name === 'CodeText') {
          for (let pos = state.doc.lineAt(node.from).from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            decorations.push(Decoration.line({ class: 'en-md-code-line' }).range(line.from));
            if (line.to >= node.to || line.to === state.doc.length) break;
            pos = line.to + 1;
          }
        }
        if (name === 'ListMark' && node.node.parent?.getChild('Task')) {
          let end = node.to;
          if (state.doc.sliceString(end, end + 1) === ' ') end++;
          hide(node.from, end);
        } else if (name === 'ListMark' && node.node.parent?.parent?.name === 'BulletList') {
          decorations.push(Decoration.replace({ widget: new ListBullet() }).range(node.from, node.to));
        } else if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark', 'QuoteMark'].includes(name) && !(name === 'CodeMark' && node.node.parent?.name === 'FencedCode')) {
          let end = node.to;
          if (name === 'HeaderMark' || name === 'QuoteMark') {
            if (state.doc.sliceString(end, end + 1) === ' ') end++;
          }
          hide(node.from, end);
        } else if (name === 'Link') {
          const text = state.doc.sliceString(node.from, node.to);
          const close = text.lastIndexOf('](');
          if (text.startsWith('[') && close >= 0) { hide(node.from, node.from + 1); hide(node.from + close, node.to); }
        } else if (name === 'TaskMarker') {
          const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
          decorations.push(Decoration.replace({ widget: new TaskCheckbox(checked, node.from) }).range(node.from, node.to));
        }
      }});
    }
    return Decoration.set(decorations, true);
  }
}, { decorations: plugin => plugin.decorations });

// Recognize a freshly typed marker even when the browser batches keystrokes.
const smartListInput = EditorState.transactionFilter.of(transaction => {
  if (!transaction.docChanged || transaction.annotation(externalChange) || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
  const selection = transaction.newSelection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return transaction;
  const pos = selection.main.head;
  const line = transaction.newDoc.lineAt(pos);
  const oldPos = transaction.startState.selection.main.head;
  const oldLine = transaction.startState.doc.lineAt(oldPos);
  const oldMarker = /^(\s*(?:-|\d+[.)])(?: \[[ xX]\])?) $/.exec(oldLine.text);
  const compact = oldMarker && line.text.startsWith(oldMarker[1]) && /^\S/.test(line.text.slice(oldMarker[1].length));
  const marker = pos === line.to && /^\s*(?:-|\d+[.)])$/.test(line.text);
  if (!marker && !compact) return transaction;
  for (let node = syntaxTree(transaction.startState).resolveInner(oldPos, -1); node; node = node.parent!) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return transaction;
  }
  const insertAt = compact ? line.from + oldMarker[1].length : pos;
  return [transaction, { changes: { from: insertAt, insert: ' ' }, selection: EditorSelection.cursor(pos + 1), sequential: true }];
});

export function NoteEditor({
  value,
  onChange,
  onBlur,
  editorRef,
  className = 'en-editor',
  ariaLabel = '便签内容',
  placeholderText = '随手记录灵感、命令片段或待办… 自动保存为本地 Markdown',
  onSubmit,
  onPasteHtml
}: {
  value: string;
  onChange(value: string): void;
  onBlur?(): void;
  editorRef: React.RefObject<EditorView | null>;
  className?: string;
  ariaLabel?: string;
  placeholderText?: string;
  onSubmit?(value: string): void;
  onPasteHtml?(plain: string, html: string): Promise<string>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onBlur, onSubmit, onPasteHtml });
  callbacks.current = { onChange, onBlur, onSubmit, onPasteHtml };
  useEffect(() => {
    if (!host.current) return;
    const submitKey = onSubmit
      ? [
          {
            key: 'Enter',
            run: (view: EditorView) => {
              if (view.composing) return false;
              callbacks.current.onSubmit?.(view.state.doc.toString());
              return true;
            }
          },
          { key: 'Shift-Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) }
        ]
      : [{ key: 'Enter', run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) }];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [
        history(), markdown({ extensions: [GFM], addKeymap: false }), keymap.of([...submitKey, { key: 'Backspace', run: deleteMarkupBackward }, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
        placeholder(placeholderText), smartListInput, liveMarkdown,
        EditorView.updateListener.of(update => { if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) callbacks.current.onChange(update.state.doc.toString()); }),
        EditorView.domEventHandlers({
          blur: () => { callbacks.current.onBlur?.(); },
          paste: (event, editorView) => {
            const convert = callbacks.current.onPasteHtml;
            if (!convert) return false;
            const html = event.clipboardData?.getData('text/html') ?? '';
            if (!html.trim()) return false;
            const plain = event.clipboardData?.getData('text/plain') ?? '';
            event.preventDefault();
            const { from, to } = editorView.state.selection.main;
            void convert(plain, html)
              .then(md => {
                const insert = md || plain;
                editorView.dispatch({
                  changes: { from, to, insert },
                  selection: EditorSelection.cursor(from + insert.length)
                });
              })
              .catch(() => {
                editorView.dispatch({
                  changes: { from, to, insert: plain },
                  selection: EditorSelection.cursor(from + plain.length)
                });
              });
            return true;
          }
        })
      ] })
    });
    editorRef.current = view;
    return () => { editorRef.current = null; view.destroy(); };
  }, [editorRef, ariaLabel, placeholderText, Boolean(onSubmit)]);
  useEffect(() => {
    const view = editorRef.current;
    if (view && value !== view.state.doc.toString()) {
      const previous = view.state.doc.toString();
      let from = 0;
      while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
      let oldEnd = previous.length, newEnd = value.length;
      while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
      view.dispatch({ changes: { from, to: oldEnd, insert: value.slice(from, newEnd) }, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] });
    }
  }, [value, editorRef]);
  return <div className={className} ref={host} />;
}
