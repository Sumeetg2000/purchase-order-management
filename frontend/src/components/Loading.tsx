import { classes } from '../styles/classes';
import css from './states.module.css';

const styles = classes(css, 'loading', 'spinner');

/** An accessible busy indicator for a page or section that is loading. */
export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.loading}>
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </div>
  );
}
