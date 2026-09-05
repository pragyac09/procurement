import React, { useState, useEffect, useCallback } from 'react';
import { formatCurrency } from '../utils/currency';
import ActivePolicyPanel from './ActivePolicyPanel';
import './ProposedOrders.css';

const loadScript = (src) => {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
};

const renderRequestSentSentence = (request, proposal) => {
  const sku = (request && request.sku) || proposal.product_name;
  const qty = (request && request.quantity_requested) || proposal.quantity;

  if (request && Array.isArray(request.queried_suppliers) && request.queried_suppliers.length > 0) {
    const suppliers = request.queried_suppliers;
    let supplierText = "";
    if (suppliers.length === 1) {
      supplierText = suppliers[0];
    } else if (suppliers.length === 2) {
      supplierText = `${suppliers[0]} and ${suppliers[1]}`;
    } else {
      supplierText = `${suppliers.slice(0, -1).join(', ')}, and ${suppliers[suppliers.length - 1]}`;
    }
    return `Asked ${supplierText} for ${qty} units of ${sku}.`;
  }

  if (request && request.queried_supplier) {
    return `Asked ${request.queried_supplier} for ${qty} units of ${sku}.`;
  }

  return `Asked ${proposal.supplier_name} for ${qty} units of ${sku}.`;
};

