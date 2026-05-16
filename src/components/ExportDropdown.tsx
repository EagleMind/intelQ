import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import {
  availableExporters,
  exportAs,
  type ExportPayload,
} from '../services/exporters';

interface ExportDropdownProps {
  payload: ExportPayload;
  disabled?: boolean;
  onExported?: (format: string) => void;
}

const ExportDropdown: React.FC<ExportDropdownProps> = ({
  payload,
  disabled,
  onExported,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const exporters = availableExporters();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handlePick = (format: string) => {
    setOpen(false);
    if (exportAs(format, payload)) {
      onExported?.(format);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        className="btn btn-secondary flex items-center gap-2"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download className="w-4 h-4" />
        <span>Export</span>
        <ChevronDown className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 min-w-[140px] bg-[#1e1e1e] border border-[#404040] rounded-lg shadow-lg z-20 overflow-hidden"
        >
          {exporters.map(exp => (
            <button
              key={exp.format}
              role="menuitem"
              onClick={() => handlePick(exp.format)}
              className="block w-full text-left px-3 py-2 text-sm text-[#cccccc] hover:bg-[#2d2d2d]"
            >
              {exp.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ExportDropdown;
