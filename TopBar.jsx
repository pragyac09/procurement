import React, { useState } from 'react';
import { RotateCcw, AlertTriangle } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const getTitleFromPath = (path) => {
  switch (path) {
    case '/storefront':
      return 'Storefront';
    case '/':
      return 'Inventory Catalog';
    case '/orders':
      return 'Proposed Orders';
    case '/decisions':
      return 'Decision Log';
    case '/revenue':
      return 'Supplier Revenue';
    default:
      return 'Dashboard';
  }
};

const TopBar = () => {
  const location = useLocation();
  const title = getTitleFromPath(location.pathname);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleOpenModal = (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    setShowConfirmModal(true);
  };

  const handleCloseModal = (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (!isResetting) {
      setShowConfirmModal(false);
    }
  };

  const handleConfirmReset = async (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    setIsResetting(true);
    try {
      const response = await fetch('/api/reset', { method: 'POST' });
      if (response.ok) {
        window.location.reload();
      } else {
        alert('Failed to reset demo data');
        setIsResetting(false);
        setShowConfirmModal(false);
      }
    } catch (err) {
      console.error(err);
      alert('Error resetting demo data');
      setIsResetting(false);
      setShowConfirmModal(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <h2 className="topbar-title">{title}</h2>
        <button className="btn-outline" onClick={handleOpenModal}>
          <RotateCcw size={14} />
          Reset Demo Data
        </button>
      </header>

      {showConfirmModal && (
        <div 
          className="modal-backdrop"
          onClick={handleCloseModal}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999
          }}
        >
          <div 
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface, #1e293b)',
              border: '1px solid var(--border, #334155)',
              borderRadius: '12px',
              padding: '1.75rem',
              maxWidth: '440px',
              width: '90%',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              color: 'var(--text-primary, #f8fafc)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', color: '#f59e0b' }}>
              <AlertTriangle size={24} />
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '600' }}>Confirm Reset Demo Data</h3>
            </div>
            
            <p style={{ margin: '0 0 1.5rem 0', color: 'var(--text-secondary, #94a3b8)', fontSize: '0.95rem', lineHeight: '1.5' }}>
              Are you sure you want to reset all demo data? This will clear all orders and reset inventory.
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                className="btn-outline"
                disabled={isResetting}
                onClick={handleCloseModal}
                style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={isResetting}
                onClick={handleConfirmReset}
                style={{ 
                  padding: '0.5rem 1rem', 
                  backgroundColor: '#ef4444', 
                  borderColor: '#dc2626', 
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontWeight: '600' 
                }}
              >
                {isResetting ? 'Resetting...' : 'Yes, Reset Demo Data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default TopBar;
