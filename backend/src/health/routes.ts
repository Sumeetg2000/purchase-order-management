import { AppError, OPERATIONS } from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { sendProblem } from '../http/problem.js';
import type { ReadinessService } from './service.js';

export function healthRoutes(readiness: ReadinessService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.getHealth,
      handler: (_req, res) => {
        res.json({ status: 'ok' });
      },
    }),
    defineRoute({
      ...OPERATIONS.getReadiness,
      handler: async (_req, res) => {
        const notReady = await readiness.check();
        if (notReady) {
          sendProblem(
            res,
            new AppError('SERVICE_UNAVAILABLE', {
              detail:
                notReady === 'database'
                  ? 'The database is not reachable.'
                  : 'Migrations are not complete.',
            }),
          );
          return;
        }
        res.json({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
      },
    }),
  ];
}
