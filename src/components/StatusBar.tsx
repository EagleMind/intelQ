import React from 'react';

interface StatusBarProps {
  message: string;
  isLoading: boolean;
}

const StatusBar: React.FC<StatusBarProps> = ({ message, isLoading }) => {
  return (
    <div className="status-bar">
      <div className="status-content">
        {isLoading && (
          <div className="loading-spinner">
            <div className="spinner"></div>
          </div>
        )}
        <span className="status-message">{message}</span>
      </div>
    </div>
  );
};

export default StatusBar;
