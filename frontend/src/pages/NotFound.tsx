import { Link } from 'react-router';

export function NotFound() {
  return (
    <>
      <title>Page not found · Purchase Orders</title>
      <h1>Page not found</h1>
      <p>There is no page at this address. It may have moved, or the link may be wrong.</p>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
