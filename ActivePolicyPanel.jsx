import React, { useState, useEffect } from 'react';
import { formatCurrency } from '../utils/currency';
import { ShieldCheck, Edit2, Check, X } from 'lucide-react';

const ActivePolicyPanel = ({ onPolicyUpdate }) => {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isEditingBudget, setIsEditingBudget] = useState(false);
  const [editBudget, setEditBudget] = useState('');
  const [isEditingThreshold, setIsEditingThreshold] = useState(false);
  const [editThreshold, setEditThreshold] = useState('');

  const fetchPolicy = async () => {
    try {
      const res = await fetch('/api/policy');
      if (res.ok) {
        const data = await res.json();
        setPolicy(data);
        setEditBudget(data.budget_cap.toString());
        setEditThreshold((data.auto_approve_threshold ?? 5000).toString());
      }
    } catch (err) {
      console.error('Failed to fetch policy:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolicy();
  }, []);

  const handleSaveBudget = async () => {
    try {
      const res = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget_cap: parseFloat(editBudget) })
      });
      if (res.ok) {
        await fetchPolicy();
        setIsEditingBudget(false);
        if (onPolicyUpdate) onPolicyUpdate();
      }
    } catch (err) {
      console.error('Error updating policy budget:', err);
      alert('Error updating policy');
    }
  };

  const handleSaveThreshold = async () => {
    try {
      const res = await fetch('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_approve_threshold: parseFloat(editThreshold) })
      });
      if (res.ok) {
        await fetchPolicy();
        setIsEditingThreshold(false);
        if (onPolicyUpdate) onPolicyUpdate();
      }
    } catch (err) {
      console.error('Error updating auto-approve threshold:', err);
      alert('Error updating policy');
    }
  };

  if (loading || !policy) return null;

  return (
    <div style={{
      background: 'var(--surface-raised)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: '1rem',
      marginBottom: '1.5rem',
      display: 'flex',
      alignItems: 'center',
      gap: '1.5rem',
      flexWrap: 'wrap'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)' }}>
        <ShieldCheck size={18} />
        <strong style={{ color: 'var(--text-primary)' }}>Active Policy Limits</strong>
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderLeft: '1px solid var(--border)', paddingLeft: '1.5rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Max Order Budget:</span>
        {isEditingBudget ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>₹</span>
            <input 
              type="number" 
              value={editBudget} 
              onChange={e => setEditBudget(e.target.value)}
              style={{
                width: '100px',
                padding: '2px 6px',
                border: '1px solid var(--accent)',
                borderRadius: '4px',
                background: 'var(--bg-default)',
                color: 'var(--text-primary)'
              }}
            />
            <button onClick={handleSaveBudget} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--success)', display: 'flex' }}>
              <Check size={16} />
            </button>
            <button onClick={() => { setIsEditingBudget(false); setEditBudget(policy.budget_cap.toString()); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>
              {formatCurrency(policy.budget_cap)}
            </span>
            <button 
              onClick={() => setIsEditingBudget(true)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: 0 }}
              title="Edit Budget Cap"
            >
              <Edit2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderLeft: '1px solid var(--border)', paddingLeft: '1.5rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Remaining Budget:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{
            fontWeight: '700',
            fontSize: '0.95rem',
            color: (policy.remaining_budget ?? policy.budget_cap) < 5000 
              ? 'var(--danger)' 
              : (policy.remaining_budget ?? policy.budget_cap) < 15000 
                ? 'var(--warning)' 
                : 'var(--success)'
          }}>
            {formatCurrency(policy.remaining_budget ?? policy.budget_cap)}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
            ({formatCurrency(policy.total_committed ?? 0)} reserved)
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderLeft: '1px solid var(--border)', paddingLeft: '1.5rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Auto-Approve Threshold:</span>
        {isEditingThreshold ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>₹</span>
            <input 
              type="number" 
              value={editThreshold} 
              onChange={e => setEditThreshold(e.target.value)}
              style={{
                width: '100px',
                padding: '2px 6px',
                border: '1px solid var(--accent)',
                borderRadius: '4px',
                background: 'var(--bg-default)',
                color: 'var(--text-primary)'
              }}
            />
            <button onClick={handleSaveThreshold} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--success)', display: 'flex' }}>
              <Check size={16} />
            </button>
            <button onClick={() => { setIsEditingThreshold(false); setEditThreshold((policy.auto_approve_threshold ?? 5000).toString()); }} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontWeight: '600', color: 'var(--text-primary)' }}>
              {formatCurrency(policy.auto_approve_threshold ?? 5000)}
            </span>
            <button 
              onClick={() => setIsEditingThreshold(true)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: 0 }}
              title="Edit Auto-Approve Threshold"
            >
              <Edit2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', borderLeft: '1px solid var(--border)', paddingLeft: '1.5rem' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Approved Whitelist:</span>
        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {policy.approved_suppliers.map(id => (
            <span key={id} className="badge badge-neutral" style={{ fontSize: '0.75rem', padding: '0.1rem 0.4rem' }}>
              {policy.supplier_names[id] || `ID: ${id}`}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ActivePolicyPanel;
