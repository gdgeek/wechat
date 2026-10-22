import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouter, createServices } from '../src/application';
import type { ApiRouter } from '../src/core/router';

export interface SnapshotRoute {
  method: string;
  path: string;
  sample: string;
  parameters: Record<string, string>;
  yiiRoute: string;
  action: string;
  controller: string;
  sourceStatus: 'resolvable' | 'missing-action' | 'missing-controller';
  actionSource: string | null;
  actionLine: number | null;
  inheritedRestAction: boolean;
  sourceAnyVerbFallback: boolean;
  sourcePattern: string;
  sampleMatchesSource: boolean;
  configLine: number;
  declaration: string;
  behaviorDomain: string;
  tests: string[];
  sourceResponse?: { status: number; body?: unknown; headers?: string[]; allow?: string[] };
}
export interface Difference { id: string; method: string; path: string; source: string; target: string; reason: string; }
export interface NegativeVerbCase {
  method: string; path: string; sample: string; sourceStatus: 'unconfigured-404';
  matchedSourceRules: string[]; configLine: number; sourceDeclaration: string; reason: string; tests: string[];
}
export interface NotFoundProbe {
  method: string; path: string; sample: string; sourceStatus: 'missing-action' | 'unrouted-action';
  matchedSourceRules: string[]; configLine: number; reason: string; tests: string[];
}
export interface RouteSnapshot {
  schemaVersion: number;
  sourceFiles: Record<string, string>;
  summary: { declaredMethodPaths: number; resolvable: number; businessAndRest: number; optionsFallbacks: number; missingAction: number; missingController: number; };
  routes: SnapshotRoute[];
  knownDifferences: Difference[];
  registered404Preservations: Array<{ method: string; path: string; reason: string; tests: string[] }>;
  unconfiguredVerbCases: NegativeVerbCase[];
  notFoundProbes: NotFoundProbe[];
}
export interface CoveredRoute extends SnapshotRoute { coveredBy: 'registered-route' | 'implicit-head' | 'runtime-options'; targetPath: string; }
export interface RouteAudit {
  covered: CoveredRoute[];
  missing: SnapshotRoute[];
  preserved404: SnapshotRoute[];
  unexpected404Changes: SnapshotRoute[];
  documentedAdaptations: Difference[];
  unexplainedExtras: Array<{ method: string; path: string }>;
  negativeCasesCovered: Array<NegativeVerbCase | NotFoundProbe>;
  unexpectedVerbChanges: Array<NegativeVerbCase | NotFoundProbe>;
}

const project = resolve(__dirname, '..');
const normalize = (path: string) => path.replace(/:[A-Za-z_][\w]*/g, '{}').replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '') || '/';
const key = (method: string, path: string) => `${method.toUpperCase()} ${normalize(path)}`;

export function loadSnapshot(path = resolve(project, 'docs/route-parity.json')): RouteSnapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as RouteSnapshot;
}

/** Check provenance against the separately captured source-file manifest. */
export function validateSnapshot(snapshot: RouteSnapshot): string[] {
  const issues: string[] = [];
  if (snapshot.schemaVersion !== 1) issues.push('Unsupported route snapshot schema.');
  const source = JSON.parse(readFileSync(resolve(project, 'docs/source-manifest.json'), 'utf8')) as { files: Record<string, string> };
  for (const [file, hash] of Object.entries(snapshot.sourceFiles)) {
    if (!/^[a-f0-9]{64}$/.test(hash) || source.files[file] !== hash) issues.push(`Source snapshot hash mismatch: ${file}`);
  }
  if (!snapshot.sourceFiles['files/api/config/web.php']) issues.push('Missing frozen URL configuration provenance.');
  for (const row of snapshot.unconfiguredVerbCases) {
    if (row.sourceStatus !== 'unconfigured-404' || row.matchedSourceRules.length || !row.configLine || !row.reason || !row.tests.length) issues.push(`Invalid source negative case: ${row.method} ${row.path}`);
    if (snapshot.routes.some(source => source.method === row.method && source.path === row.path)) issues.push(`Negative case contradicts a source declaration: ${row.method} ${row.path}`);
    for (const test of row.tests) if (!existsSync(resolve(project, test))) issues.push(`Missing mapped test: ${test}`);
  }
  for (const row of snapshot.notFoundProbes) {
    const declaration = snapshot.routes.find(source => source.method === row.method && source.path === row.path);
    if (row.sourceStatus === 'missing-action' && declaration?.sourceStatus !== 'missing-action') issues.push(`Missing-action probe contradicts source: ${row.method} ${row.path}`);
    if (row.sourceStatus === 'unrouted-action' && (declaration || row.matchedSourceRules.length)) issues.push(`Unrouted-action probe contradicts source: ${row.method} ${row.path}`);
    if (!row.configLine || !row.reason || !row.tests.length) issues.push(`Invalid source 404 probe: ${row.method} ${row.path}`);
    for (const test of row.tests) if (!existsSync(resolve(project, test))) issues.push(`Missing mapped test: ${test}`);
  }
  const seen = new Set<string>();
  for (const row of snapshot.routes) {
    const identity = `${row.method} ${row.path}`;
    if (seen.has(identity)) issues.push(`Duplicate source declaration: ${identity}`);
    seen.add(identity);
    if (!row.yiiRoute || !row.controller || !row.configLine || !row.behaviorDomain) issues.push(`Missing source evidence: ${identity}`);
    if (!row.tests.length) issues.push(`Missing test mapping: ${identity}`);
    for (const test of row.tests) if (!existsSync(resolve(project, test))) issues.push(`Missing mapped test: ${test}`);
    if (row.sourceStatus === 'resolvable' && (!row.actionSource || !row.actionLine)) issues.push(`Missing resolved action evidence: ${identity}`);
  }
  const summary = {
    declaredMethodPaths: snapshot.routes.length,
    resolvable: snapshot.routes.filter(row => row.sourceStatus === 'resolvable').length,
    businessAndRest: snapshot.routes.filter(row => row.sourceStatus === 'resolvable' && row.action !== 'options').length,
    optionsFallbacks: snapshot.routes.filter(row => row.sourceStatus === 'resolvable' && row.action === 'options').length,
    missingAction: snapshot.routes.filter(row => row.sourceStatus === 'missing-action').length,
    missingController: snapshot.routes.filter(row => row.sourceStatus === 'missing-controller').length,
  };
  if (JSON.stringify(summary) !== JSON.stringify(snapshot.summary)) issues.push('Source summary does not match its route inventory.');
  return [...new Set(issues)];
}

