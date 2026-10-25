import type { Tool } from './annotations';

export const toolKeys: Record<Tool, string> = {
  'text-select': 'O', select: 'V', arrow: 'A', line: 'L', rectangle: 'R', ellipse: 'E',
  pen: 'P', highlight: 'H', text: 'T', number: 'N', redact: 'B', mosaic: 'M', blur: 'U', crop: 'C', picker: 'I'
};
export const toolForKey = (key: string) => (Object.keys(toolKeys) as Tool[]).find(tool => toolKeys[tool].toLowerCase() === key.toLowerCase());
