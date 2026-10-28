/** Function keys can stand alone; typing keys still need a modifier. Empty unbinds. */
export function isValidShortcut(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^(?:(?:(?:Command|Control|CommandOrControl|Alt|Option|Shift|Super)\+)+(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|2[0-4]))|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(value));
}
