import React, { useCallback, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../services/api';
import { useDb } from '../store/DbContext';
import type { TableDataResponse } from '../types/api';
import '../index.css';

interface TableSnapshot {
  tableName: string;
  columns: string[];
  rows: (string | null)[][];
  totalRows: number;
  limit: number;
  offset: number;
}

const cellText = (v: string | null) => (v === null ? 'NULL' : v);

const DataExplorer: React.FC = () => {
  const { status, tables, refreshSchema, setStatusMessage, setLoading } = useDb();
  const dbConnected = status.connected;

  const [showTableModal, setShowTableModal] = useState(false);
  const [modalData, setModalData] = useState<TableSnapshot | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [searchTerm, setSearchTerm] = useState('');

  const loadTableData = useCallback(
    async (tableName: string, limit = pageSize, offset = 0) => {
      try {
        setLoading(true);
        setStatusMessage(`Loading ${tableName}...`);
        const resp: TableDataResponse = await api.getTableData(tableName, limit, offset);
        setModalData({
          tableName,
          columns: resp.columns.map(c => c.name),
          rows: resp.rows,
          totalRows: resp.total_rows,
          limit: resp.limit,
          offset: resp.offset,
        });
        setShowTableModal(true);
        setStatusMessage(`Loaded ${resp.rows.length} rows from ${tableName}`);
      } catch (e) {
        setStatusMessage(`Failed to load: ${e}`);
      } finally {
        setLoading(false);
      }
    },
    [pageSize, setLoading, setStatusMessage]
  );

  const handlePagination = useCallback(
    (direction: 'next' | 'prev') => {
      if (!modalData) return;
      const newOffset =
        direction === 'next'
          ? modalData.offset + modalData.limit
          : Math.max(0, modalData.offset - modalData.limit);
      loadTableData(modalData.tableName, modalData.limit, newOffset);
    },
    [modalData, loadTableData]
  );

  const handlePageSizeChange = useCallback(
    (n: number) => {
      setPageSize(n);
      if (modalData) loadTableData(modalData.tableName, n, 0);
    },
    [modalData, loadTableData]
  );

  const filteredRows = useMemo(() => {
    if (!modalData) return [] as (string | null)[][];
    if (!searchTerm) return modalData.rows;
    const needle = searchTerm.toLowerCase();
    return modalData.rows.filter(row =>
      row.some(cell => cell !== null && cell.toLowerCase().includes(needle))
    );
  }, [modalData, searchTerm]);

  const exportTableData = () => {
    if (!modalData) return;
    const escape = (v: string) =>
      /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [
      modalData.columns.map(escape).join(','),
      ...modalData.rows.map(row => row.map(c => escape(cellText(c))).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${modalData.tableName}_data.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMessage(`Exported ${modalData.tableName}`);
  };

  return (
    <div className="h-full flex flex-col bg-card rounded-lg border border-border">
      <div className="px-4 py-4 border-b border-border flex items-center gap-3">
        <h3 className="m-0 text-foreground text-base font-semibold">Data Explorer</h3>
        <button
          className="btn btn-secondary btn-sm"
          onClick={refreshSchema}
          disabled={!dbConnected}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </button>
      </div>

      <div className="flex-1 px-4 py-4 overflow-y-auto min-h-0">
        {!dbConnected ? (
          <div className="text-center text-muted-foreground py-8">
            Connect to a database to explore tables
          </div>
        ) : tables.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">No tables found</div>
        ) : (
          <div className="space-y-1">
            {tables.map(table => (
              <div
                key={table}
                className="px-3 py-2 text-sm font-medium hover:bg-accent transition-colors cursor-pointer text-left rounded"
                onClick={() => loadTableData(table)}
              >
                {table}
              </div>
            ))}
          </div>
        )}
      </div>

      {showTableModal && modalData && (
        <div className="modal-overlay" onClick={() => setShowTableModal(false)}>
          <div
            className="modal table-data-modal"
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Table: {modalData.tableName}</h3>
              <button className="modal-close" onClick={() => setShowTableModal(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="table-controls">
                <div className="search-container">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search current page..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                  />
                </div>
                <div className="page-size-container">
                  <label className="page-size-label">Rows per page:</label>
                  <select
                    className="page-size-select"
                    value={pageSize}
                    onChange={e => handlePageSizeChange(Number(e.target.value))}
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
                  {modalData.totalRows.toLocaleString()} total
                </span>
                {searchTerm && (
                  <span className="info-badge">{filteredRows.length} filtered</span>
                )}
                <span className="info-badge">
                  {modalData.offset + 1}-
                  {Math.min(modalData.offset + pageSize, modalData.totalRows)}
                </span>
              </div>

              <div className="data-table-container overflow-auto max-h-[55vh]">
                <table className="data-table">
                  <thead>
                    <tr>
                      {modalData.columns.map(col => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((row, idx) => (
                      <tr key={idx}>
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx} title={cellText(cell)}>
                            {cellText(cell)}
                          </td>
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
                  disabled={modalData.offset === 0}
                >
                  Previous
                </button>
                <span className="pagination-info">
                  {modalData.offset + 1}-
                  {Math.min(modalData.offset + modalData.limit, modalData.totalRows)} of{' '}
                  {modalData.totalRows}
                </span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handlePagination('next')}
                  disabled={
                    modalData.offset + modalData.limit >= modalData.totalRows
                  }
                >
                  Next
                </button>
              </div>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={exportTableData}>
                  Export CSV
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setShowTableModal(false)}
                >
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
