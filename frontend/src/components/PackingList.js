import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Printer, FileText, Download, Home, Box, Globe } from 'lucide-react';
import { API } from '../lib/constants';
import '../styles/packing.css';

const SIZE_KEYS = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl', 'xxxxl'];
const SIZE_LABELS = ['XS or OSFA', 'SM', 'MD', 'LG', 'XL', '2XL', '3XL', '4XL'];

const SUMMARY_ROWS_DEF = [
    { id: 'totalShipped', label: 'TOTAL SHIPPED:', readonly: true },
    { id: 'ejemplosLicense', label: 'SAMPLES/LICENSE', readonly: false },
    { id: 'orderedQty', label: 'ORDERED QTY:', readonly: false },
    { id: 'difference', label: 'DIFFERENCE:', readonly: true },
    { id: 'damagedMisprint', label: 'DAMAGED (Misprint):', readonly: false },
    { id: 'damagedGarment', label: 'DAMAGED (Garment):', readonly: false },
    { id: 'extra', label: 'Extra:', readonly: false }
];

const STORE_OPTIONS = [
    'SPIRIT', 'SPENCERS', "BUC-EE'S", 'TRACTOR SUPPLY', 'ROSS', 'TARGET', 'HOT TOPIC',
    'FASHION NOVA', 'PACSUN', 'FOREVER 21', 'URBAN OUTFITTERS', 'MEIJER', 'BUCKLE',
    'TILLYS', 'AEROPOSTALE', "ALTARD'S STATE", 'FRED MEYER', 'AMERICAN WHOLESALE',
    'MARDEL', 'NORDSTROM', 'FOCO', 'TREVCO', 'JAKO ENTERPRISES', 'MIDSTATES', 'WALMART',
    'TJMAX', 'MARSHALLS', 'BRUCE SPRINGSTEEN', "DD'S", 'ULTRA', 'MANDEE', 'JC PENNEY'
];

const CLIENT_OPTIONS = ['GOODIE TWO SLEEVES', 'SCREENWORKS', 'ROCK REBEL'];

const PERC_OPTIONS = [
    '-', '100% Cotton', '100% Cotton Combed', '60% Cotton - 40% Polyester', '90% Cotton - 10% Polyester',
    '50% Cotton - 50% Polyester', '52% Cotton - 48% Polyester', '50%Poliester - 25%Algodon - 25%Rayon',
    '65% polyester - 35% cotton', '95% cotton - 5% elastane', '100% Polyester', '52% Combed Cotton - 48% Polyester',
    '80% Cotton - 20% Polyester', '60% Combed Cotton - 40% Polyester', '70% Cotton - 30% Polyester',
    '100% Combed Cotton', '55% Cotton - 45%Polyester', '95% Polyester - 5% Elastane',
    '57% Cotton - 38% Polyester - 5% Spandex', '100% Cotton Ring Spun', '52% Cotton - 48% Recycled Polyester'
];

const ORIG_OPTIONS = [
    '-', 'Bangladesh', 'Pakistan', 'Haiti', 'Honduras', 'El Salvador', 'Rep. Dominicana', 'India',
    'Nicaragua', 'China', 'Guatemala', 'CAMBOYA', 'GHANA', 'MADAGASCAR', 'MEXICO', 'MYANMAR', 'TAIWAN', 'USA', 'VIETNAM'
];

