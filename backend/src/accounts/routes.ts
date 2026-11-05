import {
  OPERATIONS,
  type EmailBody,
  type ResetPasswordBody,
  type SignupBody,
  type VerifyEmailBody,
} from '@po/contracts';
import { defineRoute, type RouteDefinition } from '../http/define-route.js';
import { requestContext } from '../http/request-context.js';
import type { AccountsService } from './service.js';

export function accountsRoutes(accounts: AccountsService): RouteDefinition[] {
  return [
    defineRoute({
      ...OPERATIONS.signup,
      handler: async (req, res) => {
        await accounts.signup(req.body as SignupBody, requestContext(req, res));
        res.status(202).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.verifyEmail,
      handler: async (req, res) => {
        await accounts.verifyEmail(req.body as VerifyEmailBody, requestContext(req, res));
        res.status(204).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.resendVerification,
      handler: async (req, res) => {
        await accounts.resendVerification(req.body as EmailBody, requestContext(req, res));
        res.status(202).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.forgotPassword,
      handler: async (req, res) => {
        await accounts.forgotPassword(req.body as EmailBody, requestContext(req, res));
        res.status(202).end();
      },
    }),
    defineRoute({
      ...OPERATIONS.resetPassword,
      handler: async (req, res) => {
        await accounts.resetPassword(req.body as ResetPasswordBody, requestContext(req, res));
        res.status(204).end();
      },
    }),
  ];
}
