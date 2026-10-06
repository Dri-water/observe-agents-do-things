import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ObserverProvider } from '@oadt/react'
import { App } from './App'
import './style.css'

// Same-origin by default (served by `oadt --ui …` or the Vite proxy).
// Point elsewhere with ?api=http://host:4545 and pass ?token= if the server needs one.
const params = new URLSearchParams(location.search)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ObserverProvider url={params.get('api') ?? ''} token={params.get('token') ?? undefined}>
      <App />
    </ObserverProvider>
  </StrictMode>,
)
