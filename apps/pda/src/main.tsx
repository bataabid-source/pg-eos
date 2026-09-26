// WBS 2.16 part 1a — app entry point.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/tokens.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('main.tsx: #root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
