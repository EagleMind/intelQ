import React from 'react';
import { useAnnotations } from '../../store/AnnotationContext';

interface Props {
  tableName: string;
  className?: string;
}

const AnnotationBadge: React.FC<Props> = ({ tableName, className = '' }) => {
  const { tablesWithAnnotations, annotationsForTable } = useAnnotations();
  if (!tablesWithAnnotations.has(tableName)) return null;

  const anns = annotationsForTable(tableName);
  const hasAll = anns.some(a => a.scope === 'table');
  const title = hasAll
    ? `${anns.length} annotation${anns.length !== 1 ? 's' : ''}`
    : `${anns.length} column annotation${anns.length !== 1 ? 's' : ''}`;

  return (
    <span
      title={title}
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
        hasAll ? 'bg-primary' : 'bg-warning'
      } ${className}`}
    />
  );
};

export default AnnotationBadge;