/** Pure comparison: does not invoke a handler, connect to data services or read PHP. */
export function auditRoutes(snapshot: RouteSnapshot, router: Pick<ApiRouter, 'routes' | 'match'>): RouteAudit {
  const audit: RouteAudit = { covered: [], missing: [], preserved404: [], unexpected404Changes: [], documentedAdaptations: [], unexplainedExtras: [], negativeCasesCovered: [], unexpectedVerbChanges: [] };
  const differences = new Map(snapshot.knownDifferences.map(row => [key(row.method, row.path), row]));
  const explicit404s = new Set(snapshot.registered404Preservations.map(row => key(row.method, row.path)));
  for (const source of snapshot.routes) {
    const matched = router.match(source.method, source.sample);
    const sameShape = matched && normalize(matched.route.path) === normalize(source.path);
    if (source.sourceStatus !== 'resolvable') {
      if (!sameShape || explicit404s.has(key(source.method, source.path))) audit.preserved404.push(source);
      else {
        const difference = differences.get(key(source.method, source.path));
        if (difference) audit.documentedAdaptations.push(difference);
        else audit.unexpected404Changes.push(source);
      }
      continue;
    }
    if (sameShape) {
      audit.covered.push({ ...source, coveredBy: source.method === 'HEAD' && matched.route.method === 'GET' ? 'implicit-head' : 'registered-route', targetPath: matched.route.path });
      const difference = differences.get(key(source.method, source.path));
      if (difference && !audit.documentedAdaptations.some(row => row.id === difference.id)) audit.documentedAdaptations.push(difference);
      continue;
    }
    // Yii's wildcard OptionsAction sets 405 for unsupported methods. The Nest
    // HTTP dispatcher reaches the actual OPTIONS route for this same resource.
    const options = source.action === 'options' ? router.match('OPTIONS', source.sample) : null;
    if (options && normalize(options.route.path) === normalize(source.path)) audit.covered.push({ ...source, coveredBy: 'runtime-options', targetPath: options.route.path });
    else audit.missing.push(source);
  }
  const available = new Set(snapshot.routes.filter(row => row.sourceStatus === 'resolvable').map(row => key(row.method, row.path)));
  for (const route of router.routes) {
    const identity = key(route.method, route.path);
    if (available.has(identity) || explicit404s.has(identity)) continue;
    const difference = differences.get(identity);
    if (difference) { if (!audit.documentedAdaptations.some(row => row.id === difference.id)) audit.documentedAdaptations.push(difference); }
    else audit.unexplainedExtras.push({ method: route.method, path: route.path });
  }
  for (const row of [...snapshot.unconfiguredVerbCases, ...snapshot.notFoundProbes]) {
    if (router.match(row.method, row.sample) || router.match('OPTIONS', row.sample)) audit.unexpectedVerbChanges.push(row);
    else audit.negativeCasesCovered.push(row);
  }
  return audit;
}

export async function checkParity(): Promise<{ provenanceIssues: string[]; audit: RouteAudit }> {
  const snapshot = loadSnapshot();
  const services = createServices();
  try { return { provenanceIssues: validateSnapshot(snapshot), audit: auditRoutes(snapshot, createRouter(services)) }; }
  finally { await services.db.close(); await services.redis.close(); }
}

async function main(): Promise<void> {
  const result = await checkParity();
  const { audit } = result;
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Source-resolvable method/path pairs: ${audit.covered.length + audit.missing.length}; covered: ${audit.covered.length}; missing: ${audit.missing.length}\n`);
    process.stdout.write(`Source 404 declarations retained: ${audit.preserved404.length}; documented adaptations: ${audit.documentedAdaptations.length}; unexpected 404 changes: ${audit.unexpected404Changes.length}; unexplained extras: ${audit.unexplainedExtras.length}\n`);
    process.stdout.write(`Source 404 negative cases preserved: ${audit.negativeCasesCovered.length}; changed: ${audit.unexpectedVerbChanges.length}\n`);
    for (const issue of result.provenanceIssues) process.stderr.write(`PROVENANCE ${issue}\n`);
    for (const row of audit.missing) process.stderr.write(`MISSING ${row.method} ${row.path} <- ${row.yiiRoute} (${row.controller}:${row.actionLine || 1})\n`);
    for (const row of audit.unexpected404Changes) process.stderr.write(`CHANGED SOURCE 404 ${row.method} ${row.path}\n`);
    for (const row of audit.unexplainedExtras) process.stderr.write(`UNEXPLAINED EXTRA ${row.method} ${row.path}\n`);
    for (const row of audit.unexpectedVerbChanges) process.stderr.write(`CHANGED UNCONFIGURED METHOD ${row.method} ${row.path}\n`);
  }
  if (result.provenanceIssues.length || audit.missing.length || audit.unexpected404Changes.length || audit.unexplainedExtras.length || audit.unexpectedVerbChanges.length) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { process.stderr.write(`Route parity check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
