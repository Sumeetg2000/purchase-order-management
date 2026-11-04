import { describe, expect, it } from 'vitest';
import {
  logSecurityEvent,
  SECURITY_EVENTS,
  SECURITY_FIELDS,
} from '../../src/observability/security-log.js';
import { createCapture } from '../support/log-capture.js';

// Security events (ADR-0017, research R18): structured lines marked security: true,
// separate from the audit, carrying only allow-listed fields.

describe('[NFR-SEC-06] security log', () => {
  it('[NFR-SEC-06] names the slice 1 account events alongside the mail ones', () => {
    expect([...SECURITY_EVENTS]).toEqual([
      'mail_send_failed',
      'mail_send_abandoned',
      'signup',
      'email_verified',
      'login_succeeded',
      'login_failed',
      'account_locked',
      'logout',
      'logout_all',
      'refresh_reuse_detected',
      'session_revoked',
      'password_reset_requested',
      'password_reset_completed',
      'password_changed',
      'password_change_failed',
    ]);
  });

  it('[NFR-SEC-06] writes a security line with the event and its allowed fields', () => {
    const capture = createCapture();
    logSecurityEvent(capture.logger, 'login_failed', {
      userId: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f',
      ip: '10.0.0.1',
      userAgent: 'agent',
      reason: 'wrong_password',
    });
    expect(capture.lines).toEqual([
      expect.objectContaining({
        security: true,
        event: 'login_failed',
        userId: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f',
        ip: '10.0.0.1',
        userAgent: 'agent',
        reason: 'wrong_password',
      }),
    ]);
  });

  it('[NFR-SEC-06] the allow-list holds no secret, token, password or address field', () => {
    for (const field of SECURITY_FIELDS) {
      expect(field).not.toMatch(/password|token|secret|cookie|email|phone|to$|recipient/i);
    }
  });

  it('[NFR-SEC-06] drops any field outside the allow-list, whatever the caller passes', () => {
    const capture = createCapture();
    const smuggled = {
      userId: 'u1',
      password: 'correct horse battery',
      refreshToken: 'secret-token',
      email: 'someone@example.local',
      to: 'someone@example.local',
    };
    logSecurityEvent(capture.logger, 'login_failed', smuggled);
    const [line] = capture.lines;
    expect(line).toMatchObject({ userId: 'u1' });
    for (const key of ['password', 'refreshToken', 'email', 'to']) {
      expect(line, key).not.toHaveProperty(key);
    }
  });

  it('[NFR-SEC-06] logs failures as warnings and ordinary events as info', () => {
    const capture = createCapture();
    logSecurityEvent(capture.logger, 'login_succeeded', { userId: 'u1' });
    logSecurityEvent(capture.logger, 'refresh_reuse_detected', { sessionId: 's1' });
    expect(capture.lines.map((line) => [line['event'], line['level']])).toEqual([
      ['login_succeeded', 30],
      ['refresh_reuse_detected', 40],
    ]);
  });
});
