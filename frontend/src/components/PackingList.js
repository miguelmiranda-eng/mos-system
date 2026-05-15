import React, { useState, useEffect, useMemo } from 'react';
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

    const addRow = () => setRows([...rows, createEmptyRow()]);
    const removeRow = (id) => setRows(rows.filter(r => r.id !== id));

    const handleRowChange = (id, field, value) => {
        setRows(rows.map(r => r.id === id ? { ...r, [field]: value } : r));
    };

    const handleCheckboxChange = (id, field) => {
        setRows(rows.map(r => {
            if (r.id === id) {
                if (field === 'newBoxes') return { ...r, newBoxes: !r.newBoxes, recycledBoxes: false };
                if (field === 'recycledBoxes') return { ...r, recycledBoxes: !r.recycledBoxes, newBoxes: false };
            }
            return r;
        }));
    };

    // Auto-calculate newBoxes and recycledBoxes total
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
                a.download = `${meta.dynamicTitle || 'Packing_List'}.xlsx`;
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
        <div className="packing-container bg-background min-h-screen text-foreground p-4">
            {isLoading && (
                <div className="overlay" style={{ display: 'flex' }}>
                    <div className="spinner"></div>
                    <p>Generating Excel file...</p>
                </div>
            )}
            
            <header className="header flex justify-between items-center mb-6">
                <div className="logo-area flex items-center gap-4">
                    <input type="text" className="title-input text-xl font-bold bg-transparent border-b border-border focus:outline-none" value={meta.dynamicTitle} onChange={(e) => setMeta({...meta, dynamicTitle: e.target.value})} />
                </div>
                <div className="actions flex gap-3">
                    <button onClick={() => handlePrint('preview')} className="btn-secondary px-4 py-2 border rounded-lg hover:bg-muted transition-colors">Imprimir</button>
                    <button onClick={() => handlePrint('pallet_label')} className="btn-secondary px-4 py-2 bg-royal text-white rounded-lg hover:bg-royal/90 transition-colors border-none">Generar Papeleta</button>
                    <button onClick={handleExport} className="btn-primary px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">Guardar Excel</button>
                </div>
            </header>

            <nav className="tab-navigation mb-6 flex gap-2 border-b border-border pb-2">
                <button onClick={() => setActiveTab('packing_summary')} className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${activeTab === 'packing_summary' ? 'bg-royal text-white' : 'hover:bg-muted text-muted-foreground'}`}>Packing Department</button>
                <button onClick={() => setActiveTab('warehouse')} className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${activeTab === 'warehouse' ? 'bg-royal text-white' : 'hover:bg-muted text-muted-foreground'}`}>Warehouse</button>
                <button onClick={() => setActiveTab('import_export')} className={`px-4 py-2 rounded-t-lg font-medium transition-colors ${activeTab === 'import_export' ? 'bg-royal text-white' : 'hover:bg-muted text-muted-foreground'}`}>Import & Export</button>
            </nav>

            <div className="tab-content-container">
                {activeTab === 'packing_summary' && (
                    <div id="packing_summary" className="space-y-6">
                        <section className="meta-section card bg-card p-6 rounded-xl border border-border shadow-sm">
                            <h2 className="text-lg font-bold mb-4 border-b pb-2">Packing Department</h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">VENDOR PO</label>
                                    <input type="text" name="vendorPO" value={meta.vendorPO} onChange={handleMetaChange} className="border p-2 rounded bg-background" placeholder="e.g. PO-1234" />
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">CLIENT PO</label>
                                    <input type="text" name="clientPO" value={meta.clientPO} onChange={handleMetaChange} className="border p-2 rounded bg-background" placeholder="e.g. CPO-5678" />
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">STORE NAME</label>
                                    <select name="storeName" value={meta.storeName} onChange={handleMetaChange} className="border p-2 rounded bg-background">
                                        <option value="">-- Select --</option>
                                        <option value="SPIRIT">SPIRIT</option>
                                        <option value="SPENCERS">SPENCERS</option>
                                        <option value="BUC-EE'S">BUC-EE'S</option>
                                        <option value="TRACTOR SUPPLY">TRACTOR SUPPLY</option>
                                    </select>
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">Client</label>
                                    <select name="client" value={meta.client} onChange={handleMetaChange} className="border p-2 rounded bg-background">
                                        <option value="">-- Select --</option>
                                        <option value="GOODIE TWO SLEEVES">GOODIE TWO SLEEVES</option>
                                        <option value="SCREENWORKS">SCREENWORKS</option>
                                        <option value="ROCK REBEL">ROCK REBEL</option>
                                    </select>
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">Date Packed:</label>
                                    <input type="date" name="datePacked" value={meta.datePacked} onChange={handleMetaChange} className="border p-2 rounded bg-background" />
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">Packer Name:</label>
                                    <input type="text" name="packerName" value={meta.packerName} onChange={handleMetaChange} className="border p-2 rounded bg-background" placeholder="Your Name" />
                                </div>
                            </div>
                        </section>

                        <section className="table-section card bg-card p-6 rounded-xl border border-border shadow-sm overflow-x-auto">
                            <table className="w-full min-w-max text-sm border-collapse styled-table">
                                <thead>
                                    <tr className="bg-muted text-muted-foreground">
                                        <th className="border p-2">STORE PO</th>
                                        <th className="border p-2">Design Code</th>
                                        <th className="border p-2">Garment Type</th>
                                        <th className="border p-2">Garment Color</th>
                                        {SIZE_LABELS.map(sz => <th key={sz} className="border p-2">{sz}</th>)}
                                        <th className="border p-2 bg-royal/10 text-royal">TOTAL</th>
                                        <th className="border p-2">Box Qty</th>
                                        <th className="border p-2">Pcs/box</th>
                                        <th className="border p-2">New</th>
                                        <th className="border p-2">Recycled</th>
                                        <th className="border p-2">Box Dim</th>
                                        <th className="border p-2">Box Wt</th>
                                        <th className="border p-2">Pallet #</th>
                                        <th className="border p-2">Pallet Dim</th>
                                        <th className="border p-2"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {computedRows.map((r, idx) => (
                                        <tr key={r.id} className="hover:bg-muted/50">
                                            <td className="border p-1"><input type="text" className="w-20 bg-transparent" value={r.storePO} onChange={(e)=>handleRowChange(r.id, 'storePO', e.target.value)} /></td>
                                            <td className="border p-1"><input type="text" className="w-24 bg-transparent" value={r.designCode} onChange={(e)=>handleRowChange(r.id, 'designCode', e.target.value)} /></td>
                                            <td className="border p-1"><input type="text" className="w-24 bg-transparent" value={r.garmentType} onChange={(e)=>handleRowChange(r.id, 'garmentType', e.target.value)} /></td>
                                            <td className="border p-1"><input type="text" className="w-24 bg-transparent" value={r.garmentColor} onChange={(e)=>handleRowChange(r.id, 'garmentColor', e.target.value)} /></td>
                                            {SIZE_KEYS.map(sz => (
                                                <td key={sz} className="border p-1"><input type="number" min="0" className="w-12 text-center bg-transparent" value={r[sz]} onChange={(e)=>handleRowChange(r.id, sz, e.target.value)} /></td>
                                            ))}
                                            <td className="border p-1 bg-royal/5 font-bold text-center">{r.total}</td>
                                            <td className="border p-1"><input type="number" min="0" className="w-16 text-center bg-transparent" value={r.boxQty} onChange={(e)=>handleRowChange(r.id, 'boxQty', e.target.value)} /></td>
                                            <td className="border p-1"><input type="number" min="0" className="w-16 text-center bg-transparent" value={r.pcsPerBox} onChange={(e)=>handleRowChange(r.id, 'pcsPerBox', e.target.value)} /></td>
                                            <td className="border p-1 text-center"><input type="checkbox" checked={r.newBoxes} onChange={()=>handleCheckboxChange(r.id, 'newBoxes')} /></td>
                                            <td className="border p-1 text-center"><input type="checkbox" checked={r.recycledBoxes} onChange={()=>handleCheckboxChange(r.id, 'recycledBoxes')} /></td>
                                            <td className="border p-1"><input type="text" className="w-20 bg-transparent" value={r.boxDim} onChange={(e)=>handleRowChange(r.id, 'boxDim', e.target.value)} /></td>
                                            <td className="border p-1"><input type="number" step="0.1" className="w-16 bg-transparent" value={r.boxWeight} onChange={(e)=>handleRowChange(r.id, 'boxWeight', e.target.value)} /></td>
                                            <td className="border p-1"><input type="text" className="w-16 bg-transparent" value={r.palletNo} onChange={(e)=>handleRowChange(r.id, 'palletNo', e.target.value)} /></td>
                                            <td className="border p-1"><input type="text" className="w-20 bg-transparent" value={r.palletDim} onChange={(e)=>handleRowChange(r.id, 'palletDim', e.target.value)} /></td>
                                            <td className="border p-1 text-center"><button onClick={()=>removeRow(r.id)} className="text-red-500 hover:text-red-700">x</button></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="mt-4">
                                <button onClick={addRow} className="px-4 py-2 border rounded hover:bg-muted text-sm">+ Add Row</button>
                            </div>
                        </section>

                        <section className="flex gap-6 mt-6">
                            <div className="flex-1 card bg-card p-6 rounded-xl border shadow-sm overflow-x-auto">
                                <h3 className="font-bold mb-4">Summary</h3>
                                <table className="w-full text-sm border-collapse styled-table">
                                    <thead>
                                        <tr className="bg-muted">
                                            <th className="border p-2"></th>
                                            {SIZE_LABELS.map(sz => <th key={sz} className="border p-2">{sz}</th>)}
                                            <th className="border p-2 bg-royal/10 text-royal">TOTAL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {SUMMARY_ROWS_DEF.map(rDef => {
                                            const rowData = computedSummary[rDef.id];
                                            return (
                                                <tr key={rDef.id}>
                                                    <td className="border p-2 font-bold text-right">{rDef.label}</td>
                                                    {SIZE_KEYS.map(sz => (
                                                        <td key={sz} className="border p-1">
                                                            {rDef.readonly ? (
                                                                <div className="w-full text-center bg-muted/50 p-1">{rowData[sz] !== 0 ? rowData[sz] : ''}</div>
                                                            ) : (
                                                                <input type="number" min="0" className="w-12 text-center bg-transparent" value={summaryData[rDef.id][sz]} onChange={(e)=>handleSummaryChange(rDef.id, sz, e.target.value)} />
                                                            )}
                                                        </td>
                                                    ))}
                                                    <td className="border p-2 font-bold text-center bg-royal/5">{rowData.total}</td>
                                                </tr>
                                            )
                                        })}
                                        <tr>
                                            <td className="border p-2 font-bold text-right">NOTE:</td>
                                            <td colSpan={9} className="border p-1">
                                                <input type="text" className="w-full bg-transparent p-1" value={meta.note} onChange={handleMetaChange} name="note" placeholder="Additional notes..." />
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <div className="w-64 card bg-card p-6 rounded-xl border shadow-sm">
                                <h3 className="font-bold mb-4">Box Details</h3>
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-xs font-bold text-muted-foreground">NEW BOXES</label>
                                        <input type="number" readOnly className="border p-2 rounded bg-muted font-bold" value={meta.newBoxes} />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-xs font-bold text-muted-foreground">RECYCLED BOXES</label>
                                        <input type="number" readOnly className="border p-2 rounded bg-muted font-bold" value={meta.recycledBoxes} />
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                )}

                {activeTab === 'warehouse' && (
                    <div id="warehouse" className="space-y-6">
                        <section className="card bg-card p-6 rounded-xl border shadow-sm">
                            <h2 className="text-lg font-bold mb-4 border-b pb-2">Warehouse Info</h2>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">Picking Date</label>
                                    <input type="date" name="pickingDate" value={meta.pickingDate} onChange={handleMetaChange} className="border p-2 rounded bg-background" />
                                </div>
                                <div className="form-group flex flex-col gap-1">
                                    <label className="text-xs font-bold text-muted-foreground">Picker Name</label>
                                    <input type="text" name="pickerNameWarehouse" value={meta.pickerNameWarehouse} onChange={handleMetaChange} className="border p-2 rounded bg-background" />
                                </div>
                            </div>
                        </section>

                        <section className="card bg-card p-6 rounded-xl border shadow-sm">
                            <h3 className="font-bold mb-4">Sizes Breakdown by Material & Origin</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                                {SIZE_LABELS.map((sz) => {
                                    const tRows = sizeTables[sz];
                                    const tTotal = tRows.reduce((a, b) => a + (parseInt(b.qty) || 0), 0);
                                    return (
                                        <div key={sz} className="border rounded-lg overflow-hidden">
                                            <h4 className="bg-royal text-white text-center py-2 font-bold text-sm">SIZE {sz}</h4>
                                            <table className="w-full text-xs">
                                                <thead className="bg-muted">
                                                    <tr><th className="p-1">Percentage</th><th className="p-1">Origin</th><th className="p-1">Qty</th></tr>
                                                </thead>
                                                <tbody>
                                                    {tRows.map(tr => (
                                                        <tr key={tr.id}>
                                                            <td className="p-1 border-t border-r"><select value={tr.perc} onChange={(e)=>handleSizeTableChange(sz, tr.id, 'perc', e.target.value)} className="w-full bg-transparent"><option value="-">-</option>{PERC_OPTIONS.filter(o=>o!=='-').map(o=><option key={o} value={o}>{o}</option>)}</select></td>
                                                            <td className="p-1 border-t border-r"><select value={tr.orig} onChange={(e)=>handleSizeTableChange(sz, tr.id, 'orig', e.target.value)} className="w-full bg-transparent"><option value="-">-</option>{ORIG_OPTIONS.filter(o=>o!=='-').map(o=><option key={o} value={o}>{o}</option>)}</select></td>
                                                            <td className="p-1 border-t"><input type="number" min="0" value={tr.qty} onChange={(e)=>handleSizeTableChange(sz, tr.id, 'qty', e.target.value)} className="w-full bg-transparent text-center" /></td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                                <tfoot className="bg-muted/50">
                                                    <tr>
                                                        <td colSpan={2} className="p-1 text-right font-bold border-t">Total:</td>
                                                        <td className="p-1 text-center font-bold border-t">{tTotal}</td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </div>
                                    )
                                })}
                            </div>
                        </section>
                    </div>
                )}

                {activeTab === 'import_export' && (
                    <div id="import_export">
                        <section className="card bg-card p-6 rounded-xl border shadow-sm overflow-x-auto">
                            <h3 className="font-bold mb-4">Summary (Import & Export)</h3>
                            <table className="w-full text-sm border-collapse styled-table">
                                <thead className="bg-muted">
                                    <tr>
                                        <th className="border p-2">Percentage</th>
                                        <th className="border p-2">Country of Origin</th>
                                        {SIZE_LABELS.map(sz => <th key={sz} className="border p-2">{sz}</th>)}
                                        <th className="border p-2 bg-royal/10 text-royal">TOTAL</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {computedBreakdowns.map((bd, i) => (
                                        <tr key={i} className="hover:bg-muted/50">
                                            <td className="border p-2">{bd.perc}</td>
                                            <td className="border p-2">{bd.orig}</td>
                                            {SIZE_KEYS.map(sz => <td key={sz} className="border p-2 text-center">{bd[sz] || ''}</td>)}
                                            <td className="border p-2 text-center font-bold">{bd.total}</td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr>
                                        <td colSpan={10} className="border p-2 text-right font-bold">Total Qty:</td>
                                        <td className="border p-2 text-center font-bold text-royal bg-royal/10">{grandTotalQty}</td>
                                    </tr>
                                </tfoot>
                            </table>
                        </section>
                    </div>
                )}
            </div>
        </div>
    );
}
