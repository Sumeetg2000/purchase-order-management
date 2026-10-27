import { describe, expect, it } from 'vitest';
import css from '../src/components/states.module.css';
import { classes } from '../src/styles/classes';

// Component tests see real CSS modules, so a class name the stylesheet doesn't define
// fails here instead of blank-screening the production build.
describe('[NFR-FE-04] CSS module classes', () => {
  it('[NFR-FE-04] returns the classes a stylesheet defines', () => {
    expect(classes(css, 'loading', 'spinner').loading).toMatch(/loading/);
  });

  it('[NFR-FE-04] throws on a class the stylesheet does not define', () => {
    expect(() => classes(css, 'lodaing')).toThrow(/lodaing/);
  });
});
