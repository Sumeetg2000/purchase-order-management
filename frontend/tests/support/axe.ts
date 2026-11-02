import axe from 'axe-core';

/**
 * The accessibility violations axe-core finds in an element (WCAG 2.1 A and AA rules), as
 * "rule-id: help (n nodes)" lines, so a failing test names what is wrong.
 */
export async function axeViolations(element: Element): Promise<string[]> {
  const results = await axe.run(element, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return results.violations.map((v) => `${v.id}: ${v.help} (${String(v.nodes.length)} node(s))`);
}
