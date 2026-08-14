import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { VectorizerPage } from './pages/VectorizerPage';
import './App.css';

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `version-nav__link${isActive ? ' version-nav__link--active' : ''}`;
}

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="version-nav">
          <span className="version-nav__brand">Image Vectorization</span>
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
        <div className="app-shell__body">
          <Routes>
            <Route path="/" element={<Navigate to="/v1" replace />} />
            <Route path="/v1" element={<VectorizerPage apiEndpoint="/api/vectorize" />} />
            <Route path="/v2" element={<VectorizerPage apiEndpoint="/api/v2/vectorize" />} />
            <Route path="/v3" element={<VectorizerPage apiEndpoint="/api/v3/vectorize" />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;
