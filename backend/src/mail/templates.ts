import {
  RESET_TOKEN_LIFETIME_MINUTES,
  VERIFY_EMAIL_TOKEN_LIFETIME_MINUTES,
} from '../tokens/one-time.js';
import { defineTemplate } from './template.js';

// The account emails (ADR-0017). Every variable reaches the HTML part escaped.

const VERIFY_HOURS = String(VERIFY_EMAIL_TOKEN_LIFETIME_MINUTES / 60);

export const verifyEmailTemplate = defineTemplate<{ name: string; link: string }>({
  name: 'verify_email',
  subject: () => 'Confirm your email address',
  text: ({ name, link }) =>
    [
      `Hello ${name},`,
      '',
      'Confirm your email address to finish signing up for Purchase Orders:',
      '',
      link,
      '',
      `The link works once and expires in ${VERIFY_HOURS} hours. If you didn't sign up, ignore this email.`,
    ].join('\n'),
  html: ({ name, link }) =>
    `<p>Hello ${name},</p>` +
    '<p>Confirm your email address to finish signing up for Purchase Orders:</p>' +
    `<p><a href="${link}">Confirm my email address</a></p>` +
    `<p>The link works once and expires in ${VERIFY_HOURS} hours. If you didn't sign up, ignore this email.</p>`,
});

const RESET_MINUTES = String(RESET_TOKEN_LIFETIME_MINUTES);

/** The reset email: sent by an admin, and by forgot-password. */
export const resetPasswordTemplate = defineTemplate<{ name: string; link: string }>({
  name: 'reset_password',
  subject: () => 'Reset your password',
  text: ({ name, link }) =>
    [
      `Hello ${name},`,
      '',
      'Choose a new password for Purchase Orders:',
      '',
      link,
      '',
      `The link works once and expires in ${RESET_MINUTES} minutes. Your current password keeps working until you use it. If you didn't ask for this, ignore this email.`,
    ].join('\n'),
  html: ({ name, link }) =>
    `<p>Hello ${name},</p>` +
    '<p>Choose a new password for Purchase Orders:</p>' +
    `<p><a href="${link}">Choose a new password</a></p>` +
    `<p>The link works once and expires in ${RESET_MINUTES} minutes. Your current password keeps working until you use it. If you didn't ask for this, ignore this email.</p>`,
});
