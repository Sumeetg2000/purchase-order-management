import type { ReactNode } from 'react';
import { classes } from '../styles/classes';
import css from './states.module.css';

const styles = classes(css, 'empty');

export interface EmptyProps {
  title: string;
  description: string;
  /** The next step, such as a button that creates the first item. */
  action?: ReactNode;
}

/** Says what's missing and, optionally, what to do about it. */
export function Empty({ title, description, action }: EmptyProps) {
  return (
    <section className={styles.empty}>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}
