import React, { useEffect, useRef, useState } from 'react';
import { useAnnotations } from '../../store/AnnotationContext';

interface Props {
  tableName: string;
  scope: 'table' | 'column';
  columnName?: string;
  placeholder?: string;
  onSaved?: () => void;
}

const MAX_CHARS = 500;

const AnnotationEditor: React.FC<Props> = ({
  tableName,
  scope,
  columnName,
  placeholder,
  onSaved,
}) => {
  const { tableAnnotation, columnAnnotation, save, remove, saving } = useAnnotations();

  const existing =
    scope === 'table'
      ? tableAnnotation(tableName)
      : columnAnnotation(tableName, columnName ?? '');

  const [text, setText] = useState(existing?.body ?? '');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync from store when the annotation changes externally (e.g. after fetchNative).
  useEffect(() => {
    if (!dirty) setText(existing?.body ?? '');
  }, [existing?.body, dirty]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value.slice(0, MAX_CHARS));
    setDirty(true);
    setError(null);
  };

  const handleSave = async () => {
    if (!text.trim() && existing) {
      await remove(existing.id);
      setText('');
      setDirty(false);
      onSaved?.();
      return;
    }
    if (!text.trim()) return;
    try {
      await save(tableName, scope, text.trim(), columnName);
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDiscard = () => {
    setText(existing?.body ?? '');
    setDirty(false);
    setError(null);
  };

  const defaultPlaceholder =
    scope === 'table'
      ? 'Describe what this table stores, its purpose, relationships…'
      : 'Describe what this column means, units, allowed values…';

  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={textareaRef}
        className="form-input resize-none text-sm"
        rows={scope === 'table' ? 3 : 2}
        value={text}
        onChange={handleChange}
        placeholder={placeholder ?? defaultPlaceholder}
        maxLength={MAX_CHARS}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {text.length} / {MAX_CHARS}
        </span>
        {dirty && (
          <div className="flex gap-2">
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleDiscard}
              disabled={saving}
            >
              Discard
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || !text.trim()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
};

export default AnnotationEditor;
