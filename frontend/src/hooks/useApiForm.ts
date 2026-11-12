import { useRef, useState } from 'react';
import { fieldFailure, submit, type ApiFailure, type ApiOutcome } from '../api/submit';

type ApiCall<T> = () => Promise<{ data?: T; error?: unknown; response: Response }>;

export interface SendOptions {
  /** Keeps the failure on show while this call runs (a follow-up offered by that failure). */
  keepFailure?: boolean;
}

export interface ApiForm {
  /** True while a call runs: the submit button is disabled. */
  pending: boolean;
  /** The last call's failure, until the next call or clearFailure. */
  failure: ApiFailure | undefined;
  /**
   * Sends one call: undefined, without calling, while another is still running (a double
   * click), otherwise its outcome. A failure is kept in `failure`.
   */
  send: <T>(call: ApiCall<T>, options?: SendOptions) => Promise<ApiOutcome<T> | undefined>;
  clearFailure: () => void;
  /** The message for a field's own error, if the failure names that field. */
  fieldError: (path: string) => string | undefined;
}

/**
 * One way for a form to call the API (ADR-0018): pending state, no double submit, and the
 * failure kept for the page to show.
 */
export function useApiForm(): ApiForm {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure>();
  // The state update lands after the event, so a ref stops a second press of a double
  // click from sending again.
  const sending = useRef(false);

  async function send<T>(
    call: ApiCall<T>,
    { keepFailure = false }: SendOptions = {},
  ): Promise<ApiOutcome<T> | undefined> {
    if (sending.current) return undefined;
    sending.current = true;
    setPending(true);
    if (!keepFailure) setFailure(undefined);
    try {
      const outcome = await submit(call);
      if (!outcome.ok) setFailure(outcome);
      return outcome;
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return {
    pending,
    failure,
    send,
    clearFailure: () => {
      setFailure(undefined);
    },
    fieldError: (path) => (failure ? fieldFailure(failure, path) : undefined),
  };
}
