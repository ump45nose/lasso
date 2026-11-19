const restoreBlockMarker = (line: string) => line
  .replace(/^( {0,3})\\([-+*]|#{1,6}|>)(?=[ \t])/, '$1$2')
  .replace(/^( {0,3}\d+)\\([.)])(?=\D)/, '$1$2')
  // Turndown pads list items with 3 spaces ("-   item"); normalize to single space.
  .replace(/^( {0,3}[-+*]) {2,}(?=\S)/, '$1 ')
  // Rich-text selection may omit the space after a list number ("2.ape").
  .replace(/^( {0,3}\d{1,9}[.)])(?=[^\s\d])/, '$1 ');

/** Restore Markdown copied from rich text, without changing fenced code. */
export function normalizeTranslationMarkdown(text: string): string {
  let fence: { char: string; length: number } | null = null;
  return text.replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n').map((line, index, lines) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (fence) return line;
    const restored = restoreBlockMarker(line);
    const next = restoreBlockMarker(lines[index + 1] ?? '');
    // A block already starts a new line. A trailing slash here would display literally.
    return /^ {0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|\||`{3,}|~{3,})/.test(next)
      ? restored.replace(/(?<!\\)\\$/, '')
      : restored;
  }).join('\n');
}

export function formatMarkdownBreaks(markdown: string): string {
  const lines = normalizeTranslationMarkdown(markdown).split('\n');
  let fence: { char: string; length: number } | null = null;
  const isBlockLine = (line: string) =>
    /^\s*(?:$|#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
  return lines
    .map((line, idx) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        return line;
      }
      if (fence || idx === lines.length - 1) return line;
      const next = lines[idx + 1];
      if (!isBlockLine(line) && !isBlockLine(next) && !line.endsWith('  ') && !/(?<!\\)\\$/.test(line)) {
        return `${line}  `;
      }
      return line;
    })
    .join('\n');
}
