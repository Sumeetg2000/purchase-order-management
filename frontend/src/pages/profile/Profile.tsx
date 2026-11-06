import { DetailsSection } from './DetailsSection';
import { PasswordSection } from './PasswordSection';
import { SessionsSection } from './SessionsSection';
import { classes } from '../../styles/classes';
import css from './profile.module.css';

const styles = classes(css, 'page');

/**
 * Profile (ADR-0018): every user, with or without a role, edits their name, changes their
 * password and manages where they're logged in.
 */
export function Profile() {
  return (
    <>
      <title>Profile · Purchase Orders</title>
      <h1>Profile</h1>
      <div className={styles.page}>
        <DetailsSection />
        <PasswordSection />
        <SessionsSection />
      </div>
    </>
  );
}
