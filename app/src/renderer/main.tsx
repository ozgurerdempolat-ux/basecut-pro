import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);

// test/automation hook (also handy from DevTools)
import * as store from './store';
import { player } from './player';
import * as ops from '../core/ops';
(window as unknown as { __kurgu: unknown }).__kurgu = { store, player, ops };
