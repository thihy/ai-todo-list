// Pet window entry — mounts <Pet /> into #root.

import { createRoot } from 'react-dom/client';
import { Pet } from './components/Pet';

const container = document.getElementById('root');
if (container) createRoot(container).render(<Pet />);