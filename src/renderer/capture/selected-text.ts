export function selectedOCRText(root:HTMLElement|null){
  const selection=window.getSelection();
  if(!root||!selection||selection.isCollapsed||!selection.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return '';
  const range=selection.getRangeAt(0);
  // Positioned OCR glyphs do not produce reliable browser paragraph breaks.
  // Rebuild only the selected characters, with explicit OCR line separators.
  return Array.from(root.querySelectorAll('.editor-text-line')).map(line=>Array.from(line.children).map(span=>{
    const node=span.firstChild;if(!node||!range.intersectsNode(node))return '';
    const text=node.textContent||'';
    return text.slice(range.startContainer===node?range.startOffset:0,range.endContainer===node?range.endOffset:text.length);
  }).join('')).filter(Boolean).join('\n');
}
