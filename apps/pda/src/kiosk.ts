// WBS 2.16 part 1a — kiosk-mode utilities (brief Master decision 2).
//
// requestKioskFullscreen(): calls document.documentElement.requestFullscreen() — meant to be
// invoked from a user-gesture click handler (the "Enter kiosk mode" button in the app shell),
// NEVER auto-called on mount (most browsers reject requestFullscreen() outside a user gesture).
// The returned promise is caught (fix round 1, finding 4b): a browser that rejects the request
// (user-gesture requirements not met, permission denied, etc.) must not surface as an unhandled
// rejection — the button simply stays visible (registerFullscreenChange below governs that).
//
// registerContextMenuSuppression(): registers a `contextmenu` listener on `document` that calls
// preventDefault() (the minimum "shared industrial device" hardening doc 40 names). Returns an
// unregister function so the app shell's own effect can remove the SAME named handler on unmount
// (a named function, not an inline arrow, so removeEventListener genuinely detaches it).
//
// registerFullscreenChange() (fix round 1, finding 4a): the "Enter kiosk mode" button is a
// one-time action — registers a `fullscreenchange` listener on `document` and reports the current
// `document.fullscreenElement` state to the caller so the app shell can hide the button once
// fullscreen is active, and show it again if fullscreen is exited (e.g. Esc).

export function requestKioskFullscreen(): void {
  document.documentElement.requestFullscreen().catch(() => {
    // Rejected fullscreen request (no user gesture recognised, permission denied, etc.) — the
    // "Enter kiosk mode" button simply stays visible; nothing else to recover here.
  });
}

function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
}

export function registerContextMenuSuppression(): () => void {
  document.addEventListener('contextmenu', handleContextMenu);
  return () => {
    document.removeEventListener('contextmenu', handleContextMenu);
  };
}

export function isFullscreenActive(): boolean {
  // `!= null` (not `!== null`) deliberately: some environments (jsdom, older Safari) report an
  // absent fullscreen element as `undefined` rather than `null` — both mean "not fullscreen".
  return document.fullscreenElement != null;
}

export function registerFullscreenChange(onChange: (active: boolean) => void): () => void {
  function handleFullscreenChange(): void {
    onChange(isFullscreenActive());
  }
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  return () => {
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
  };
}
