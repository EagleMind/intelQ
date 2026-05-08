import React from 'react';

interface NavbarProps {
  onConnectionsClick?: () => void;
  onStatusUpdate?: (message: string) => void;
}

const Navbar: React.FC<NavbarProps> = ({ onConnectionsClick }) => {
  return (
    <nav className="navbar">
      <div className="navbar-content">
        <h1 className="navbar-title">IntelQuery</h1>
        <span className="navbar-subtitle">AI-Powered SQL Assistant</span>
        <button className="navbar-button" onClick={onConnectionsClick}>Connections</button>
      </div>
    </nav>
  );
};

export default Navbar;
