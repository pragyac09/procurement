import React, { useState, useEffect } from 'react';

const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(amount);
};

const DecisionLog = () => {
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/decisions')
      .then(res => res.json())
      .then(data => {
        setDecisions(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const getVerdictBadgeClass = (verdict) => {
    switch (verdict) {
      case 'APPROVE': return 'badge-success';
      case 'APPROVED_BY_OPERATOR': return 'badge-warning';
      case 'SPOILAGE': return 'badge-warning';
      case 'PAYMENT_FAILED': return 'badge-danger';
      case 'BLOCK':
      case 'REJECTED': return 'badge-danger';
      case 'ESCALATE': return 'badge-warning';
      default: return 'badge-neutral';
    }
  };

  const getPaymentBadgeClass = (status) => {
    if (status === 'PAID') return 'badge-success';
    if (status === 'FAILED') return 'badge-danger';
    return 'badge-warning';
  };

  return (
    <div className="content-container">
      <div className="content-header">
        <div className="header-text">
          <h2 className="title">Decision Log</h2>
          <p className="subtitle">Audit trail of all autonomous procurement decisions.</p>
        </div>
      </div>

      {loading ? (
        <div className="card">Loading decisions...</div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Product (SKU)</th>
                <th>Supplier</th>
                <th>Quantity</th>
                <th>Total Cost</th>
                <th>Verdict</th>
                <th>Reason</th>
                <th>Payment Status</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr>
                  <td colSpan="8" style={{ textAlign: 'center' }}>No decisions logged yet.</td>
                </tr>
              ) : (
                decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td>{new Date(decision.timestamp).toLocaleString()}</td>
                    <td>{decision.product_name}</td>
                    <td>{decision.supplier_name}</td>
                    <td>{decision.quantity}</td>
                    <td>{formatCurrency(decision.price)}</td>
                    <td>
                      <span 
                        className={`badge ${getVerdictBadgeClass(decision.verdict)}`} 
                        style={
                          decision.verdict === 'APPROVED_BY_OPERATOR' ? { background: '#fef08a', color: '#854d0e' } :
                          decision.verdict === 'SPOILAGE' ? { background: '#d97706', color: '#ffffff', borderColor: '#b45309' } :
                          decision.verdict === 'PAYMENT_FAILED' ? { background: '#dc2626', color: '#ffffff', borderColor: '#991b1b' } : {}
                        }
                      >
                        {decision.verdict === 'APPROVED_BY_OPERATOR' ? 'APPROVED BY OPERATOR' : decision.verdict === 'PAYMENT_FAILED' ? 'PAYMENT FAILED' : decision.verdict}
                      </span>
                    </td>
                    <td>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            {decision.reason}
                        </span>
                    </td>
                    <td>
                      <span className={`badge ${getPaymentBadgeClass(decision.payment_status)}`}>
                        {decision.payment_status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DecisionLog;
