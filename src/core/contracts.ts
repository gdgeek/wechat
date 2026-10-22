import type { Request, Response } from 'express';
import type { Database } from './database';
import type { LegacyRedis } from './redis';
import type { AuthService } from './auth';
import type { SceneCatalog } from '../admin/scenes';
import type { Integrations } from '../integrations/integrations';

// SQL/Redis records have schemas defined by the existing game database.
export type Row = Record<string, any>;
export interface Context {
  req: Request;
  res: Response;
  body: Row;
  query: Row;
  params: Record<string, string>;
}
export interface Services {
  db: Database;
  redis: LegacyRedis;
  adminAuthRedis?: LegacyRedis;
  auth: AuthService;
  catalog: SceneCatalog;
  integrations: Integrations;
}
export type Handler = (context: Context) => unknown | Promise<unknown>;
export interface Route { method: string; path: string; handler: Handler; }
