import { expect, type Page } from '@playwright/test';

// CSP checks for the end-to-end tests. Every violation fires securitypolicyviolation, even
// one the page's code catches (a library probing eval, say), in every engine; console
// messages vary by engine.
//
// One exception, and only this one: WebKit reports style-src-attr against a native
// <select> for its own rendering of the control, with no style attribute anywhere on the
// page and nothing blocked. webkit-canary.spec.ts reproduces it on a bare page and fails
// once WebKit stops sending it, so the exception can go (ADR-0017 "Deployment").

export interface CspReport {
  directive: string;
  blockedURI: string;
  target: string;
  sample: string;
  source: string;
}

/** WebKit's report for a native <select>, which the page didn't cause. */
export function isWebKitSelectReport(report: CspReport, engine: string | undefined): boolean {
  return (
    engine === 'webkit' &&
    report.directive === 'style-src-attr' &&
    report.target === 'SELECT' &&
    report.sample === ''
  );
}

function describe(report: CspReport): string {
  return `${report.directive} blocked ${report.blockedURI} on ${report.target} (${report.source})`;
}

/**
 * Starts recording CSP reports on every document the page loads. The reader returns the
 * current document's reports, except WebKit's <select> report, which is excused only while
 * no element on the page has a style attribute (asserted).
 */
export async function recordCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    (window as unknown as { cspReports: unknown[] }).cspReports = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        target: event.target instanceof Element ? event.target.nodeName : '',
        sample: event.sample,
        source: `${event.sourceFile}:${String(event.lineNumber)}`,
      });
    });
  });
  return async () => {
    const { reports, styled } = await page.evaluate(() => ({
      reports: (window as unknown as { cspReports: CspReport[] }).cspReports,
      styled: document.querySelectorAll('[style]').length,
    }));
    const engine = page.context().browser()?.browserType().name();
    const excused = reports.filter((report) => isWebKitSelectReport(report, engine));
    if (excused.length > 0) {
      expect(styled, "elements with a style attribute beside WebKit's <select> report").toBe(0);
    }
    return reports.filter((report) => !excused.includes(report)).map(describe);
  };
}
