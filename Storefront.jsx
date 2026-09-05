import React, { useState, useEffect } from 'react';
import { ShoppingBag, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { formatCurrency } from '../utils/currency';
import './Storefront.css';

const Storefront = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [feedback, setFeedback] = useState({});
  const [purchasingId, setPurchasingId] = useState(null);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/products');
      if (!res.ok) throw new Error('Failed to fetch products');
      const data = await res.json();
      setProducts(data);

      const initialQty = {};
      data.forEach(p => {
        initialQty[p.id] = 1;
      });
      setQuantities(initialQty);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  const handleQuantityChange = (id, value) => {
    const qty = parseInt(value, 10);
    setQuantities(prev => ({
      ...prev,
      [id]: isNaN(qty) || qty < 1 ? 1 : qty
    }));
  };

  const handleBuyNow = async (product) => {
    const qty = quantities[product.id] || 1;
    setPurchasingId(product.id);
    setFeedback(prev => ({ ...prev, [product.id]: null }));

    try {
      const res = await fetch('/api/storefront/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: product.id, quantity: qty })
      });

      const result = await res.json();

      if (!res.ok) {
        setFeedback(prev => ({
          ...prev,
          [product.id]: { type: 'error', message: result.error || 'Purchase failed.' }
        }));
      } else {
        setFeedback(prev => ({
          ...prev,
          [product.id]: { type: 'success', message: `✓ Purchased ${qty} units! Remaining stock: ${result.new_stock}.` }
        }));

        setProducts(prev => prev.map(p => p.id === product.id ? { ...p, dark_store_stock: result.new_stock } : p));
      }
    } catch (err) {
      setFeedback(prev => ({
        ...prev,
        [product.id]: { type: 'error', message: err.message || 'Network error occurred.' }
      }));
    } finally {
      setPurchasingId(null);
    }
  };

  if (loading) return <div className="page-loading"><div className="spinner"></div>Loading Storefront...</div>;
  if (error) return <div className="page-error">Error: {error}</div>;

  return (
    <div className="storefront-container">
      <div className="storefront-header">
        <div className="header-title">
          <ShoppingBag className="icon-store" size={28} />
          <div>
            <h1>QuickStore Customer Front</h1>
            <p className="subtitle">Simulate real-time customer purchases — buying stock here live-depletes Dark Store inventory and triggers procurement agent proposals when stock drops to the reorder point.</p>
          </div>
        </div>
      </div>

      <div className="storefront-banner">
        <span>⚡ <strong>Quick Commerce Customer Simulation:</strong> Select items and click "Buy Now" to simulate customer demand.</span>
        <button className="btn-refresh" onClick={fetchProducts}>
          <RefreshCw size={14} /> Refresh Stock
        </button>
      </div>

      <div className="storefront-grid">
        {products.map(product => {
          const isLowStock = product.dark_store_stock <= product.reorder_point;
          const isOutOfStock = product.dark_store_stock === 0;
          const qty = quantities[product.id] || 1;
          const fb = feedback[product.id];

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

          const isPerishable = shelfLifeDays <= 7;

          return (
            <div key={product.id} className={`store-card ${isOutOfStock ? 'out-of-stock' : ''}`}>
              <div className="card-top">
                <span className="category-badge">{product.category}</span>
                <span className={`status-pill ${isLowStock ? 'status-low' : 'status-ok'}`}>
                  {isLowStock ? 'LOW STOCK' : 'IN STOCK'}
                </span>
              </div>

              <h3 className="product-title">{product.name}</h3>

              <div className="price-tag">
                {formatCurrency(product.unit_price)}
                <span className="unit-label">/ unit</span>
              </div>

              <div className="stock-info">
                <span>Available Stock:</span>
                <strong className={isLowStock ? 'text-danger' : 'text-success'}>
                  {product.dark_store_stock} units
                </strong>
              </div>

              <div className="reorder-info">
                Reorder Threshold: {product.reorder_point} units
              </div>

              {product.expiry_date && (
                <div className="expiry-info" style={{
                  marginTop: '0.5rem',
                  paddingTop: '0.5rem',
                  borderTop: '1px dashed var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  justify: 'space-between',
                  fontSize: '0.8rem',
                  color: 'var(--text-tertiary)'
                }}>
                  <span>Expiry Date: <strong style={{ color: 'var(--text-secondary)' }}>{product.expiry_date}</strong></span>
                  {isPerishable && (
                    isExpired ? (
                      <span className="badge badge-danger" style={{ fontSize: '0.68rem', padding: '2px 6px' }}>EXPIRED</span>
                    ) : isExpiringSoon ? (
                      <span className="badge badge-warning" style={{ fontSize: '0.68rem', padding: '2px 6px' }}>Expiring Soon</span>
                    ) : (
                      <span className="badge badge-success" style={{ fontSize: '0.68rem', padding: '2px 6px' }}>Fresh</span>
                    )
                  )}
                </div>
              )}

              <div className="purchase-controls">
                <div className="qty-control">
                  <label htmlFor={`qty-${product.id}`}>Qty:</label>
                  <input
                    id={`qty-${product.id}`}
                    type="number"
                    min="1"
                    max={product.dark_store_stock || 1}
                    value={qty}
                    disabled={isOutOfStock || purchasingId === product.id}
                    onChange={(e) => handleQuantityChange(product.id, e.target.value)}
                  />
                </div>

                <button
                  className="btn-buy"
                  disabled={isOutOfStock || purchasingId === product.id}
                  onClick={() => handleBuyNow(product)}
                >
                  {purchasingId === product.id ? 'Processing...' : isOutOfStock ? 'Out of Stock' : 'Buy Now'}
                </button>
              </div>

              {fb && (
                <div className={`feedback-alert feedback-${fb.type}`}>
                  {fb.type === 'success' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                  <span>{fb.message}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

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
    </div>
  );
};

export default Storefront;