export default function PackingListTool() {
    const [activeTab, setActiveTab] = useState('packing_summary');
    const [isLoading, setIsLoading] = useState(false);

    const tableBodyRef = useRef(null);
    const focusNewRowRef = useRef(false);

    // Form State
    const [meta, setMeta] = useState({
        vendorPO: '', clientPO: '', storeName: '', client: '', datePacked: '', packerName: '',
        newBoxes: 0, recycledBoxes: 0, pickingDate: '', pickerNameWarehouse: '', dynamicTitle: 'Packing List', note: ''
    });

    // Update dynamic title when vendorPO or client changes
    useEffect(() => {
        let parts = [];
        if (meta.vendorPO) parts.push(meta.vendorPO);
        if (meta.client) parts.push(meta.client);
        parts.push('Packing List');
        setMeta(prev => ({ ...prev, dynamicTitle: parts.join(' - ') }));
    }, [meta.vendorPO, meta.client]);

    const handleMetaChange = (e) => {
        const { name, value } = e.target;
        setMeta(prev => ({ ...prev, [name]: value }));
    };

    // Main Table Rows
    const createEmptyRow = () => ({
        id: Date.now() + Math.random(),
        storePO: '', designCode: '', garmentType: '', garmentColor: '',
        xs: '', sm: '', md: '', lg: '', xl: '', xxl: '', xxxl: '', xxxxl: '',
        boxQty: '', pcsPerBox: '', newBoxes: false, recycledBoxes: false, boxDim: '', boxWeight: '', palletNo: '', palletDim: ''
    });

    const [rows, setRows] = useState([createEmptyRow()]);

    const addRow = () => setRows(prev => [...prev, createEmptyRow()]);

    const addRowAndFocus = () => {
        focusNewRowRef.current = true;
        setRows(prev => [...prev, createEmptyRow()]);
    };

    const removeRow = (id) => {
        setRows(prev => {
            const remaining = prev.filter(r => r.id !== id);
            return remaining.length === 0 ? [createEmptyRow()] : remaining;
        });
    };

    const handleRowChange = (id, field, value) => {
        setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
    };

    const handleCheckboxChange = (id, field) => {
        setRows(prev => prev.map(r => {
            if (r.id === id) {
                if (field === 'newBoxes') return { ...r, newBoxes: !r.newBoxes, recycledBoxes: false };
                if (field === 'recycledBoxes') return { ...r, recycledBoxes: !r.recycledBoxes, newBoxes: false };
            }
            return r;
        }));
    };

    // Focus the first input of the newly added row (Enter key behaviour)
    useEffect(() => {
        if (focusNewRowRef.current && tableBodyRef.current) {
            focusNewRowRef.current = false;
            const lastTr = tableBodyRef.current.lastElementChild;
            if (lastTr) {
                const first = lastTr.querySelector('input');
                if (first) first.focus();
            }
        }
    }, [rows]);

    // Auto-compute New vs Recycled box totals
    useEffect(() => {
        let nBoxes = 0;
        let rBoxes = 0;
        rows.forEach(r => {
            const bQty = parseInt(r.boxQty) || 0;
            if (r.newBoxes) nBoxes += bQty;
            if (r.recycledBoxes) rBoxes += bQty;
        });
        setMeta(prev => ({ ...prev, newBoxes: nBoxes, recycledBoxes: rBoxes }));
    }, [rows]);

    // Keyboard handling on main table cells (Enter = add row, Delete = remove empty, arrows = navigate)
    const handleCellKeyDown = (e, rowId) => {
        const input = e.target;
        const tr = input.closest('tr');
        if (!tr) return;
        const inputs = Array.from(tr.querySelectorAll('input'));
        const currentIndex = inputs.indexOf(input);

        if (e.key === 'Enter') {
            e.preventDefault();
            addRowAndFocus();
            return;
        }
        if (e.key === 'Delete') {
            if (input.value === '') {
                e.preventDefault();
                removeRow(rowId);
            }
            return;
        }
        if (e.key === 'ArrowRight') {
            const next = inputs[currentIndex + 1];
            if (next) next.focus();
        } else if (e.key === 'ArrowLeft') {
            const prev = inputs[currentIndex - 1];
            if (prev) prev.focus();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const nextTr = tr.nextElementSibling;
            if (nextTr) {
                const target = nextTr.querySelectorAll('input')[currentIndex];
                if (target) target.focus();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prevTr = tr.previousElementSibling;
            if (prevTr) {
                const target = prevTr.querySelectorAll('input')[currentIndex];
                if (target) target.focus();
            }
        }
    };

    // Summary Grid State
    const [summaryData, setSummaryData] = useState(() => {
        const init = {};
        SUMMARY_ROWS_DEF.forEach(r => {
            init[r.id] = { id: r.id, label: r.label, xs: '', sm: '', md: '', lg: '', xl: '', xxl: '', xxxl: '', xxxxl: '' };
        });
        return init;
    });

    const handleSummaryChange = (rowId, sz, value) => {
        setSummaryData(prev => ({
            ...prev,
            [rowId]: { ...prev[rowId], [sz]: value }
        }));
    };

    // Arrow navigation inside the summary grid (matches the source app)
    const handleSummaryKeyDown = (e) => {
        const input = e.target;
        const tr = input.closest('tr');
        if (!tr) return;
        const sz = input.dataset.sz;

        if (e.key === 'ArrowRight') {
            const inputs = Array.from(tr.querySelectorAll('input.sg-input:not([readonly])'));
            const i = inputs.indexOf(input);
            if (inputs[i + 1]) inputs[i + 1].focus();
        } else if (e.key === 'ArrowLeft') {
            const inputs = Array.from(tr.querySelectorAll('input.sg-input:not([readonly])'));
            const i = inputs.indexOf(input);
            if (inputs[i - 1]) inputs[i - 1].focus();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const nextTr = tr.nextElementSibling;
            if (nextTr) {
                const target = nextTr.querySelector(`input[data-sz="${sz}"]:not([readonly])`);
                if (target) target.focus();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const prevTr = tr.previousElementSibling;
            if (prevTr) {
                const target = prevTr.querySelector(`input[data-sz="${sz}"]:not([readonly])`);
                if (target) target.focus();
            }
        }
    };

    // Size Tables (Warehouse)
    const [sizeTables, setSizeTables] = useState(() => {
        const init = {};
        SIZE_LABELS.forEach(sz => {
            init[sz] = [
                { id: 1, perc: '-', orig: '-', qty: '' },
                { id: 2, perc: '-', orig: '-', qty: '' },
                { id: 3, perc: '-', orig: '-', qty: '' }
            ];
        });
        return init;
    });

    const handleSizeTableChange = (sz, rowId, field, value) => {
        setSizeTables(prev => ({
            ...prev,
            [sz]: prev[sz].map(r => r.id === rowId ? { ...r, [field]: value } : r)
        }));
    };

    // RESIZE: rename each size for the Import & Export section (free text per size)
    const [resizeMap, setResizeMap] = useState(() => {
        const init = {};
        SIZE_LABELS.forEach(sz => { init[sz] = ''; });
        return init;
    });

    const handleResizeChange = (sz, value) => {
        setResizeMap(prev => ({ ...prev, [sz]: value }));
    };

    // Effective labels used by Import & Export: new size replaces the original when provided
    const effectiveSizeLabels = useMemo(() => {
        return SIZE_LABELS.map(l => {
            const renamed = (resizeMap[l] || '').trim();
            return renamed || l;
        });
    }, [resizeMap]);

    // Computations
    const computedRows = useMemo(() => {
        return rows.map(r => {
            let total = 0;
            SIZE_KEYS.forEach(sz => total += (parseInt(r[sz]) || 0));
            return { ...r, total };
        });
    }, [rows]);

    const computedSummary = useMemo(() => {
        const result = { ...summaryData };

        // Compute Total Shipped from main rows
        const shipped = { id: 'totalShipped', label: 'TOTAL SHIPPED:', xs: 0, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0, xxxl: 0, xxxxl: 0 };
        computedRows.forEach(r => {
            SIZE_KEYS.forEach(sz => shipped[sz] += (parseInt(r[sz]) || 0));
        });
        result.totalShipped = shipped;

        // Compute Difference
        const diff = { id: 'difference', label: 'DIFFERENCE:', xs: 0, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0, xxxl: 0, xxxxl: 0 };
        const ejemplos = result.ejemplosLicense || {};
        const ordered = result.orderedQty || {};
        SIZE_KEYS.forEach(sz => {
            const s = parseInt(shipped[sz]) || 0;
            const e = parseInt(ejemplos[sz]) || 0;
            const o = parseInt(ordered[sz]) || 0;
            diff[sz] = (s + e) - o;
        });
        result.difference = diff;

        // Add totals to each row
        Object.keys(result).forEach(k => {
            let t = 0;
            SIZE_KEYS.forEach(sz => t += (parseInt(result[k][sz]) || 0));
            result[k].total = t;
        });

        return result;
    }, [summaryData, computedRows]);

    const computedBreakdowns = useMemo(() => {
        const map = {};
        SIZE_LABELS.forEach((szLabel, idx) => {
            const szKey = SIZE_KEYS[idx];
            sizeTables[szLabel].forEach(r => {
                const perc = r.perc;
                const orig = r.orig;
                const qty = parseInt(r.qty) || 0;

                if (qty === 0 && perc === '-' && orig === '-') return;

                const key = `${perc}|${orig}`;
                if (!map[key]) {
                    map[key] = { perc, orig, xs: '', sm: '', md: '', lg: '', xl: '', xxl: '', xxxl: '', xxxxl: '', total: 0 };
                }
                map[key][szKey] = (parseInt(map[key][szKey]) || 0) + qty;
                map[key].total += qty;
            });
        });
        return Object.values(map);
    }, [sizeTables]);

    const grandTotalQty = useMemo(() => {
        return computedBreakdowns.reduce((acc, b) => acc + b.total, 0);
    }, [computedBreakdowns]);

    // Data packaging for API
    const collectData = () => {
        const sGridData = SUMMARY_ROWS_DEF.map(rDef => computedSummary[rDef.id]);

        const sTablesData = SIZE_LABELS.map(sz => {
            const tRows = sizeTables[sz];
            const total = tRows.reduce((acc, r) => acc + (parseInt(r.qty) || 0), 0);
            return { size: sz, rows: tRows, total };
        });

        return {
            meta: { ...meta, pickerName: meta.pickerNameWarehouse },
            rows: computedRows,
            summaryGridData: sGridData,
            breakdowns: computedBreakdowns,
            sizeTablesData: sTablesData,
            sizeLabels: effectiveSizeLabels,
            grandTotalQty
        };
    };

    const handleExport = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`${API}/packing/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(collectData())
            });
            if (res.ok) {
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${meta.dynamicTitle || 'Packing List'}.xlsx`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            } else {
                alert('Export failed');
            }
        } catch (error) {
            console.error(error);
            alert('Export error');
        } finally {
            setIsLoading(false);
        }
    };

    const handlePrint = (endpoint) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = `${API}/packing/${endpoint}`;
        form.target = '_blank';

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'data';
        input.value = JSON.stringify(collectData());
        form.appendChild(input);

        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    };

    return (
        <div className="packing-container">
            {isLoading && (
                <div className="overlay" style={{ display: 'flex' }}>
                    <div className="spinner"></div>
                    <p>Generating Excel file...</p>
                </div>
            )}

            <div className="container">
                <header className="header">
                    <div className="logo-area">
                        <img src="/prosper_logo.jpg" alt="Prosper Logo" />
                        <input
                            type="text"
                            className="title-input"
                            value={meta.dynamicTitle}
                            onChange={(e) => setMeta({ ...meta, dynamicTitle: e.target.value })}
                        />
                    </div>
                    <div className="actions" style={{ display: 'flex', gap: '12px' }}>
                        <button type="button" className="btn-secondary" onClick={() => handlePrint('preview')}>
                            <Printer size={20} /> Imprimir
                        </button>
                        <button
                            type="button"
                            className="btn-secondary"
                            style={{ backgroundColor: '#6366f1', color: 'white', border: 'none' }}
                            onClick={() => handlePrint('pallet_label')}
                        >
                            <FileText size={20} /> Generar Papeleta
                        </button>
                        <button type="button" className="btn-primary" onClick={handleExport}>
                            <Download size={20} /> Guardar Excel
                        </button>
                    </div>
                </header>

                <nav className="tab-navigation">
                    <button type="button" className={`tab-btn ${activeTab === 'packing_summary' ? 'active' : ''}`} onClick={() => setActiveTab('packing_summary')}>
                        <Home size={20} /> Packing Department
                    </button>
                    <button type="button" className={`tab-btn ${activeTab === 'warehouse' ? 'active' : ''}`} onClick={() => setActiveTab('warehouse')}>
                        <Box size={20} /> Warehouse
                    </button>
                    <button type="button" className={`tab-btn ${activeTab === 'import_export' ? 'active' : ''}`} onClick={() => setActiveTab('import_export')}>
                        <Globe size={20} /> Import &amp; Export
                    </button>
                </nav>

                <form id="packingForm" onSubmit={(e) => e.preventDefault()}>
                    {/* Packing Department Tab */}
                    <div className={`tab-content ${activeTab === 'packing_summary' ? 'active' : ''}`}>
                        <section className="meta-section card" style={{ marginBottom: '24px' }}>
                            <h2 style={{ marginBottom: '20px', borderBottom: '2px solid var(--primary-color)', paddingBottom: '8px' }}>Packing Department</h2>
                            <div className="grid-layout">
                                <div className="form-group">
                                    <label htmlFor="vendorPO">VENDOR PO</label>
                                    <input type="text" id="vendorPO" name="vendorPO" value={meta.vendorPO} onChange={handleMetaChange} placeholder="e.g. PO-1234" />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="clientPO">CLIENT PO</label>
                                    <input type="text" id="clientPO" name="clientPO" value={meta.clientPO} onChange={handleMetaChange} placeholder="e.g. CPO-5678" />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="storeName">STORE NAME</label>
                                    <select id="storeName" name="storeName" className="custom-select" value={meta.storeName} onChange={handleMetaChange}>
                                        <option value="">-- Select --</option>
                                        {STORE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="client">Client</label>
                                    <select id="client" name="client" className="custom-select" value={meta.client} onChange={handleMetaChange}>
                                        <option value="">-- Select --</option>
                                        {CLIENT_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label htmlFor="datePacked">Date Packed:</label>
                                    <input type="date" id="datePacked" name="datePacked" value={meta.datePacked} onChange={handleMetaChange} />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="packerName">Packer Name:</label>
                                    <input type="text" id="packerName" name="packerName" value={meta.packerName} onChange={handleMetaChange} placeholder="Your Name" />
                                </div>
                            </div>
                        </section>

                        <section className="table-section card">
                            <div className="table-container">
                                <table id="mainTable">
                                    <thead>
                                        <tr>
                                            <th>STORE PO</th>
                                            <th>Design Code</th>
                                            <th>Garment Type</th>
                                            <th>Garment Color</th>
                                            {SIZE_LABELS.map(sz => <th key={sz}>{sz}</th>)}
                                            <th className="highlight-col">TOTAL</th>
                                            <th>Box Qty</th>
                                            <th>Pcs per box</th>
                                            <th className="checkbox-col">New</th>
                                            <th className="checkbox-col">Recycled</th>
                                            <th>Box Dim (LxWxH)</th>
                                            <th>Box Wt (lbs)</th>
                                            <th>Pallet #</th>
                                            <th>Pallet Dim (LxWxH)</th>
                                        </tr>
                                    </thead>
                                    <tbody ref={tableBodyRef}>
                                        {computedRows.map(r => (
                                            <tr key={r.id}>
                                                <td><input type="text" className="text-input" value={r.storePO} placeholder="Store PO" onChange={(e) => handleRowChange(r.id, 'storePO', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.designCode} placeholder="Design" onChange={(e) => handleRowChange(r.id, 'designCode', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.garmentType} placeholder="Type" onChange={(e) => handleRowChange(r.id, 'garmentType', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.garmentColor} placeholder="Color" onChange={(e) => handleRowChange(r.id, 'garmentColor', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                {SIZE_KEYS.map(sz => (
                                                    <td key={sz}><input type="number" min="0" className="size-input" value={r[sz]} placeholder="0" onChange={(e) => handleRowChange(r.id, sz, e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                ))}
                                                <td className="highlight-col"><input type="number" className="size-input row-total readonly-input" readOnly value={r.total} /></td>
                                                <td><input type="number" min="0" className="size-input" value={r.boxQty} placeholder="0" onChange={(e) => handleRowChange(r.id, 'boxQty', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="number" min="0" className="size-input" value={r.pcsPerBox} placeholder="0" onChange={(e) => handleRowChange(r.id, 'pcsPerBox', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td className="checkbox-col"><input type="checkbox" checked={r.newBoxes} onChange={() => handleCheckboxChange(r.id, 'newBoxes')} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td className="checkbox-col"><input type="checkbox" checked={r.recycledBoxes} onChange={() => handleCheckboxChange(r.id, 'recycledBoxes')} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.boxDim} placeholder="L x W x H" onChange={(e) => handleRowChange(r.id, 'boxDim', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="number" step="0.1" className="size-input" value={r.boxWeight} placeholder="0" onChange={(e) => handleRowChange(r.id, 'boxWeight', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.palletNo} placeholder="#" onChange={(e) => handleRowChange(r.id, 'palletNo', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                                <td><input type="text" className="text-input" value={r.palletDim} placeholder="L x W x H" onChange={(e) => handleRowChange(r.id, 'palletDim', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, r.id)} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="table-actions">
                                <button type="button" className="btn-secondary" onClick={addRow}>+ Add Row</button>
                            </div>
                        </section>

                        <section className="summary-grid-section card" style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', marginTop: '24px' }}>
                            <div className="summary-grid-content" style={{ flex: 1, minWidth: 0 }}>
                                <h3>Summary</h3>
                                <div className="table-container">
                                    <table className="styled-table" id="summaryGridTable">
                                        <thead>
                                            <tr>
                                                <th></th>
                                                {SIZE_LABELS.map(sz => <th key={sz}>{sz}</th>)}
                                                <th className="highlight-col">TOTAL</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {SUMMARY_ROWS_DEF.map(rDef => {
                                                const rowData = computedSummary[rDef.id];
                                                return (
                                                    <tr key={rDef.id} data-row-id={rDef.id}>
                                                        <td><strong>{rDef.label}</strong></td>
                                                        {SIZE_KEYS.map(sz => (
                                                            <td key={sz}>
                                                                {rDef.readonly ? (
                                                                    <input type="number" className="sg-input readonly-input" data-sz={sz} readOnly value={rowData[sz] || 0} />
                                                                ) : (
                                                                    <input type="number" min="0" className="sg-input" data-sz={sz} value={rowData[sz]} placeholder="0" onChange={(e) => handleSummaryChange(rDef.id, sz, e.target.value)} onKeyDown={handleSummaryKeyDown} />
                                                                )}
                                                            </td>
                                                        ))}
                                                        <td className="highlight-col"><input type="number" className="sg-total readonly-input" readOnly value={rowData.total} /></td>
                                                    </tr>
                                                );
                                            })}
                                            <tr data-row-id="note">
                                                <td><strong>NOTE:</strong></td>
                                                <td colSpan={SIZE_KEYS.length + 1}>
                                                    <input type="text" className="text-input sg-note" name="note" value={meta.note} placeholder="Additional notes..." onChange={handleMetaChange} />
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                            <div className="box-details-content" style={{ width: '220px', flexShrink: 0, paddingLeft: '20px', borderLeft: '1px solid var(--border-color)' }}>
                                <h3>Box Details</h3>
                                <div className="form-group" style={{ marginTop: '12px' }}>
                                    <label htmlFor="newBoxes">NEW BOXES</label>
                                    <input type="number" id="newBoxes" name="newBoxes" className="readonly-input" readOnly value={meta.newBoxes} />
                                </div>
                                <div className="form-group" style={{ marginTop: '12px' }}>
                                    <label htmlFor="recycledBoxes">RECYCLED BOXES</label>
                                    <input type="number" id="recycledBoxes" name="recycledBoxes" className="readonly-input" readOnly value={meta.recycledBoxes} />
                                </div>
                            </div>
                        </section>
                    </div>

                    {/* Warehouse Tab */}
                    <div className={`tab-content ${activeTab === 'warehouse' ? 'active' : ''}`}>
                        <section className="meta-section card" style={{ marginBottom: '24px' }}>
                            <h2 style={{ marginBottom: '20px', borderBottom: '2px solid var(--primary-color)', paddingBottom: '8px' }}>Warehouse Info</h2>
                            <div className="grid-layout">
                                <div className="form-group">
                                    <label htmlFor="pickingDate">Picking Date</label>
                                    <input type="date" id="pickingDate" name="pickingDate" value={meta.pickingDate} onChange={handleMetaChange} />
                                </div>
                                <div className="form-group">
                                    <label htmlFor="pickerNameWarehouse">Picker Name</label>
                                    <input type="text" id="pickerNameWarehouse" name="pickerNameWarehouse" value={meta.pickerNameWarehouse} onChange={handleMetaChange} placeholder="Picker's Name" />
                                </div>
                            </div>
                        </section>

                        <div className="card breakdown-card">
                            <h3>Sizes Breakdown by Material &amp; Origin (Warehouse)</h3>
                            <div className="size-tables-grid">
                                {SIZE_LABELS.map(sz => {
                                    const tRows = sizeTables[sz];
                                    const tTotal = tRows.reduce((a, b) => a + (parseInt(b.qty) || 0), 0);
                                    return (
                                        <div key={sz} className="size-table-container">
                                            <h4>SIZE {sz}</h4>
                                            <table className="styled-table size-table" style={{ tableLayout: 'fixed' }}>
                                                <colgroup>
                                                    <col style={{ width: '45%' }} />
                                                    <col style={{ width: '35%' }} />
                                                    <col style={{ width: '20%' }} />
                                                </colgroup>
                                                <thead>
                                                    <tr>
                                                        <th>Percentage</th>
                                                        <th>Country of Origin</th>
                                                        <th>Qty</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {tRows.map(tr => (
                                                        <tr key={tr.id} className="b-row">
                                                            <td><select className="select-input b-perc" value={tr.perc} onChange={(e) => handleSizeTableChange(sz, tr.id, 'perc', e.target.value)}>{PERC_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select></td>
                                                            <td><select className="select-input b-orig" value={tr.orig} onChange={(e) => handleSizeTableChange(sz, tr.id, 'orig', e.target.value)}>{ORIG_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select></td>
                                                            <td><input type="number" min="0" className="size-input b-qty" value={tr.qty} placeholder="0" onChange={(e) => handleSizeTableChange(sz, tr.id, 'qty', e.target.value)} /></td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                                <tfoot>
                                                    <tr>
                                                        <td style={{ background: '#e0e8f7' }}></td>
                                                        <td style={{ textAlign: 'right', fontWeight: 'bold', background: '#e0e8f7' }}>Total:</td>
                                                        <td className="b-table-total" style={{ fontWeight: 'bold', background: '#e0e8f7', textAlign: 'center' }}>{tTotal}</td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="card breakdown-card">
                            <h3>RESIZE</h3>
                            <div className="size-table-container" style={{ maxWidth: '400px' }}>
                                <table className="styled-table">
                                    <thead>
                                        <tr>
                                            <th>Size</th>
                                            <th>New size</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {SIZE_LABELS.map(sz => (
                                            <tr key={sz}>
                                                <td style={{ fontWeight: 700, paddingLeft: '8px' }}>{sz}</td>
                                                <td><input type="text" value={resizeMap[sz]} placeholder="New size..." onChange={(e) => handleResizeChange(sz, e.target.value)} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    {/* Import & Export Tab */}
                    <div className={`tab-content ${activeTab === 'import_export' ? 'active' : ''}`}>
                        <div className="card">
                            <h3>Summary (Import &amp; Export)</h3>
                            <div className="table-container summary-table-container">
                                <table id="summaryTable" className="styled-table">
                                    <thead>
                                        <tr>
                                            <th>Percentage</th>
                                            <th>Country of Origin</th>
                                            {effectiveSizeLabels.map((sz, i) => <th key={i}>{sz}</th>)}
                                            <th className="highlight-col">TOTAL</th>
                                        </tr>
                                    </thead>
                                    <tbody id="summaryTableBody">
                                        {computedBreakdowns.map((bd, i) => (
                                            <tr key={i}>
                                                <td>{bd.perc}</td>
                                                <td>{bd.orig}</td>
                                                {SIZE_KEYS.map(sz => <td key={sz} style={{ textAlign: 'center' }}>{bd[sz] || ''}</td>)}
                                                <td style={{ fontWeight: 'bold', textAlign: 'center' }}>{bd.total}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            <td colSpan={10} style={{ textAlign: 'right', fontWeight: 'bold' }}>Total Qty:</td>
                                            <td id="grandTotalQty" className="highlight-col" style={{ fontWeight: 'bold', textAlign: 'center' }}>{grandTotalQty}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
