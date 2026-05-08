import React, { useState, useEffect } from 'react';
import { safeInvoke } from '../utils/tauri';
import { RefreshCw } from 'lucide-react';
import '../index.css';

interface DataExplorerProps {
  dbConnected: boolean;
  onStatusUpdate: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
}

interface TableColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string;
}

interface TableData {
  tableName: string;
  columns: string[];
  rows: any[][];
  totalRows: number;
  limit: number;
  offset: number;
}

const DataExplorer: React.FC<DataExplorerProps> = ({
  dbConnected,
  onStatusUpdate,
  onLoadingChange
}) => {
  const [tables, setTables] = useState<string[]>([]);
    const [showTableModal, setShowTableModal] = useState(false);
  const [modalTableData, setModalTableData] = useState<TableData | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    if (dbConnected) {
      loadTables();
    } else {
      setTables([]);
      setShowTableModal(false);
      setModalTableData(null);
    }
  }, [dbConnected]);

  const loadTables = async () => {
    try {
      onLoadingChange(true);
      onStatusUpdate('Loading tables...');
      
      const response = await safeInvoke('get_tables', {});
      const result = response as { tables: string[] };
      setTables(result.tables);
      onStatusUpdate(`Loaded ${result.tables.length} tables`);
    } catch (error) {
      onStatusUpdate(`Failed to load tables: ${error}`);
      console.error('Failed to load tables:', error);
    } finally {
      onLoadingChange(false);
    }
  };

  const loadTableData = async (tableName: string, limit: number = pageSize, offset: number = 0) => {
    try {
      onLoadingChange(true);
      onStatusUpdate(`Loading data for ${tableName}...`);
      
      const response = await safeInvoke('get_table_data', { 
        tableName, 
        limit, 
        offset 
      });
      
      const backendData = response as { 
        columns: TableColumn[];
        rows: { [key: string]: string }[];
        total_rows: number;
        limit: number;
        offset: number;
      };
      
      const tableData: TableData = {
        tableName,
        columns: backendData.columns.map(col => col.name),
        rows: backendData.rows.map(row => 
          backendData.columns.map(col => row[col.name] || 'NULL')
        ),
        totalRows: backendData.total_rows,
        limit: backendData.limit,
        offset: backendData.offset
      };
      
      setModalTableData(tableData);
      setShowTableModal(true);
      onStatusUpdate(`Loaded ${tableData.rows.length} rows from ${tableName}`);
    } catch (error) {
      onStatusUpdate(`Failed to load data: ${error}`);
      console.error('Failed to load data:', error);
    } finally {
      onLoadingChange(false);
    }
  };

  
  const handlePagination = async (direction: 'next' | 'prev') => {
    if (!modalTableData) return;
    
    const currentOffset = modalTableData.offset;
    const limit = pageSize;
    const newOffset = direction === 'next' ? currentOffset + limit : Math.max(0, currentOffset - limit);
    
    await loadTableData(modalTableData.tableName, limit, newOffset);
  };

  const handlePageSizeChange = async (newPageSize: number) => {
    setPageSize(newPageSize);
    if (modalTableData) {
      await loadTableData(modalTableData.tableName, newPageSize, 0);
    }
  };

  const getFilteredRows = () => {
    if (!modalTableData || !searchTerm) return modalTableData?.rows || [];
    
    return modalTableData.rows.filter(row =>
      row.some(cell => 
        cell.toString().toLowerCase().includes(searchTerm.toLowerCase())
      )
    );
  };

  const closeModal = () => {
    setShowTableModal(false);
  };

  const exportTableData = () => {
    if (modalTableData) {
      const csv = [
        modalTableData.columns.join(','),
        ...modalTableData.rows.map(row => row.join(','))
      ].join('\n');
      
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${modalTableData.tableName}_data.csv`;
      a.click();
      URL.revokeObjectURL(url);
      onStatusUpdate(`Exported ${modalTableData.tableName} data to CSV`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#2d2d2d] rounded-lg border border-[#404040]">
      <div className="px-4 py-4 border-b border-[#404040] flex items-center gap-3">
        <h3 className="m-0 text-white text-base font-semibold">Data Explorer</h3>
        <button 
          className="btn btn-secondary btn-sm"
          onClick={loadTables}
          disabled={!dbConnected}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </button>
      </div>

      <div className="flex-1 px-4 py-4 overflow-y-auto max-h-screen">
        {!dbConnected ? (
          <div className="text-center text-[#cccccc] py-8">
            Connect to a database to explore tables
          </div>
        ) : tables.length === 0 ? (
          <div className="text-center text-[#cccccc] py-8">
            No tables found in database
          </div>
        ) : (
          <div className="space-y-1">
            {tables.map(table => (
              <div 
                key={table} 
                className="px-3 py-2 text-sm font-medium hover:bg-[#555555] transition-colors cursor-pointer text-left"
                onClick={() => loadTableData(table)}
              >
                {table}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Table Data Modal */}
      {showTableModal && modalTableData && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Table: {modalTableData.tableName}</h3>
              <button className="modal-close" onClick={closeModal}>×</button>
            </div>
            
            <div className="modal-body">
              <div className="table-controls">
                <div className="search-container">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search table data..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <div className="page-size-container">
                  <label className="page-size-label">Rows per page:</label>
                  <select 
                    className="page-size-select"
                    value={pageSize}
                    onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                  </select>
                </div>
              </div>

              <div className="table-info">
                <span className="info-badge">
                  {modalTableData.totalRows.toLocaleString()} total rows
                </span>
                {searchTerm && (
                  <span className="info-badge">
                    {getFilteredRows().length} filtered results
                  </span>
                )}
                <span className="info-badge">
                  Showing {modalTableData.offset + 1}-{Math.min(
                    modalTableData.offset + pageSize, 
                    modalTableData.totalRows
                  )}
                </span>
              </div>

              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      {modalTableData.columns.map(col => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {getFilteredRows().map((row, idx) => (
                      <tr key={idx}>
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            
            <div className="modal-footer">
              <div className="pagination">
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={() => handlePagination('prev')}
                  disabled={modalTableData.offset === 0}
                >
                  Previous
                </button>
                <span className="pagination-info">
                  {modalTableData.offset + 1}-{Math.min(
                    modalTableData.offset + modalTableData.limit, 
                    modalTableData.totalRows
                  )} of {modalTableData.totalRows}
                </span>
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={() => handlePagination('next')}
                  disabled={
                    modalTableData.offset + modalTableData.limit >= modalTableData.totalRows
                  }
                >
                  Next
                </button>
              </div>
              
              <div className="modal-actions">
                <button 
                  className="btn btn-secondary"
                  onClick={exportTableData}
                >
                  Export CSV
                </button>
                <button className="btn btn-secondary" onClick={closeModal}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DataExplorer;
