import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (bundled by Vite) so the Cozy Workshop theme renders
// correctly offline — no external font request. See ADR-0003.
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/hanken-grotesk/700.css';
import '@fontsource/spline-sans-mono/400.css';
import '@fontsource/spline-sans-mono/600.css';
import './cozy.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
