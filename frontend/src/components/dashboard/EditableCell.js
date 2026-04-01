import { useState, useEffect, useRef } from "react";
import { useLang } from "../../contexts/LanguageContext";
import { Edit2, ExternalLink } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { getStatusColor, evaluateFormula } from "../../lib/constants";
import { ColoredBadge } from "./ColoredBadge";

export const EditableCell = ({ value, field, orderId, options, onUpdate, type = "text", isDark, allOrders, columns: allCols, readOnly = false }) => {
  const { t } = useLang();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value || "");
  const [editUrl, setEditUrl] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { setEditValue(value || ""); }, [value]);
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      if (type === "text" || type === "link") inputRef.current.select();
    }
  }, [isEditing, type]);
  useEffect(() => {
    if (isEditing && type === 'link_desc') {
      const parsed = parseLinkDesc(value);
      setEditUrl(parsed.url);
      setEditDesc(parsed.desc);
    }
  }, [isEditing, type, value]);

  const parseLinkDesc = (val) => {
    if (!val) return { url: '', desc: '' };
    if (typeof val === 'object') return { url: val.url || '', desc: val.desc || '' };
    return { url: val, desc: '' };
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") { setEditValue(value || ""); setIsEditing(false); }
  };

  if (readOnly) {
    if (type === 'checkbox') return <div className="flex items-center justify-center min-h-[32px]"><input type="checkbox" checked={!!value} disabled className="w-5 h-5 rounded border-border opacity-60" /></div>;
    if (type === 'link_desc') {
      const p = parseLinkDesc(value);
      if (!p.url && !p.desc) return <span className="text-muted-foreground text-sm">—</span>;
      const label = p.desc || p.url.replace(/^https?:\/\//, '').split('/')[0] || '—';
      if (p.url) return <a href={p.url.startsWith('http') ? p.url : `https://${p.url}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-sm truncate block px-1" onClick={(e) => e.stopPropagation()}>{label}</a>;
      return <span className="text-sm text-foreground/70 px-1 truncate block">{label}</span>;
    }
    if (options && options.length > 0) {
      const color = getStatusColor(value) || (isDark ? { bg: '#374151', text: '#D1D5DB' } : { bg: '#F3F4F6', text: '#374151' });
      return <span className="px-2.5 py-1 rounded text-xs font-bold whitespace-nowrap" style={{ backgroundColor: color.bg, color: color.text }}>{value || '—'}</span>;
    }
    return <span className="text-sm text-foreground/70">{value || '—'}</span>;
  }

  // link_desc editing and display
  if (type === 'link_desc') {
    if (isEditing) {
      const saveLinkDesc = () => {
        const newVal = (editUrl.trim() || editDesc.trim()) ? { url: editUrl.trim(), desc: editDesc.trim() } : '';
        onUpdate(orderId, field, newVal);
        setIsEditing(false);
      };
      return (
        <div className="flex flex-col gap-1 p-1 min-w-[180px]">
          <input ref={inputRef} type="url" value={editUrl} onChange={(e) => setEditUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveLinkDesc(); if (e.key === 'Escape') setIsEditing(false); }}
            placeholder="https://..." className="w-full h-7 bg-secondary border border-primary rounded px-2 text-xs text-foreground" />
          <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveLinkDesc(); if (e.key === 'Escape') setIsEditing(false); }}
            placeholder="Descripcion..." className="w-full h-7 bg-secondary border border-border rounded px-2 text-xs text-foreground" />
          <div className="flex gap-1">
            <button onClick={saveLinkDesc} className="flex-1 px-2 py-0.5 bg-primary text-primary-foreground rounded text-[10px]">OK</button>
            <button onClick={() => setIsEditing(false)} className="px-2 py-0.5 bg-secondary border border-border rounded text-[10px]">Esc</button>
          </div>
        </div>
      );
    }
    const p = parseLinkDesc(value);
    if (p.url || p.desc) {
      const label = p.desc || p.url.replace(/^https?:\/\//, '').split('/')[0] || '—';
      return (
        <div className="min-h-[32px] flex items-center gap-1 px-1 group">
          {p.url ? (
            <a href={p.url.startsWith('http') ? p.url : `https://${p.url}`} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline text-sm truncate flex-1" onClick={(e) => e.stopPropagation()} data-testid={`link-cell-${field}`}>{label}</a>
          ) : (
            <span className="text-sm text-foreground truncate flex-1">{label}</span>
          )}
          <button onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
            className="p-0.5 hover:bg-secondary rounded opacity-0 group-hover:opacity-100 flex-shrink-0" title={t('edit_link')}>
            <Edit2 className="w-3 h-3 text-muted-foreground" />
          </button>
        </div>
      );
    }
    return (
      <div onClick={() => setIsEditing(true)}
        className="cursor-pointer min-h-[32px] flex items-center px-1 hover:bg-secondary/50 rounded transition-colors">
        <span className="text-muted-foreground text-sm">+ Link</span>
      </div>
    );
  }

  if (isEditing) {
    if (options && options.length > 0) {
      return (
        <Select 
          value={editValue || 'none'} 
          open={true}
          onOpenChange={(open) => {
            if (!open) setIsEditing(false);
          }}
          onValueChange={(v) => {
            const newVal = v === 'none' ? '' : v;
            setEditValue(newVal);
            onUpdate(orderId, field, newVal);
            setIsEditing(false);
          }}
        >
          <SelectTrigger ref={inputRef} className="h-8 bg-secondary border-primary text-sm min-w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border z-[300] max-h-[300px]">
            <SelectItem value="none">- Ninguno -</SelectItem>
            {options.map(opt => (
              <SelectItem key={opt} value={opt}>
                <div className="flex items-center gap-2">
                  {getStatusColor(opt) && <span className="w-3 h-3 rounded" style={{ backgroundColor: getStatusColor(opt).bg }}></span>}
                  {opt}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (type === "date") {
      return (
        <input ref={inputRef} type="date" value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => { if (editValue !== value) onUpdate(orderId, field, editValue); setIsEditing(false); }}
          onKeyDown={handleKeyDown}
          className="w-full h-8 bg-secondary border border-primary rounded px-2 text-sm text-foreground min-w-[120px]" />
      );
    }
    if (type === "number") {
      return (
        <input ref={inputRef} type="number" value={editValue} onChange={(e) => setEditValue(e.target.value)}
          onBlur={() => { if (editValue !== value) onUpdate(orderId, field, parseInt(editValue) || 0); setIsEditing(false); }}
          onKeyDown={handleKeyDown}
          className="w-full h-8 bg-secondary border border-primary rounded px-2 text-sm text-foreground font-mono min-w-[80px]" />
      );
    }
    return (
      <input ref={inputRef} type="url" value={editValue} onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => { if (editValue !== value) onUpdate(orderId, field, editValue); setIsEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { if (editValue !== value) onUpdate(orderId, field, editValue); setIsEditing(false); }
          handleKeyDown(e);
        }}
        placeholder={type === 'link' ? 'https://...' : ''}
        className="w-full h-8 bg-secondary border border-primary rounded px-2 text-sm text-foreground min-w-[120px]" />
    );
  }

  const isSelectField = options && options.length > 0;

  if (type === 'checkbox') {
    return (
      <div className="flex items-center justify-center min-h-[32px]">
        <input type="checkbox" checked={!!value} onChange={(e) => onUpdate(orderId, field, e.target.checked)}
          className="w-5 h-5 rounded border-border accent-primary cursor-pointer" data-testid={`checkbox-${field}-${orderId}`} />
      </div>
    );
  }

  if (type === 'formula') {
    const order = allOrders?.find(o => o.order_id === orderId);
    let result = '';
    if (order) { try { result = evaluateFormula(field, order, allCols); } catch { result = '#ERROR'; } }
    return (
      <div className="min-h-[32px] flex items-center px-1 font-mono text-sm text-primary" title={t('calculated_value')} data-testid={`formula-${field}-${orderId}`}>
        {result !== '' && result !== undefined ? result : '-'}
      </div>
    );
  }

  if (type === 'link' && value) {
    return (
      <div className="flex items-center gap-1 min-h-[32px] px-1">
        <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noopener noreferrer"
          className="text-primary hover:underline text-sm truncate max-w-[150px]" title={value}
          onClick={(e) => e.stopPropagation()} data-testid={`link-cell-${field}`}>
          <ExternalLink className="w-3.5 h-3.5 inline mr-1" />
          {value.replace(/^https?:\/\//, '').split('/')[0]}
        </a>
        <button onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
          className="p-0.5 hover:bg-secondary rounded opacity-0 group-hover:opacity-100" title={t('edit_link')}>
          <Edit2 className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div onClick={() => setIsEditing(true)}
      className="cursor-pointer min-h-[32px] flex items-center px-1 hover:bg-secondary/50 rounded transition-colors group" title={t('click_to_edit')}>
      {isSelectField ? <ColoredBadge value={value} isDark={isDark} /> :
       type === 'link' ? <span className="text-muted-foreground text-sm">+ {t('link')}</span> :
       (value || <span className="text-muted-foreground">-</span>)}
    </div>
  );
};
