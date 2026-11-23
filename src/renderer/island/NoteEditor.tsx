import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Annotation, EditorSelection, EditorState, Facet, StateField, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand, markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, keymap, placeholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import { CodeXml, Copy, Image as ImageIcon, Pin, Trash2, ZoomIn } from '../icons';

const externalChange = Annotation.define<boolean>();
const IMAGE_MD_RE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"[^"\n]*")?\)/g;
const ASSET_SRC_RE = /^(?:\.\/)?assets\/([^/\\]+\.(?:png|jpe?g|gif|webp))$/i;
const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;
const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;

export type NoteImageAction = 'preview' | 'copy' | 'pin';

export interface NoteImageRef {
  alt: string;
  canonicalSrc: string;
  displaySrc: string;
  label: string;
}

export function resolveNoteImageRef(rawSrc: string, alt = ''): NoteImageRef | null {
  const trimmed = rawSrc.trim();
  const assetMatch = ASSET_SRC_RE.exec(trimmed);
  if (assetMatch) {
    const fileName = assetMatch[1];
    return {
      alt,
      canonicalSrc: `assets/${fileName}`,
      displaySrc: `lasso-note://assets/${encodeURIComponent(fileName)}`,
      label: fileName
    };
  }
  if (DATA_IMAGE_RE.test(trimmed)) {
    return {
      alt,
      canonicalSrc: trimmed,
      displaySrc: trimmed,
      label: '内嵌图片'
    };
  }
  return null;
}

export function countNoteImages(markdownText: string): number {
  let count = 0;
  let inFence = false;
  for (const line of markdownText.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    IMAGE_MD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_MD_RE.exec(line)) !== null) {
      if (resolveNoteImageRef(match[2] ?? match[3] ?? '', match[1] ?? '')) count++;
    }
  }
  return count;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXT_RE.test(file.name);
}

export function insertNoteImages(view: EditorView, from: number, to: number, relativePaths: string[]) {
  if (!relativePaths.length) return;
  const doc = view.state.doc;
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const before = safeFrom > 0 ? doc.sliceString(safeFrom - 1, safeFrom) : '';
  const after = safeTo < doc.length ? doc.sliceString(safeTo, safeTo + 1) : '';
  const prefix = safeFrom > 0 && before !== '\n' ? '\n' : '';
  const body = relativePaths.map(path => `![](${path})`).join('\n');
  const suffix = after === '\n' ? '\n' : '\n';
  const insert = `${prefix}${body}${suffix}`;
  view.dispatch({
    changes: { from: safeFrom, to: safeTo, insert },
    selection: EditorSelection.cursor(safeFrom + insert.length),
    scrollIntoView: true
  });
}

type ImageWidgetActionHandler = (action: NoteImageAction, image: NoteImageRef) => void;

const imageActionFacet = Facet.define<ImageWidgetActionHandler | null, ImageWidgetActionHandler | null>({
  combine: values => values.find(Boolean) ?? null
});

const widgetRoots = new WeakMap<HTMLElement, Root>();

function findImageMatchInDoc(state: EditorState, hintPos: number, canonicalSrc: string): { lineFrom: number; lineTo: number; matchFrom: number; matchTo: number; standalone: boolean } | null {
  const safePos = Math.max(0, Math.min(hintPos, state.doc.length));
  const line = state.doc.lineAt(safePos);
  const scanLine = (targetLine: { from: number; to: number; text: string }) => {
    IMAGE_MD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_MD_RE.exec(targetLine.text)) !== null) {
      const ref = resolveNoteImageRef(match[2] ?? match[3] ?? '', match[1] ?? '');
      if (ref && ref.canonicalSrc === canonicalSrc) {
        return {
          lineFrom: targetLine.from,
          lineTo: targetLine.to,
          matchFrom: targetLine.from + match.index,
          matchTo: targetLine.from + match.index + match[0].length,
          standalone: targetLine.text.trim() === match[0]
        };
      }
    }
    return null;
  };
  return scanLine(line) ?? (line.number > 1 ? scanLine(state.doc.line(line.number - 1)) : null);
}

