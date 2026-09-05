import React, { useState, useEffect } from 'react';

const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(amount);
};

const SupplierRevenue = () => {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/suppliers/revenue')
      .then(res => res.json())
      .then(data => {
        setSuppliers(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="content-container">
      <div className="content-header">
        <div className="header-text">
          <h2 className="title">Supplier Revenue</h2>
          <p className="subtitle">Live tracking of fulfilled orders and revenue per supplier.</p>
        </div>
      </div>

      {loading ? (
        <div className="card">Loading supplier data...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {suppliers.map(supplier => (
            <div key={supplier.id} className="card" style={{ padding: '0' }}>
              <div style={{ 
                padding: '1.5rem', 
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                backgroundColor: 'var(--surface-raised)'
              }}>
                <div>
                  <h3 style={{ margin: '0 0 0.25rem 0', color: 'var(--text-primary)' }}>{supplier.name}</h3>
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
                    Supplier ID: {supplier.id}
                  </span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Total Revenue
                  </div>
                  <div style={{ fontSize: '1.5rem', fontWeight: '600', color: 'var(--accent)' }}>
                    {formatCurrency(supplier.totalRevenue)}
                  </div>
                </div>
              </div>
              
              <div className="table-container" style={{ border: 'none', borderRadius: '0' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Product (SKU)</th>
                      <th>Quantity</th>
                      <th>Amount Earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplier.orders.length === 0 ? (
                      <tr>
                        <td colSpan="4" style={{ textAlign: 'center', padding: '2rem' }}>
                          No fulfilled orders yet.
                        </td>
                      </tr>
                    ) : (
                      supplier.orders.map(order => (
                        <tr key={order.id}>
                          <td>{new Date(order.timestamp).toLocaleString()}</td>
                          <td>{order.product_name}</td>
                          <td>{order.quantity}</td>
                          <td style={{ fontWeight: '500' }}>{formatCurrency(order.price)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SupplierRevenue;
