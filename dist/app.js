"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
const XLSX = __importStar(require("xlsx"));
const database_1 = require("./config/database");
const bsale = __importStar(require("./services/bsaleService"));
const credit = __importStar(require("./services/creditNoteService"));
const report = __importStar(require("./services/reportService"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
const upload = (0, multer_1.default)({ dest: 'uploads/' });
(0, database_1.initDatabase)();
// Health
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'inventory-credit-app', timestamp: new Date().toISOString() });
});
// Stats
app.get('/api/stats', async (_req, res) => {
    try {
        const summary = await credit.getCreditNoteSummary();
        const totalProducts = (await database_1.pool.query('SELECT COUNT(DISTINCT sku) as c FROM receptions')).rows[0].c || 0;
        const totalReceptions = (await database_1.pool.query('SELECT COUNT(*) as c FROM receptions')).rows[0].c || 0;
        res.json({ ...summary, totalProducts, totalReceptions });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Sync product from Bsale
app.post('/api/sync/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const variant = await bsale.getVariantBySku(sku);
        if (!variant)
            return res.status(404).json({ error: 'Producto no encontrado en Bsale' });
        const productName = await bsale.getProductName(variant.product.id);
        const stock = await bsale.getStock(variant.id);
        const costs = await bsale.getCostsWithDocumentNumbers(variant.id);
        for (const item of costs.history) {
            const detailId = item.reception_detail?.id || 0;
            await database_1.pool.query(`
        INSERT INTO receptions (id, variant_id, sku, product_name, original_cost, quantity_received, quantity_remaining, bsale_reception_detail_id, admission_date, document_number, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          quantity_remaining = EXCLUDED.quantity_remaining,
          original_cost = EXCLUDED.original_cost,
          document_number = EXCLUDED.document_number,
          synced_at = CURRENT_TIMESTAMP
      `, [detailId, variant.id, sku, productName, item.cost, item.availableFifo, item.availableFifo, detailId, item.admissionDate, item.documentNumber || null]);
        }
        res.json({
            sku, productName, variantId: variant.id,
            stock: stock?.quantityAvailable || 0,
            receptions: costs.history.length,
            costs: costs.history.map(h => ({ cost: h.cost, available: h.availableFifo, date: bsale.formatBsaleDate(h.admissionDate) })),
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Get product detail
app.get('/api/product/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const stockForCredit = await credit.getStockForCredit(sku);
        const product = (await database_1.pool.query('SELECT * FROM receptions WHERE sku = $1 LIMIT 1', [sku])).rows[0];
        if (!product)
            return res.status(404).json({ error: 'Producto no sincronizado. Usa POST /api/sync/:sku primero.' });
        res.json({
            sku, productName: product.product_name, receptions: stockForCredit,
            totalRemaining: stockForCredit.reduce((sum, s) => sum + s.quantityRemaining, 0),
            totalCredited: stockForCredit.reduce((sum, s) => sum + s.alreadyCredited, 0),
            availableForCredit: stockForCredit.reduce((sum, s) => sum + s.availableForCredit, 0),
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Calculate credit notes
app.post('/api/calculate/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const { newPrice } = req.body;
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice requerido y mayor a 0' });
        const stockItems = await credit.getStockForCredit(sku);
        if (!stockItems.length)
            return res.status(404).json({ error: 'No hay stock sincronizado' });
        const result = credit.calculateCreditNotes(stockItems, newPrice);
        res.json({ sku, productName: stockItems[0]?.productName, newPrice, creditNotes: result.creditNotes, totalAmount: result.totalAmount, currency: 'USD' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Generate credit report (JSON)
app.get('/api/report/:sku', async (req, res) => {
    try {
        const { sku } = req.params;
        const newPrice = parseFloat(req.query.newPrice);
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });
        const result = await report.generateCreditReport(sku, newPrice);
        res.json(result);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Generate credit report (Excel download)
app.get('/api/report/:sku/excel', async (req, res) => {
    try {
        const { sku } = req.params;
        const newPrice = parseFloat(req.query.newPrice);
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });
        const result = await report.generateCreditReport(sku, newPrice);
        // Build worksheet
        const wsData = [
            ['Producto', 'Primera RC con precio Nuevo', 'Fecha primera RC', 'Stock Nuevo', 'Precio nuevo',
                'Ultima recepción a precio viejo', 'Fecha de ultima RC', 'Precio Viejo', 'Stock Viejo',
                'Diferencia unitaria', 'Total de nota de credito'],
            [
                result.producto,
                result.primeraRcPrecioNuevo || '',
                result.fechaPrimeraRc || '',
                result.stockNuevo,
                result.precioNuevo,
                result.ultimaRcPrecioViejo || '',
                result.fechaUltimaRc || '',
                result.precioViejo ?? '',
                result.stockViejo,
                result.diferenciaUnitaria ?? '',
                result.totalNotaCredito ?? '',
            ],
        ];
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        // Set column widths
        ws['!cols'] = [
            { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
            { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 22 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Reporte Nota Credito');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="reporte_nota_credito_${sku}_${newPrice}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Save credit notes
app.post('/api/credit-notes', async (req, res) => {
    try {
        const { notes, pdfId } = req.body;
        if (!notes?.length)
            return res.status(400).json({ error: 'notes array requerido' });
        await credit.saveCreditNotes(notes, pdfId);
        res.json({ success: true, count: notes.length });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Get pending credit notes
app.get('/api/credit-notes', async (_req, res) => {
    try {
        const notes = await credit.getPendingCreditNotes();
        res.json(notes);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Mark as paid
app.post('/api/credit-notes/:id/pay', async (req, res) => {
    try {
        await credit.markCreditNotePaid(parseInt(req.params.id));
        res.json({ success: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// List products
app.get('/api/products', async (_req, res) => {
    try {
        const result = await database_1.pool.query(`
      SELECT r.sku, MAX(r.product_name) as product_name, SUM(r.quantity_remaining) as total_stock,
             COUNT(r.id) as receptions, MAX(r.synced_at) as last_sync
      FROM receptions r
      GROUP BY r.sku
      ORDER BY product_name
    `);
        res.json(result.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Upload PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: 'PDF requerido' });
        const supplier = req.body.supplier || '';
        const result = await database_1.pool.query(`INSERT INTO price_pdfs (filename, original_name, supplier) VALUES ($1, $2, $3) RETURNING id`, [req.file.filename, req.file.originalname, supplier]);
        res.json({ success: true, pdfId: result.rows[0].id, filename: req.file.originalname });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/index.html'));
});
app.listen(PORT, () => {
    console.log(`Inventory Credit App running on port ${PORT}`);
});
