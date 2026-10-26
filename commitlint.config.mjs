// Conventional Commits (constitution: Development Workflow), plus the requirement-ID ban
// for subjects (ADR-0013).
import requirementIds from './scripts/commitlint-plugin-requirement-ids.mjs';

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [requirementIds],
  rules: {
    'subject-no-requirement-ids': [2, 'always'],
  },
};
