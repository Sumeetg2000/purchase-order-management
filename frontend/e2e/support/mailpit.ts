import { expect } from '@playwright/test';

// The test inbox (Mailpit, compose's `local` profile, ADR-0020): end-to-end tests read the
// emails the stack sends through its API.

const MAILPIT_URL = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

interface MailpitSearch {
  messages: { ID: string; To: { Address: string }[] }[];
}

/** The path and fragment of the newest link to `page` emailed to an address. */
export async function linkEmailedTo(address: string, page: string): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        const search = (await (
          await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`)
        ).json()) as MailpitSearch;
        const newest = search.messages[0];
        if (!newest) return undefined;
        const message = (await (
          await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)
        ).json()) as { Text: string };
        const link = new RegExp(`https?://\\S+${page}#token=[A-Za-z0-9_-]+`).exec(
          message.Text,
        )?.[0];
        if (link) {
          const url = new URL(link);
          found = `${url.pathname}${url.hash}`;
        }
        return found;
      },
      { message: `an email to ${address} with a ${page} link`, timeout: 15_000 },
    )
    .toBeDefined();
  return found ?? '';
}