const ProposedOrders = () => {
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentStatus, setPaymentStatus] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editQuantity, setEditQuantity] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);
  const [expandedExchange, setExpandedExchange] = useState({});
  const [selectedSuppliers, setSelectedSuppliers] = useState({});

  const handleSelectSupplier = (proposalId, supplierId) => {
    setSelectedSuppliers(prev => ({
      ...prev,
      [proposalId]: supplierId
    }));
  };

  const toggleExchange = (id) => {
    setExpandedExchange(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const [policyKey, setPolicyKey] = useState(0);

  const fetchProposals = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/proposals');
      if (!response.ok) {
        throw new Error('Failed to fetch proposals');
      }
      const data = await response.json();
      setProposals(data);
      setPolicyKey(prev => prev + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const handlePayment = async (proposal, isOperatorOverride = false) => {
    const res = await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    if (!res) {
      alert('Razorpay SDK failed to load. Are you online?');
      return;
    }

    const chosenSupplierId = selectedSuppliers[proposal.id] || proposal.supplier_id;

    try {
      const orderResponse = await fetch('/api/checkout/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          proposal_id: proposal.proposal_id || proposal.id,
          sku_id: proposal.sku_id, 
          quantity: proposal.quantity,
          selected_supplier_id: chosenSupplierId,
          is_operator_override: isOperatorOverride 
        })
      });
      const orderData = await orderResponse.json();

      if (!orderResponse.ok) {
        alert(orderData.error || 'Failed to create order');
        fetchProposals();
        return;
      }

      let paymentHandled = false;

      const options = {
        key: orderData.key,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Agentic Procurement',
        description: `Order for ${proposal.product_name}`,
        order_id: orderData.order_id,
        handler: async function (response) {
          paymentHandled = true;
          const verifyResponse = await fetch('/api/checkout/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature,
              internal_order_id: orderData.internal_order_id
            })
          });
          const verifyData = await verifyResponse.json();
          if (verifyResponse.ok) {
            setPaymentStatus(prev => ({ ...prev, [proposal.id]: 'PAID' }));
            if (isOperatorOverride) {
              setProposals(prev => prev.map(p => p.id === proposal.id ? { ...p, verdict: 'APPROVED_BY_OPERATOR' } : p));
            } else {
              setProposals(prev => prev.map(p => p.id === proposal.id ? { ...p, verdict: 'PAID' } : p));
            }
            fetchProposals();
          } else {
            alert('Payment verification failed: ' + verifyData.message);
          }
        },
        modal: {
          ondismiss: async function() {
            if (!paymentHandled) {
              try {
                await fetch('/api/checkout/failed', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    internal_order_id: orderData.internal_order_id,
                    reason: 'Checkout modal cancelled by operator'
                  })
                });
              } catch (e) {
                console.error('Failed to log payment cancellation:', e);
              }
            }
          }
        },
        prefill: {
          name: 'Procurement Admin',
          email: 'admin@example.com'
        },
        theme: {
          color: '#4f46e5'
        }
      };

      const paymentObject = new window.Razorpay(options);

      paymentObject.on('payment.failed', async function (response) {
        paymentHandled = true;
        const failureReason = response.error ? (response.error.description || response.error.reason || 'Payment failed') : 'Payment failed';
        try {
          await fetch('/api/checkout/failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              internal_order_id: orderData.internal_order_id,
              reason: failureReason
            })
          });
        } catch (e) {
          console.error('Failed to log payment failure:', e);
        }
        alert(`Payment Failed: ${failureReason}. The proposal remains open for retry.`);
      });

      paymentObject.open();
    } catch (err) {
      console.error(err);
      alert('Error initiating checkout');
    }
  };

  const handleSaveQuantity = async (proposal) => {
    try {
      const res = await fetch(`/api/proposals/${proposal.sku_id}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: editQuantity })
      });
      if (!res.ok) throw new Error('Failed to evaluate');
      const updated = await res.json();
      setProposals(prev => prev.map(p => p.id === proposal.id ? { ...updated, id: p.id } : p));
      setEditingId(null);
      fetchProposals();
    } catch (err) {
      alert('Error updating quantity');
      console.error(err);
    }
  };

  const handleReject = async (proposal) => {
    try {
      const res = await fetch(`/api/proposals/${proposal.sku_id}/reject`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Failed to reject proposal');
      setProposals(prev => prev.map(p => p.id === proposal.id ? { ...p, verdict: 'REJECTED', verdict_reason: 'Manually rejected by operator.' } : p));
      fetchProposals();
    } catch (err) {
      alert('Error rejecting proposal');
      console.error(err);
    }
  };

  const actionsRequiredCount = proposals.filter(p => 
    p.verdict !== 'REJECTED' && 
    p.verdict !== 'APPROVED_BY_OPERATOR' && 
    p.verdict !== 'PAID' && 
    paymentStatus[p.id] !== 'PAID'
  ).length;

  if (loading) {
    return <div className="loading">Analyzing catalog for restocking...</div>;
  }

  if (error) {
    return <div className="error">Error loading proposals: {error}</div>;
  }

  if (proposals.length === 0) {
    return (
      <div className="empty-state">
        <h3>No Restock Needed</h3>
        <p>All SKUs are currently above their reorder points.</p>
      </div>
    );
  }

  return (
    <div className="proposals-container">
      <div className="proposals-header">
        <div className="header-text">
          <h2>Procurement Agent Proposals</h2>
          <p className="subtitle">Automatically generated restock orders based on current inventory levels.</p>
        </div>
        <span className="badge badge-neutral">{actionsRequiredCount} Action(s) Required</span>
      </div>

      <ActivePolicyPanel key={policyKey} onPolicyUpdate={fetchProposals} />

      <div className="verdict-legend">
        <div className="legend-item">
          <span className="badge badge-success">APPROVE</span>
          <span className="legend-text">— Passes all checks. Payment executes automatically.</span>
        </div>
        <div className="legend-item">
          <span className="badge badge-warning">ESCALATE</span>
          <span className="legend-text">— Flagged for review (unusual risk signal). Needs human approval before payment.</span>
        </div>
        <div className="legend-item">
          <span className="badge badge-danger">BLOCK</span>
          <span className="legend-text">— Fails a hard rule (budget or supplier policy). Cannot proceed under any circumstance.</span>
        </div>
        <div className="legend-item">
          <span className="badge badge-warning" style={{ background: '#d97706', borderColor: '#b45309', color: '#ffffff' }}>SPOILAGE</span>
          <span className="legend-text">— Expired stock was automatically written off; a replacement order may follow.</span>
        </div>
      </div>

      <div className="proposals-list">
        {proposals.map((proposal) => {
          const suppliersList = proposal.supplier_exchange?.response?.suppliers || [];
          const defaultSelectedEntry = suppliersList.find(s => s.selected) || suppliersList[0];
          const defaultSupplierId = defaultSelectedEntry ? defaultSelectedEntry.supplier_id : proposal.supplier_id;
          const activeSelectedId = selectedSuppliers[proposal.id] ?? defaultSupplierId;
          const activeSelectedEntry = suppliersList.find(s => s.supplier_id === activeSelectedId) || defaultSelectedEntry;

          const activeUnitPrice = activeSelectedEntry ? Number(activeSelectedEntry.unit_price) : proposal.unit_price;
          const activeSupplierName = activeSelectedEntry ? (activeSelectedEntry.supplier || activeSelectedEntry.supplier_name) : proposal.supplier_name;
          const activeLeadTimeDays = activeSelectedEntry ? activeSelectedEntry.lead_time_days : proposal.lead_time_days;
          const activeTotalCost = proposal.quantity * activeUnitPrice;

          return (
            <div key={proposal.id} className={`proposal-card ${proposal.verdict === 'REJECTED' ? 'rejected' : ''}`}>
              <div className="proposal-header">
                <div className="sku-info">
                  <span className="sku-name">{proposal.product_name}</span>
                  <span className="badge badge-neutral">{proposal.category}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
                  {proposal.verdict === 'APPROVE' && <span className="badge badge-success">APPROVE</span>}
                  {proposal.verdict === 'APPROVED_BY_OPERATOR' && <span className="badge badge-warning" style={{ background: '#fef08a', color: '#854d0e' }}>APPROVED BY OPERATOR</span>}
                  {proposal.verdict === 'BLOCK' && <span className="badge badge-danger">BLOCK</span>}
                  {proposal.verdict === 'ESCALATE' && <span className="badge badge-warning">ESCALATE</span>}
                  {proposal.verdict === 'REJECTED' && <span className="badge badge-danger">REJECTED</span>}
                  <div className="total-cost">
                    {formatCurrency(activeTotalCost)}
                  </div>
                </div>
              </div>
              
              <div className="proposal-body">
                <div className="proposal-reason">
                  <strong>Verdict Reason:</strong> {proposal.verdict_reason}<br/>
                  <strong style={{marginTop: '4px', display: 'inline-block'}}>Calculation:</strong> {proposal.reason}
                </div>
                <div className="proposal-details">
                  <div className="detail-item">
                    <span className="detail-label">Supplier</span>
                    <span className="detail-value">{activeSupplierName}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Quantity</span>
                    {editingId === proposal.id ? (
                      <input 
                        type="number" 
                        value={editQuantity !== '' && editQuantity !== null && editQuantity !== undefined ? editQuantity : proposal.quantity} 
                        onChange={(e) => setEditQuantity(e.target.value)}
                        placeholder={String(proposal.quantity)}
                        style={{ width: '80px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-primary)' }}
                        min="1"
                      />
                    ) : (
                      <span className="detail-value">{proposal.quantity} units</span>
                    )}
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Est. Lead Time</span>
                    <span className="detail-value">{activeLeadTimeDays} days</span>
                  </div>
                </div>

                {proposal.supplier_exchange && (
                  <div className="supplier-exchange-wrapper" style={{ marginTop: '0.85rem' }}>
                    <button 
                      onClick={() => toggleExchange(proposal.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--accent)',
                        fontSize: '0.8rem',
                        fontWeight: '500',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: 0
                      }}
                    >
                      {expandedExchange[proposal.id] ? '▼ Hide agent ↔ supplier exchange' : '▶ View agent ↔ supplier exchange'}
                    </button>

                    {expandedExchange[proposal.id] && (
                      <div className="exchange-content" style={{
                        marginTop: '0.5rem',
                        padding: '0.85rem 1rem',
                        background: 'var(--surface-raised)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        fontSize: '0.85rem',
                        fontFamily: 'inherit'
                      }}>
                        <div style={{ marginBottom: '0.85rem' }}>
                          <strong style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem', fontSize: '0.8rem', fontFamily: 'sans-serif' }}>
                            Request Sent (Procurement Agent → Catalog):
                          </strong>
                          <div style={{
                            background: 'var(--bg-default)',
                            padding: '0.6rem 0.85rem',
                            borderRadius: '4px',
                            border: '1px solid var(--border)',
                            color: 'var(--text-primary)',
                            fontSize: '0.85rem',
                            lineHeight: '1.4'
                          }}>
                            {renderRequestSentSentence(proposal.supplier_exchange?.request, proposal)}
                          </div>
                        </div>

                        <div>
                          <strong style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem', fontSize: '0.8rem', fontFamily: 'sans-serif' }}>
                            Response Received (Supplier Catalog → Agent):
                          </strong>
                          {proposal.supplier_exchange?.response?.suppliers ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                              {proposal.supplier_exchange.response.selection_summary && (
                                <div style={{
                                  fontSize: '0.8rem',
                                  fontWeight: '600',
                                  color: 'var(--accent)',
                                  background: 'var(--bg-default)',
                                  border: '1px solid var(--border)',
                                  borderRadius: '4px',
                                  padding: '0.5rem 0.75rem'
                                }}>
                                  ⚡ SLA Selection Rule: {proposal.supplier_exchange.response.selection_summary}
                                </div>
                              )}
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
                                {proposal.supplier_exchange.response.suppliers.map((sup, idx) => {
                                  const isCardSelected = sup.supplier_id === activeSelectedId;
                                  const isOperatorOverride = activeSelectedId !== defaultSupplierId;

                                  const priceFormatted = `₹${Number(sup.unit_price).toFixed(2)}`;
                                  const leadTimeText = `${sup.lead_time_days} ${sup.lead_time_days === 1 ? 'day' : 'days'}`;
                                  const stockText = sup.available_stock ? 'Yes' : 'No';

                                  let reasonText = "";
                                  if (isCardSelected) {
                                    reasonText = isOperatorOverride 
                                      ? "Manually selected by operator (overrides lowest-price recommendation)" 
                                      : (sup.selection_reason || "Lowest price within 2-day SLA");
                                  } else {
                                    reasonText = (isOperatorOverride && sup.supplier_id === defaultSupplierId)
                                      ? "Not selected by operator"
                                      : (sup.selection_reason || "Higher price");
                                  }

                                  return (
                                    <div 
                                      key={idx} 
                                      onClick={() => handleSelectSupplier(proposal.id, sup.supplier_id)}
                                      style={{
                                        background: isCardSelected ? 'rgba(34, 197, 94, 0.08)' : 'var(--bg-default)',
                                        border: isCardSelected ? '1.5px solid var(--success)' : '1px solid var(--border)',
                                        borderRadius: '6px',
                                        padding: '0.75rem 0.9rem',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.5rem',
                                        cursor: 'pointer',
                                        transition: 'all 0.15s ease'
                                      }}
                                    >
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <strong style={{ fontSize: '0.85rem', color: isCardSelected ? 'var(--success)' : 'var(--text-primary)', fontFamily: 'sans-serif' }}>
                                          {sup.supplier}
                                        </strong>
                                        {isCardSelected ? (
                                          <span className="badge badge-success" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>✓ SELECTED</span>
                                        ) : (
                                          <span className="badge badge-neutral" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>PASSED OVER</span>
                                        )}
                                      </div>

                                      <div style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'auto 1fr',
                                        gap: '0.35rem 1rem',
                                        fontSize: '0.8rem',
                                        fontFamily: 'sans-serif',
                                        color: 'var(--text-primary)'
                                      }}>
                                        <span style={{ color: 'var(--text-secondary)' }}>Price per unit:</span>
                                        <span style={{ fontWeight: '600' }}>{priceFormatted}</span>

                                        <span style={{ color: 'var(--text-secondary)' }}>Lead time:</span>
                                        <span>{leadTimeText}</span>

                                        <span style={{ color: 'var(--text-secondary)' }}>Stock available:</span>
                                        <span>{stockText}</span>

                                        <span style={{ color: 'var(--text-secondary)' }}>
                                          {isCardSelected ? 'Why selected:' : 'Why not selected:'}
                                        </span>
                                        <span style={{ color: isCardSelected ? 'var(--success)' : 'var(--text-secondary)', fontWeight: isCardSelected ? '500' : 'normal' }}>
                                          {reasonText}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                        ) : proposal.supplier_exchange?.response?.primary_supplier ? (
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' }}>
                            {[
                              { label: 'Primary Supplier', data: proposal.supplier_exchange.response.primary_supplier },
                              { label: 'Backup Supplier', data: proposal.supplier_exchange.response.backup_supplier }
                            ].map((item, idx) => {
                              const d = item.data;
                              if (!d) return null;
                              return (
                                <div key={idx} style={{ background: 'var(--bg-default)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.75rem 0.9rem' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                    <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontFamily: 'sans-serif' }}>{d.supplier}</strong>
                                    <span className="badge badge-neutral" style={{ fontSize: '0.7rem', padding: '2px 6px' }}>{item.label}</span>
                                  </div>
                                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem', fontSize: '0.8rem', fontFamily: 'sans-serif' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Price per unit:</span>
                                    <span style={{ fontWeight: '600' }}>₹{Number(d.unit_price).toFixed(2)}</span>

                                    <span style={{ color: 'var(--text-secondary)' }}>Lead time:</span>
                                    <span>{d.lead_time_days} {d.lead_time_days === 1 ? 'day' : 'days'}</span>

                                    <span style={{ color: 'var(--text-secondary)' }}>Stock available:</span>
                                    <span>{d.available_stock ? 'Yes' : 'No'}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div style={{
                            background: 'var(--bg-default)',
                            border: '1px solid var(--border)',
                            borderRadius: '6px',
                            padding: '0.75rem 0.9rem',
                            maxWidth: '400px'
                          }}>
                            <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)', display: 'block', marginBottom: '0.5rem', fontFamily: 'sans-serif' }}>
                              {proposal.supplier_name}
                            </strong>
                            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.35rem 1rem', fontSize: '0.8rem', fontFamily: 'sans-serif', color: 'var(--text-primary)' }}>
                              <span style={{ color: 'var(--text-secondary)' }}>Price per unit:</span>
                              <span style={{ fontWeight: '600' }}>
                                ₹{Number((proposal.supplier_exchange?.response?.unit_price) ?? proposal.unit_price).toFixed(2)}
                              </span>

                              <span style={{ color: 'var(--text-secondary)' }}>Lead time:</span>
                              <span>
                                {((proposal.supplier_exchange?.response?.lead_time_days) ?? proposal.lead_time_days)} {((proposal.supplier_exchange?.response?.lead_time_days) ?? proposal.lead_time_days) === 1 ? 'day' : 'days'}
                              </span>

                              <span style={{ color: 'var(--text-secondary)' }}>Stock available:</span>
                              <span>{((proposal.supplier_exchange?.response?.available_stock) ?? true) ? 'Yes' : 'No'}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {confirmingId === proposal.id && (
                <div className="escalate-confirm-box" style={{
                  marginTop: '1rem',
                  padding: '0.85rem 1rem',
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--accent)',
                  borderRadius: 'var(--radius)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem'
                }}>
                  <div style={{ fontWeight: '600', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                    ⚠️ Confirm Manual Operator Approval
                  </div>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    This order was escalated due to: <strong>{proposal.verdict_reason}</strong>
                  </p>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Are you sure you want to approve this escalated order as an operator override?
                  </p>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <button 
                      className="btn-primary" 
                      style={{ padding: '4px 12px', fontSize: '0.85rem' }} 
                      onClick={() => { setConfirmingId(null); handlePayment(proposal, true); }}
                    >
                      Confirm & Pay
                    </button>
                    <button 
                      className="btn-outline" 
                      style={{ padding: '4px 12px', fontSize: '0.85rem' }} 
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            
            <div className="proposal-actions">
              {proposal.verdict === 'REJECTED' ? (
                  <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                    This proposal was rejected.
                  </span>
              ) : editingId === proposal.id ? (
                <>
                  <button className="btn-primary" onClick={() => handleSaveQuantity(proposal)}>Save</button>
                  <button className="btn-outline" onClick={() => setEditingId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  {proposal.verdict === 'APPROVE' && paymentStatus[proposal.id] !== 'PAID' && (
                    <button className="btn-primary" onClick={() => handlePayment(proposal, false)}>
                      Pay & Execute Order
                    </button>
                  )}
                  {proposal.verdict === 'ESCALATE' && paymentStatus[proposal.id] !== 'PAID' && (
                    <button 
                      className="btn-primary" 
                      style={{ background: '#d97706', borderColor: '#b45309', color: '#ffffff' }} 
                      onClick={() => setConfirmingId(proposal.id)}
                    >
                      Approve & Proceed
                    </button>
                  )}
                  {paymentStatus[proposal.id] === 'PAID' && (
                    <span className="badge badge-success" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                      ✓ PAID
                    </span>
                  )}
                  {proposal.verdict !== 'APPROVE' && paymentStatus[proposal.id] !== 'PAID' && (
                    <>
                      <button className="btn-outline" onClick={() => { setEditingId(proposal.id); setEditQuantity(String(proposal.quantity)); }}>Modify</button>
                      <button className="btn-outline danger" onClick={() => handleReject(proposal)}>Reject</button>
                    </>
                  )}
                </>
              )}
            </div>
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

export default ProposedOrders;
