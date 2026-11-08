import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { FlowOverlay } from './features/flow/Overlay.tsx'
import './styles.css'

// The Flow nudge overlay is a second, frameless window loading the same bundle at #flow-overlay.
createRoot(document.getElementById('root')!).render(location.hash === '#flow-overlay' ? <FlowOverlay /> : <App />)
