import 'dotenv/config';
import { createApplication, createServices } from './application';

async function main(): Promise<void> {
  const services = createServices();
  const app = await createApplication(services);
  const shutdown = async () => { await app.close(); await Promise.allSettled([services.db.close(), services.redis.close()]); };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  await app.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0');
}
void main().catch(() => { console.error('Failed to start game backend. Check configuration.'); process.exitCode = 1; });
