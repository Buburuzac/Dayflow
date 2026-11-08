import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

async function start() {
  // Dev-only mock API (`?mock=1`). `import.meta.env.DEV` is false in `vite build`, so this branch
  // and the mock module are dropped from the production bundle.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock')) {
    const { installMock } = await import('./mock/mock.ts')
    installMock(new URLSearchParams(window.location.search).get('mock') ?? '1')
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
