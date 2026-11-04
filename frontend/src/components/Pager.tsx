import { classes } from '../styles/classes';
import controlsCss from '../styles/controls.module.css';
import css from './Pager.module.css';

const styles = classes(css, 'pager');
const controls = classes(controlsCss, 'button');

export interface PagerProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}

/** Previous and next for a paged list (ADR-0007's envelope). Hidden when one page holds all. */
export function Pager({ page, pageSize, total, onPage }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1 && page === 1) return null;
  return (
    <nav aria-label="Pages" className={styles.pager}>
      <button
        type="button"
        className={controls.button}
        disabled={page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        Previous page
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className={controls.button}
        disabled={page >= pages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        Next page
      </button>
    </nav>
  );
}
