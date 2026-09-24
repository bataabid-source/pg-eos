// WBS 0.19 — app root: mounts the router. The nav shell (app name + "Decision Inbox" nav item,
// `aria-current` on the active route — fix round 1, finding 5) is colocated in router.tsx as the
// root route's own component, since it needs the router context (`Link`'s active-match state) —
// keeping it here would create a circular import between App.tsx and router.tsx.
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from './router';

const router = createRouter();

export function App() {
  return <RouterProvider router={router} />;
}