function NoteImageCard({
  image,
  editingSource,
  onLoad,
  onAction,
  onEditSource,
  onDelete
}: {
  image: NoteImageRef;
  editingSource: boolean;
  onLoad: () => void;
  onAction: (action: NoteImageAction) => void;
  onEditSource: () => void;
  onDelete: () => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <figure className={'en-img-card' + (editingSource ? ' source-open' : '')} contentEditable={false}>
      {failed ? (
        <div className="en-img-missing">
          <ImageIcon size={16} />
          <span className="trunc">找不到图片：{image.label}</span>
        </div>
      ) : (
        <button
          type="button"
          className="en-img-frame"
          aria-label={`放大查看 ${image.alt || image.label}`}
          onMouseDown={event => event.preventDefault()}
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onAction('preview');
          }}
        >
          <img
            src={image.displaySrc}
            alt={image.alt || image.label}
            draggable={false}
            onLoad={onLoad}
            onError={() => {
              setFailed(true);
              onLoad();
            }}
          />
        </button>
      )}
      <div className="en-img-bar" role="toolbar" aria-label="图片操作" onMouseDown={event => event.preventDefault()}>
        {!failed && (
          <>
            <button
              type="button"
              aria-label="放大查看"
              title="放大查看"
              onClick={event => {
                event.stopPropagation();
                onAction('preview');
              }}
            >
              <ZoomIn size={13} />
            </button>
            <button
              type="button"
              aria-label="复制图片"
              title="复制图片"
              onClick={event => {
                event.stopPropagation();
                onAction('copy');
              }}
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              aria-label="钉为桌面贴图"
              title="钉为桌面贴图"
              onClick={event => {
                event.stopPropagation();
                onAction('pin');
              }}
            >
              <Pin size={13} />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="编辑图片标记"
          title="编辑图片标记"
          onClick={event => {
            event.stopPropagation();
            onEditSource();
          }}
        >
          <CodeXml size={13} />
        </button>
        <button
          type="button"
          className="danger"
          aria-label="删除图片"
          title="删除图片（⌘Z 可撤销）"
          onClick={event => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      {image.alt && <figcaption className="en-img-caption trunc">{image.alt}</figcaption>}
    </figure>
  );
}

class NoteImageWidget extends WidgetType {
  constructor(
    readonly image: NoteImageRef,
    readonly editingSource: boolean
  ) {
    super();
  }

  eq(other: NoteImageWidget) {
    return (
      this.image.displaySrc === other.image.displaySrc &&
      this.image.canonicalSrc === other.image.canonicalSrc &&
      this.image.alt === other.image.alt &&
      this.editingSource === other.editingSource
    );
  }

  toDOM(view: EditorView) {
    const host = document.createElement('div');
    host.className = 'en-img-widget';
    const root = createRoot(host);
    widgetRoots.set(host, root);

    const locate = () => {
      try {
        return findImageMatchInDoc(view.state, view.posAtDOM(host), this.image.canonicalSrc);
      } catch {
        return null;
      }
    };

    const handleAction = (action: NoteImageAction) => {
      view.state.facet(imageActionFacet)?.(action, this.image);
    };

    const handleEditSource = () => {
      const found = locate();
      if (!found) return;
      view.dispatch({
        selection: EditorSelection.cursor(found.matchTo),
        scrollIntoView: true
      });
      view.focus();
    };

    const handleDelete = () => {
      const found = locate();
      if (!found) return;
      let from = found.matchFrom;
      let to = found.matchTo;
      if (found.standalone) {
        from = found.lineFrom;
        to = found.lineTo;
        if (to < view.state.doc.length && view.state.doc.sliceString(to, to + 1) === '\n') {
          to += 1;
        } else if (from > 0 && view.state.doc.sliceString(from - 1, from) === '\n') {
          from -= 1;
        }
      }
      view.dispatch({
        changes: { from, to, insert: '' },
        selection: EditorSelection.cursor(Math.min(from, view.state.doc.length - (to - from)))
      });
      view.focus();
    };

    root.render(
      <NoteImageCard
        image={this.image}
        editingSource={this.editingSource}
        onLoad={() => view.requestMeasure()}
        onAction={handleAction}
        onEditSource={handleEditSource}
        onDelete={handleDelete}
      />
    );
    return host;
  }

  destroy(dom: HTMLElement) {
    const root = widgetRoots.get(dom);
    if (root) {
      widgetRoots.delete(dom);
      queueMicrotask(() => root.unmount());
    }
  }

  ignoreEvent() {
    return true;
  }
}

function buildImageDecorations(state: EditorState): DecorationSet {
  const decorations: ReturnType<Decoration['range']>[] = [];
  const selection = state.selection.main;
  let inFence = false;
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo);
    if (/^\s*(?:```|~~~)/.test(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.text.includes('![')) continue;

    IMAGE_MD_RE.lastIndex = 0;
    const matches: { raw: string; ref: NoteImageRef }[] = [];
    let match: RegExpExecArray | null;
    while ((match = IMAGE_MD_RE.exec(line.text)) !== null) {
      const ref = resolveNoteImageRef(match[2] ?? match[3] ?? '', match[1] ?? '');
      if (ref) matches.push({ raw: match[0], ref });
    }
    if (!matches.length) continue;

    const standalone = matches.length === 1 && line.text.trim() === matches[0].raw;
    const cursorInLine = selection.to >= line.from && selection.from <= line.to;

    if (standalone && !cursorInLine) {
      decorations.push(
        Decoration.replace({
          widget: new NoteImageWidget(matches[0].ref, false),
          block: true
        }).range(line.from, line.to)
      );
    } else {
      for (const item of matches) {
        decorations.push(
          Decoration.widget({
            widget: new NoteImageWidget(item.ref, true),
            block: true,
            side: 1
          }).range(line.to)
        );
      }
    }
  }
  return Decoration.set(decorations, true);
}

const imagePreviewField = StateField.define<DecorationSet>({
  create(state) {
    return buildImageDecorations(state);
  },
  update(decorations, transaction) {
    if (transaction.docChanged || transaction.selection) {
      return buildImageDecorations(transaction.state);
    }
    return decorations;
  },
  provide: field => EditorView.decorations.from(field)
});

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

function extractClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter(isImageFile);
  if (files.length > 0) return files;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  return fromItems;
}

export function NoteEditor({
  value,
  onChange,
  onBlur,
  editorRef,
  className = 'en-editor',
  ariaLabel = '便签内容',
  placeholderText = '随手记录灵感、命令片段或待办… 自动保存为本地 Markdown',
  onSubmit,
  onPasteHtml,
  enableImagePreview = false,
  onPasteImage,
  onImageAction
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
  enableImagePreview?: boolean;
  onPasteImage?(file: { bytes: Uint8Array; name?: string; mimeType?: string } | null): Promise<{ relativePath: string } | null>;
  onImageAction?(action: NoteImageAction, image: NoteImageRef): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onBlur, onSubmit, onPasteHtml, onPasteImage, onImageAction });
  callbacks.current = { onChange, onBlur, onSubmit, onPasteHtml, onPasteImage, onImageAction };
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
    const imageExtensions = enableImagePreview
      ? [
          imageActionFacet.of((action, image) => callbacks.current.onImageAction?.(action, image)),
          imagePreviewField
        ]
      : [];
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [
        history(), markdown({ extensions: [GFM], addKeymap: false }), keymap.of([...submitKey, { key: 'Backspace', run: deleteMarkupBackward }, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'false' }),
        placeholder(placeholderText), smartListInput, liveMarkdown, ...imageExtensions,
        EditorView.updateListener.of(update => { if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) callbacks.current.onChange(update.state.doc.toString()); }),
        EditorView.domEventHandlers({
          blur: () => { callbacks.current.onBlur?.(); },
          paste: (event, editorView) => {
            const saveImage = callbacks.current.onPasteImage;
            if (saveImage) {
              const imageFiles = extractClipboardImages(event.clipboardData);
              if (imageFiles.length > 0) {
                event.preventDefault();
                const { from, to } = editorView.state.selection.main;
                void (async () => {
                  const savedPaths: string[] = [];
                  for (const file of imageFiles) {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const saved = await saveImage({ bytes, name: file.name, mimeType: file.type });
                    if (saved?.relativePath) savedPaths.push(saved.relativePath);
                  }
                  if (savedPaths.length && editorRef.current === editorView) {
                    insertNoteImages(editorView, from, to, savedPaths);
                  }
                })();
                return true;
              }
              const plainProbe = event.clipboardData?.getData('text/plain') ?? '';
              const htmlProbe = event.clipboardData?.getData('text/html') ?? '';
              if (!plainProbe && !htmlProbe) {
                event.preventDefault();
                const { from, to } = editorView.state.selection.main;
                void saveImage(null).then(saved => {
                  if (saved?.relativePath && editorRef.current === editorView) {
                    insertNoteImages(editorView, from, to, [saved.relativePath]);
                  }
                });
                return true;
              }
            }

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
  }, [editorRef, ariaLabel, placeholderText, Boolean(onSubmit), enableImagePreview]);
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
