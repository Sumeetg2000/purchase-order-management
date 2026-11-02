// commitlint rule: no requirement or task IDs in a commit subject (ADR-0013), meaning the
// whole header line, scope included. The body may carry them, and so may PR descriptions.
import { bannedIds } from './lib/requirement-ids.mjs';

export default {
  rules: {
    'subject-no-requirement-ids': ({ header }) => {
      const found = bannedIds(header ?? '').map((id) => id.match);
      return [
        found.length === 0,
        `subject must not carry requirement or task IDs (found ${found.join(', ')}); put them in the body`,
      ];
    },
  },
};
