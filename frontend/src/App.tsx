import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { VectorizerPage } from './pages/VectorizerPage';
import { Toaster } from './components/ui/sonner';
import { cn } from './lib/utils';
import './App.css';

function navLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'rounded-md px-3 py-1.5 text-sm text-muted-foreground no-underline',
    isActive ? 'bg-primary text-primary-foreground' : 'hover:text-foreground',
  );
}

function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col">
        <nav className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-card px-4">
          <span className="mr-3 text-sm font-semibold tracking-wide text-muted-foreground">Image Vectorization</span>
          <NavLink to="/v1" className={navLinkClass}>
            v1 (vtracer)
          </NavLink>
          {/* <NavLink to="/v2" className={navLinkClass}>
            v2 (custom pipeline)
          </NavLink> */}
          <NavLink to="/v3" className={navLinkClass}>
            v3 (preprocess + vtracer)
          </NavLink>
        </nav>
        <div className="flex min-h-0 flex-1 *:flex-1 *:min-h-0">
          <Routes>
            <Route path="/" element={<Navigate to="/v1" replace />} />
            <Route path="/v1" element={<VectorizerPage apiEndpoint="/api/vectorize" />} />
            <Route path="/v2" element={<VectorizerPage apiEndpoint="/api/v2/vectorize" />} />
            <Route path="/v3" element={<VectorizerPage apiEndpoint="/api/v3/vectorize" />} />
          </Routes>
        </div>
      </div>
      <Toaster />
    </BrowserRouter>
  );
}

export default App;
