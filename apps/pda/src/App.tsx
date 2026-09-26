// WBS 2.16 part 1a — app root: mounts the router. The shell (app name, kiosk-mode button,
// context-menu suppression, dir attribute) is colocated in router.tsx as the root route's own
// component, since it needs the router context — same precedent as apps/admin's own App.tsx.
import { RouterProvider } from '@tanstack/react-router';

import { createRouter } from './router';

const router = createRouter();

export function App() {
  return <RouterProvider router={router} />;
}
