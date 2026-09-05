import React, { useState, useEffect } from 'react';
import './ProductCatalog.css';
import { formatCurrency } from '../utils/currency';

const ProductCatalog = () => {
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedBatches, setExpandedBatches] = useState({});
  const [showAddModal, setShowAddModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addSuccess, setAddSuccess] = useState(null);
  const [newProduct, setNewProduct] = useState({
    name: '',
    category: '',
    unit_price: '',
    moq: '',
    lead_time_days: '',
    shelf_life_days: '',
    supplier_id: '1'
  });

  const fetchProducts = async () => {
    try {
      const response = await fetch('/api/products');
      if (!response.ok) {
        throw new Error('Failed to fetch products');
      }
      const data = await response.json();
      setProducts(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const response = await fetch('/api/suppliers');
      if (response.ok) {
        const data = await response.json();
        setSuppliers(data);
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchProducts();
    fetchSuppliers();
  }, []);

  const handleAddProductSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // In-flight request guard to prevent double-click submissions
    setIsSubmitting(true);
    setAddError(null);
    setAddSuccess(null);

    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProduct)
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || 'Failed to add product.');
      } else {
        setAddSuccess(`✓ Product "${data.product.name}" created successfully!`);
        await fetchProducts();
        setTimeout(() => {
          setShowAddModal(false);
          setAddSuccess(null);
          setNewProduct({
            name: '',
            category: '',
            unit_price: '',
            moq: '',
            lead_time_days: '',
            shelf_life_days: '',
            supplier_id: '1'
          });
        }, 1000);
      }
    } catch (err) {
      setAddError(err.message || 'Network error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return <div className="loading">Loading catalog...</div>;
  }

  if (error) {
    return <div className="error">Error loading catalog: {error}</div>;
  }

  // Determine non-perishable group FIRST to prevent false substring matches on "PERISHABLE"
  const isNonPerishable = (product) => {
    const cat = (product.category || '').toUpperCase();
    if (cat.includes('NON-PERISHABLE')) {
      return true;
    }
    if (cat.includes('PERISHABLE')) {
      return false;
    }
    // Fallback: shelf_life_days <= 7 is perishable
    return (product.shelf_life_days || 365) > 7;
  };

  const perishableProducts = products.filter(p => !isNonPerishable(p));
  const nonPerishableProducts = products.filter(p => isNonPerishable(p));

  const toggleBatches = (productId) => {
    setExpandedBatches(prev => ({ ...prev, [productId]: !prev[productId] }));
  };

  const renderProductRow = (product) => {
    // Timezone & Expiry Policy Convention:
    // 'todayStr' must strictly use Asia/Kolkata (IST) timezone.
    // A batch is sellable through the end of its expiry_date, and only counted as expired starting the following day (expiry_date < todayStr, NOT <=).
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const isExpired = product.expiry_date && product.expiry_date < todayStr;
    
    const shelfLifeDays = product.shelf_life_days || 365;
    const expiringSoonThresholdDays = Math.max(1, Math.ceil(shelfLifeDays * 0.3));

    let isExpiringSoon = false;
    if (product.expiry_date && !isExpired) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const exp = new Date(product.expiry_date);
      exp.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays <= expiringSoonThresholdDays) {
        isExpiringSoon = true;
      }
    }

    const isLowStock = product.dark_store_stock <= product.reorder_point;
    const activeBatches = product.batches || [];
    const isExpanded = expandedBatches[product.id];

    return (
      <React.Fragment key={product.id}>
        <tr>
          <td className="text-tertiary">#{product.id}</td>
          <td className="font-medium">
            <div>{product.name}</div>
            {activeBatches.length > 0 && (
              <button
                onClick={() => toggleBatches(product.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent)',
                  fontSize: '0.75rem',
                  fontWeight: '500',
                  cursor: 'pointer',
                  padding: 0,
                  marginTop: '2px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                {isExpanded ? `▼ Hide batches (${activeBatches.length})` : `▶ View batches (${activeBatches.length})`}
              </button>
            )}
          </td>
          <td>
            <span className="badge badge-neutral">{product.category}</span>
          </td>
          <td>{product.supplier_name}</td>
          <td className="text-right">{formatCurrency(product.unit_price)}</td>
          <td className="text-right">{product.shelf_life_days ? `${product.shelf_life_days} days` : 'N/A'}</td>
          <td className="text-right text-tertiary">{product.expiry_date || 'N/A'}</td>
          <td className="text-right font-medium">{product.dark_store_stock}</td>
          <td className="text-right text-tertiary">{product.reorder_point}</td>
          <td className="text-center">
            {isExpired ? (
              <span className="badge badge-danger">EXPIRED</span>
            ) : isExpiringSoon ? (
              <span className="badge badge-warning">Expiring Soon</span>
            ) : isLowStock ? (
              <span className="badge badge-danger">LOW STOCK</span>
            ) : (
              <span className="badge badge-success">OPTIMAL</span>
            )}
          </td>
        </tr>
        {isExpanded && (
          <tr key={`batches-${product.id}`} style={{ background: 'var(--bg-surface)' }}>
            <td colSpan="10" style={{ padding: '0.75rem 1.25rem 1rem 2.5rem', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                Active Inventory Batches for {product.name}:
              </div>
              <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-tertiary)' }}>
                    <th style={{ padding: '4px 8px' }}>Batch ID</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Quantity</th>
                    <th style={{ padding: '4px 8px' }}>Received Date</th>
                    <th style={{ padding: '4px 8px' }}>Expiry Date</th>
                    <th style={{ padding: '4px 8px', textAlign: 'center' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activeBatches.length === 0 ? (
                    <tr>
                      <td colSpan="5" style={{ padding: '8px', color: 'var(--text-tertiary)' }}>No active batches found.</td>
                    </tr>
                  ) : (
                    activeBatches.map(b => (
                      <tr key={b.id} style={{ borderBottom: '1px dashed var(--border)' }}>
                        <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>Batch #{b.id}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: '600' }}>{b.quantity} units</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-tertiary)' }}>{b.received_date}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-tertiary)' }}>{b.expiry_date}</td>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          {b.status === 'EXPIRED' ? (
                            <span className="badge badge-danger" style={{ fontSize: '0.7rem' }}>EXPIRED</span>
                          ) : b.status === 'Expiring Soon' ? (
                            <span className="badge badge-warning" style={{ fontSize: '0.7rem' }}>Expiring Soon</span>
                          ) : (
                            <span className="badge badge-success" style={{ fontSize: '0.7rem' }}>Fresh</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="catalog-container">
      {/* Top Bar with Add Product Action */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: '700', margin: 0, color: 'var(--text-primary)' }}>Dark Store Inventory Catalog</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', margin: '4px 0 0 0' }}>
            Live stock levels, FEFO batch tracking, and automated reorder points across catalog items.
          </p>
        </div>
        <button
          className="btn-add-product"
          onClick={() => { setShowAddModal(true); setAddError(null); setAddSuccess(null); }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            padding: '8px 16px',
            fontSize: '0.85rem',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: 'var(--shadow-sm)'
          }}
        >
          ＋ Add New Product
        </button>
      </div>

      {/* Section 1: Perishable Products */}
      <div className="catalog-section" style={{ marginBottom: '2.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.85rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '700', margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            🥬 Perishable Products
          </h3>
          <span className="badge badge-warning" style={{ fontSize: '0.75rem' }}>
            {perishableProducts.length} Items (Short Shelf-Life)
          </span>
        </div>

        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Product Name</th>
                <th>Category</th>
                <th>Supplier</th>
                <th className="text-right">Unit Price</th>
                <th className="text-right">Shelf Life</th>
                <th className="text-right">Expiry Date</th>
                <th className="text-right">Stock</th>
                <th className="text-right">Reorder Pt</th>
                <th className="text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {perishableProducts.length === 0 ? (
                <tr>
                  <td colSpan="10" style={{ textAlign: 'center' }}>No perishable products found.</td>
                </tr>
              ) : (
                perishableProducts.map(renderProductRow)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2: Non-Perishable Products */}
      <div className="catalog-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.85rem' }}>
          <h3 style={{ fontSize: '1.15rem', fontWeight: '700', margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            📦 Non-Perishable Products
          </h3>
          <span className="badge badge-neutral" style={{ fontSize: '0.75rem' }}>
            {nonPerishableProducts.length} Items (Extended Shelf-Life)
          </span>
        </div>

        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Product Name</th>
                <th>Category</th>
                <th>Supplier</th>
                <th className="text-right">Unit Price</th>
                <th className="text-right">Shelf Life</th>
                <th className="text-right">Expiry Date</th>
                <th className="text-right">Stock</th>
                <th className="text-right">Reorder Pt</th>
                <th className="text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {nonPerishableProducts.length === 0 ? (
                <tr>
                  <td colSpan="10" style={{ textAlign: 'center' }}>No non-perishable products found.</td>
                </tr>
              ) : (
                nonPerishableProducts.map(renderProductRow)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Demo Disclaimer Footer */}
      <div style={{
        marginTop: '2.5rem',
        marginBottom: '1rem',
        textAlign: 'center',
        fontSize: '0.75rem',
        color: 'var(--text-tertiary)',
        opacity: 0.8
      }}>
        Supplier names are used as realistic placeholders for demo purposes only. No real integration, data, or endorsement from these companies is implied.
      </div>

      {/* Add Product Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => !isSubmitting && setShowAddModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: '700', color: 'var(--text-primary)' }}>
                ＋ Add New Catalog Product
              </h3>
              <button
                type="button"
                onClick={() => !isSubmitting && setShowAddModal(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-tertiary)' }}
                disabled={isSubmitting}
              >
                ✕
              </button>
            </div>

            {addError && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid var(--status-danger-border)',
                color: 'var(--status-danger-text)',
                padding: '10px 12px',
                borderRadius: '6px',
                fontSize: '0.85rem',
                marginBottom: '1rem'
              }}>
                ⚠️ {addError}
              </div>
            )}

            {addSuccess && (
              <div style={{
                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                color: '#16a34a',
                padding: '10px 12px',
                borderRadius: '6px',
                fontSize: '0.85rem',
                marginBottom: '1rem'
              }}>
                {addSuccess}
              </div>
            )}

            <form onSubmit={handleAddProductSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Product Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Organic Matcha 50g"
                  value={newProduct.name}
                  onChange={e => setNewProduct({ ...newProduct, name: e.target.value })}
                  disabled={isSubmitting}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Category (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Beverages"
                    value={newProduct.category}
                    onChange={e => setNewProduct({ ...newProduct, category: e.target.value })}
                    disabled={isSubmitting}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Supplier
                  </label>
                  <select
                    value={newProduct.supplier_id}
                    onChange={e => setNewProduct({ ...newProduct, supplier_id: e.target.value })}
                    disabled={isSubmitting}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                  >
                    {suppliers.length === 0 ? (
                      <option value="1">Acme FMCG Wholesale</option>
                    ) : (
                      suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                    )}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Unit Price (₹)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    placeholder="50.00"
                    value={newProduct.unit_price}
                    onChange={e => setNewProduct({ ...newProduct, unit_price: e.target.value })}
                    disabled={isSubmitting}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    MOQ (units)
                  </label>
                  <input
                    type="number"
                    min="1"
                    placeholder="10"
                    value={newProduct.moq}
                    onChange={e => setNewProduct({ ...newProduct, moq: e.target.value })}
                    disabled={isSubmitting}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Lead Time (days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    placeholder="2"
                    value={newProduct.lead_time_days}
                    onChange={e => setNewProduct({ ...newProduct, lead_time_days: e.target.value })}
                    disabled={isSubmitting}
                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Shelf Life (Days, Optional)
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="e.g. 365 or leave blank for cold-start test"
                  value={newProduct.shelf_life_days}
                  onChange={e => setNewProduct({ ...newProduct, shelf_life_days: e.target.value })}
                  disabled={isSubmitting}
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', fontSize: '0.85rem' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  disabled={isSubmitting}
                  style={{ padding: '8px 14px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '6px',
                    border: 'none',
                    background: isSubmitting ? 'var(--text-tertiary)' : 'var(--accent)',
                    color: '#fff',
                    fontWeight: '600',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    fontSize: '0.85rem',
                    opacity: isSubmitting ? 0.7 : 1
                  }}
                >
                  {isSubmitting ? 'Adding Product...' : 'Add Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductCatalog;
