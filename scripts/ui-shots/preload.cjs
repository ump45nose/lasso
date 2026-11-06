// Registered before every renderer preload. Chromium clipboard APIs also stay in memory.
const { contextBridge } = require('electron');
contextBridge.executeInMainWorld({ func: () => {
  let items = [];
  const calls = [];
  class MemoryClipboardItem {
    constructor(values) { this.values = values; this.types = Object.keys(values); }
    async getType(type) {
      if (!this.types.includes(type)) throw new DOMException('Missing fixture clipboard type', 'NotFoundError');
      const value = await this.values[type];
      return value instanceof Blob ? value : new Blob([value], { type });
    }
    static supports() { return true; }
  }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: MemoryClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    read: async () => { calls.push('read'); return items; },
    write: async value => { calls.push('write'); items = value; },
    readText: async () => { calls.push('readText'); const item = items.find(value => value.types.includes('text/plain')); return item ? (await item.getType('text/plain')).text() : ''; },
    writeText: async value => { calls.push('writeText'); items = [new MemoryClipboardItem({ 'text/plain': String(value) })]; }
  } });
  Object.defineProperty(globalThis, '__uiShotsClipboard', { value: { calls, systemReads: 0, systemWrites: 0 } });
} });
