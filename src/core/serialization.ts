const xmlClass = Symbol('Yii XML object class');

/** PHP object class names are XML tags, but are absent from JSON responses. */
export function yiiObject<T extends object>(type: string, value: T): T {
  Object.defineProperty(value, xmlClass, { value: type });
  return value;
}

export function xmlResponse(value: unknown): string {
  const escape = (data: unknown) => String(data ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]!));
  const wrap = (name: string, content: string, scalar = false) => content || scalar ? `<${name}>${content}</${name}>` : `<${name}/>`;
  function content(data: unknown): string {
    if (data === null || typeof data !== 'object') return escape(data);
    const children = Object.entries(data).map(([key, nested]) => {
      // A numeric array key whose value is an object emits the object tag itself.
      if (Array.isArray(data) && nested !== null && typeof nested === 'object' && (nested as any)[xmlClass]) return content(nested);
      const name = /^[A-Za-z_][\w.-]*$/.test(key) ? key : 'item';
      return wrap(name, content(nested), nested === null || typeof nested !== 'object');
    }).join('');
    return (data as any)[xmlClass] ? wrap((data as any)[xmlClass], children) : children;
  }
  return value === null || value === undefined ? '' : `<?xml version="1.0" encoding="UTF-8"?>\n${wrap('response', content(value), typeof value !== 'object')}\n`;
}
