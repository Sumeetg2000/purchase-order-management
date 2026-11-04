// The forgot-password page's address and what a link to it may carry, kept apart from the
// page so linking to it doesn't load its chunk.

export const FORGOT_PASSWORD_PATH = '/forgot-password';

/** Navigation state for the forgot-password page. */
export interface ForgotPasswordState {
  /** The email the user already typed (on the login page), to start with. */
  email?: string;
}
