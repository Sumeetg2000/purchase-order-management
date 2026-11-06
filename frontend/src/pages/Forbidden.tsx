import { Link } from 'react-router';

/** A page for a role the user doesn't hold. It only hides: the API refuses anyway. */
export function Forbidden() {
  return (
    <>
      <title>No access · Purchase Orders</title>
      <h1>You don&apos;t have access to this page</h1>
      <p>Your role doesn&apos;t include this page. Ask an administrator if you need it.</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
