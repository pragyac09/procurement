import React from 'react';
import { NavLink } from 'react-router-dom';
import { PackageSearch, ShoppingBag, ShoppingCart, CheckSquare, TrendingUp } from 'lucide-react';

const Sidebar = () => {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Agentic Procurement</h1>
      </div>
      <nav className="sidebar-nav">
        <NavLink to="/storefront" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ShoppingBag />
          Storefront
        </NavLink>
        <NavLink to="/" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <PackageSearch />
          Inventory Catalog
        </NavLink>
        <NavLink to="/orders" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <ShoppingCart />
          Proposed Orders
        </NavLink>
        <NavLink to="/decisions" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <CheckSquare />
          Decision Log
        </NavLink>
        <NavLink to="/revenue" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <TrendingUp />
          Supplier Revenue
        </NavLink>
      </nav>
    </aside>
  );
};

export default Sidebar;
