import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateSourceCheckout } from './check-parity';

// Optional reference validation, separate from normal Node-only CI. Run the
// accepted Yii checkout with its vendor dependencies and isolated test services.
// Never point this runner at a production backend: some verbs are mutations.
async function main() {
  const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--source-root') || !process.argv.includes('--reference')) throw new Error('Usage: node --import tsx scripts/verify-yii-http.ts --source-root <accepted Yii checkout> --reference http://127.0.0.1:<port>');
  const source = argument('--source-root'), base = new URL(argument('--reference'));
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Reference must be an isolated localhost HTTP service');
  const freshness = validateSourceCheckout(source);
  if (freshness.length) throw new Error(freshness.join('\n'));
  const oracle = JSON.parse(readFileSync(resolve(__dirname, '../tests/fixtures/yii-anonymous-http.json'), 'utf8'));
  let count = 0, failed = 0;
  for (const group of oracle.groups) for (const row of group.cases) {
    const response = await fetch(new URL(row.path, base), {
      method: row.method, headers: { Origin: 'https://isolated.example', 'Content-Type': 'application/json' },
      ...(['POST', 'PUT', 'PATCH'].includes(row.method) ? { body: '{}' } : {}),
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text(), mime = (response.headers.get('content-type') ?? '').split(';')[0];
    const body = row.method === 'HEAD' || !raw ? null : mime === 'text/html'
      ? { htmlTitle: /<title>(.*?)<\/title>/s.exec(raw)?.[1] }
      : JSON.parse(raw);
    const actual = { status: response.status, mime, body, allow: response.headers.get('allow'), auth: response.headers.get('www-authenticate') };
    count++;
    if (!isDeepStrictEqual(actual, group.expected)) { failed++; process.stderr.write(`DIFFERENT ${row.method} ${row.path} (status ${response.status})\n`); }
  }
  process.stdout.write(`Executed Yii reference: ${count - failed}/${count} anonymous/precondition HTTP cases match the stored oracle.\n`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Reference check failed'}\n`); process.exitCode = 1; });
