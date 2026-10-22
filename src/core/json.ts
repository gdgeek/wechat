import type { Row } from './contracts';
const decoded = Symbol('decoded JSON columns');
export function markJsonDecoded<T extends Row>(row: T): T { Object.defineProperty(row, decoded, { value: true }); return row; }
export function hasDecodedJson(row: Row): boolean { return (row as any)[decoded] === true; }
// MariaDB exposes JSON columns as LONGTEXT in protocol metadata. These are the
// JSON columns in the frozen migration schema, including the new session table.
const legacy: Record<string, string[]> = { player: ['info'], gift: ['info'], record: ['game'], setup: ['slogans', 'pictures', 'thumbs', 'shots'], node_browser_session: ['data'] };
export function isJsonColumn(table: string, column: string, type?: string | number): boolean { return type === 245 || typeof type === 'string' && type.toLowerCase().startsWith('json') || legacy[table]?.includes(column) === true; }
