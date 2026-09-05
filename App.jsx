import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Storefront from './components/Storefront';
import ProductCatalog from './components/ProductCatalog';
import ProposedOrders from './components/ProposedOrders';
import DecisionLog from './components/DecisionLog';
import SupplierRevenue from './components/SupplierRevenue';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("React ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', margin: '2rem' }}>
          <h2 style={{ color: 'var(--status-danger-text)' }}>Something went wrong.</h2>
          <p style={{ color: 'var(--text-secondary)' }}>{this.state.error?.message || 'An unexpected rendering error occurred.'}</p>
          <button className="btn-primary" onClick={() => window.location.reload()}>Reload Page</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/storefront" element={<Storefront />} />
            <Route path="/" element={<ProductCatalog />} />
            <Route path="/orders" element={<ProposedOrders />} />
            <Route path="/proposed-orders" element={<ProposedOrders />} />
            <Route path="/decisions" element={<DecisionLog />} />
            <Route path="/revenue" element={<SupplierRevenue />} />
            <Route path="*" element={<Navigate to="/storefront" replace />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
