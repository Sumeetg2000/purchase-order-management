import { expect, test } from './support/test';
import { isWebKitSelectReport, type CspReport } from './support/csp';

// The reproduction behind support/csp.ts's one exception: a bare page with a CSP and a
// native <select>, no style attribute and no app code. WebKit reports style-src-attr
// against the <select>; Chromium and Firefox report nothing. When this fails, WebKit has
// stopped sending the report: remove the exception and this test.

const BARE_PAGE = `<!doctype html>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'unsafe-inline'; style-src 'self'">
<script>
  window.cspReports = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.cspReports.push({
      directive: event.effectiveDirective,
      blockedURI: event.blockedURI,
      target: event.target instanceof Element ? event.target.nodeName : '',
      sample: event.sample,
      source: event.sourceFile + ':' + event.lineNumber,
    });
  });
  addEventListener('DOMContentLoaded', () => {
    const select = document.createElement('select');
    for (const value of ['a', 'b']) select.append(new Option(value, value));
    document.body.append(select);
  });
</script>
<body></body>`;

test('[NFR-FE-05] WebKit still reports style-src-attr for a bare native <select>, which support/csp.ts excuses', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'the report is WebKit-only');
  await page.setContent(BARE_PAGE);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { cspReports: CspReport[] }).cspReports))
    .not.toEqual([]);
  const reports = await page.evaluate(
    () => (window as unknown as { cspReports: CspReport[] }).cspReports,
  );
  expect(reports.filter((report) => !isWebKitSelectReport(report, browserName))).toEqual([]);
  expect(await page.evaluate(() => document.querySelectorAll('[style]').length)).toBe(0);
});
