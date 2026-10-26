// commitlint rule: no requirement or task IDs in a commit subject (ADR-0013). The body may
// carry them, and so may PR descriptions.
import { bannedIds } from './lib/requirement-ids.mjs';

export default {
  rules: {
    'subject-no-requirement-ids': ({ subject }) => {
      const found = bannedIds(subject ?? '').map((id) => id.match);
      return [
        found.length === 0,
        `subject must not carry requirement or task IDs (found ${found.join(', ')}); put them in the body`,
      ];
    },
  },
};
