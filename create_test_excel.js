const XLSX = require('xlsx');
const path = require('path');

const data = [
  ["Nro Pedido", "PO Cliente", "Cliente", "Fecha Cancelado", "Cant"],
  ["TEST-101", "PO-ABC", "Cliente Test", "2024-05-20", 50],
  ["TEST-102", "PO-XYZ", "Otro Cliente", "2024-06-15", 30]
];

const ws = XLSX.utils.aoa_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Sheet1");

const filePath = path.join(process.cwd(), 'test_import.xlsx');
XLSX.writeFile(wb, filePath);
console.log(`Excel file created at: ${filePath}`);
