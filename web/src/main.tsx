import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import { Root } from './App';
import './components/InstallApp'; // capture the install prompt before any screen mounts

registerSW({ immediate: true });
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
document.getElementById('splash')?.remove();
