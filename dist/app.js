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
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const pdf_parse_1 = __importDefault(require("pdf-parse"));
const XLSX = __importStar(require("xlsx"));
const database_1 = require("./config/database");
const bsale = __importStar(require("./services/bsaleService"));
const credit = __importStar(require("./services/creditNoteService"));
const report = __importStar(require("./services/reportService"));
const modelMapping = __importStar(require("./services/modelMappingService"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
const upload = (0, multer_1.default)({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});
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
        // Obtener sucursal
        const officeId = stock?.office?.id || 2;
        let officeName = stock?.office?.name || null;
        if (!officeName) {
            const office = await bsale.getOffice(officeId);
            officeName = office?.name || `Sucursal ${officeId}`;
        }
        for (const item of costs.history) {
            const detailId = item.reception_detail?.id || 0;
            await database_1.pool.query(`
        INSERT INTO receptions (id, variant_id, sku, product_name, original_cost, quantity_received, quantity_remaining, bsale_reception_detail_id, admission_date, document_number, office_id, office_name, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          quantity_remaining = EXCLUDED.quantity_remaining,
          original_cost = EXCLUDED.original_cost,
          document_number = EXCLUDED.document_number,
          office_id = EXCLUDED.office_id,
          office_name = EXCLUDED.office_name,
          synced_at = CURRENT_TIMESTAMP
      `, [detailId, variant.id, sku, productName, item.cost, item.availableFifo, item.availableFifo, detailId, item.admissionDate, item.documentNumber || null, officeId, officeName]);
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
            ['Producto', 'Primera RC con precio Nuevo', 'Fecha primera RC', 'Sucursal stock nuevo', 'Stock Nuevo', 'Precio nuevo',
                'Ultima recepción a precio viejo', 'Fecha de ultima RC', 'Sucursal stock viejo', 'Precio Viejo', 'Stock Viejo',
                'Diferencia unitaria', 'Total de nota de credito'],
            [
                result.producto,
                result.primeraRcPrecioNuevo || '',
                result.fechaPrimeraRc || '',
                result.sucursalStockNuevo || '',
                result.stockNuevo,
                result.precioNuevo,
                result.ultimaRcPrecioViejo || '',
                result.fechaUltimaRc || '',
                result.sucursalStockViejo || '',
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
            { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 12 },
            { wch: 28 }, { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 22 },
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
// Get paid credit notes (history)
app.get('/api/credit-notes/paid', async (_req, res) => {
    try {
        const result = await database_1.pool.query(`
      SELECT cn.*, r.document_number, r.admission_date
      FROM credit_notes cn
      JOIN receptions r ON r.id = cn.reception_id
      WHERE cn.status = 'paid'
      ORDER BY cn.created_at DESC
    `);
        res.json(result.rows);
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
// Delete all pending credit notes
app.delete('/api/credit-notes', async (_req, res) => {
    try {
        const deleted = await credit.deleteAllCreditNotes();
        res.json({ success: true, deleted, message: `Se eliminaron ${deleted} notas de credito pendientes.` });
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
// ============ MODEL-TO-SKU MAPPING ENDPOINTS ============
// Upload Modelo-SKU Excel to populate mappings
app.post('/api/mappings/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: 'Archivo Excel requerido' });
        const buffer = require('fs').readFileSync(req.file.path);
        const result = await modelMapping.loadMappingsFromExcel(buffer);
        // Clean up uploaded file
        require('fs').unlinkSync(req.file.path);
        res.json({
            success: true,
            mappingsLoaded: result.inserted,
            errors: result.errors.length > 0 ? result.errors : undefined,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Lookup SKU by model (fuzzy matching)
app.get('/api/mappings/lookup', async (req, res) => {
    try {
        const model = req.query.model;
        if (!model)
            return res.status(400).json({ error: 'model query param requerido' });
        const skus = await modelMapping.findSkuByModel(model);
        res.json({ model, normalized: modelMapping.normalizeModel(model), skus });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Auto-sync helper: sync a SKU from Bsale if not already in DB
async function autoSyncSku(sku) {
    try {
        // Check if already synced
        const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
        if (existing.rows.length > 0) {
            return { success: true };
        }
        // Fetch from Bsale
        const variant = await bsale.getVariantBySku(sku);
        if (!variant) {
            return { success: false, error: 'SKU no encontrado en Bsale' };
        }
        const productName = await bsale.getProductName(variant.product.id);
        const stock = await bsale.getStock(variant.id);
        const costs = await bsale.getCostsWithDocumentNumbers(variant.id);
        // Obtener sucursal
        const officeId = stock?.office?.id || 2;
        let officeName = stock?.office?.name || null;
        if (!officeName) {
            const office = await bsale.getOffice(officeId);
            officeName = office?.name || `Sucursal ${officeId}`;
        }
        for (const item of costs.history) {
            const detailId = item.reception_detail?.id || 0;
            await database_1.pool.query(`
        INSERT INTO receptions (id, variant_id, sku, product_name, original_cost, quantity_received, quantity_remaining, bsale_reception_detail_id, admission_date, document_number, office_id, office_name, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          quantity_remaining = EXCLUDED.quantity_remaining,
          original_cost = EXCLUDED.original_cost,
          document_number = EXCLUDED.document_number,
          office_id = EXCLUDED.office_id,
          office_name = EXCLUDED.office_name,
          synced_at = CURRENT_TIMESTAMP
      `, [detailId, variant.id, sku, productName, item.cost, item.availableFifo, item.availableFifo, detailId, item.admissionDate, item.documentNumber || null, officeId, officeName]);
        }
        return { success: true, productName };
    }
    catch (e) {
        return { success: false, error: e.message };
    }
}
// Get product details by model (returns ALL variants/SKUs) — auto-syncs unsynced variants
app.get('/api/product-by-model/:model', async (req, res) => {
    try {
        const { model } = req.params;
        const skus = await modelMapping.findSkuByModel(model);
        if (skus.length === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado. Sube el Excel de mapeo primero.' });
        }
        // Auto-sync any unsynced SKUs
        const syncResults = [];
        for (const sku of skus) {
            const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
            if (existing.rows.length === 0) {
                const syncResult = await autoSyncSku(sku);
                syncResults.push({ sku, ...syncResult });
            }
        }
        // Fetch details for ALL SKUs (variants)
        const variants = [];
        for (const sku of skus) {
            const stockForCredit = await credit.getStockForCredit(sku);
            const product = (await database_1.pool.query('SELECT * FROM receptions WHERE sku = $1 LIMIT 1', [sku])).rows[0];
            variants.push({
                sku,
                productName: product?.product_name || null,
                synced: !!product,
                receptions: stockForCredit,
                totalRemaining: stockForCredit.reduce((sum, s) => sum + s.quantityRemaining, 0),
                totalCredited: stockForCredit.reduce((sum, s) => sum + s.alreadyCredited, 0),
                availableForCredit: stockForCredit.reduce((sum, s) => sum + s.availableForCredit, 0),
            });
        }
        const syncedVariants = variants.filter(v => v.synced);
        res.json({
            model,
            skusFound: skus.length,
            variantsSynced: syncedVariants.length,
            autoSyncResults: syncResults.length > 0 ? syncResults : undefined,
            variants,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Calculate credit notes by model (supports specific sku or all variants) — auto-syncs unsynced variants
app.post('/api/calculate-by-model/:model', async (req, res) => {
    try {
        const { model } = req.params;
        const { newPrice, sku: specificSku } = req.body;
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice requerido y mayor a 0' });
        const skus = await modelMapping.findSkuByModel(model);
        if (skus.length === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado. Sube el Excel de mapeo primero.' });
        }
        const targetSkus = specificSku ? [specificSku] : skus;
        // Auto-sync any unsynced SKUs first
        const syncResults = [];
        for (const sku of targetSkus) {
            const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
            if (existing.rows.length === 0) {
                const syncResult = await autoSyncSku(sku);
                syncResults.push({ sku, ...syncResult });
            }
        }
        const allResults = [];
        let totalAmountAll = 0;
        for (const sku of targetSkus) {
            const stockItems = await credit.getStockForCredit(sku);
            if (!stockItems.length)
                continue;
            const result = credit.calculateCreditNotes(stockItems, newPrice);
            if (result.creditNotes.length > 0) {
                allResults.push({
                    sku,
                    productName: stockItems[0]?.productName,
                    newPrice,
                    creditNotes: result.creditNotes,
                    totalAmount: result.totalAmount,
                });
                totalAmountAll += result.totalAmount;
            }
        }
        if (allResults.length === 0) {
            return res.status(404).json({
                error: 'No hay stock sincronizado o no hay notas de credito para generar',
                skus,
                autoSyncResults: syncResults.length > 0 ? syncResults : undefined,
            });
        }
        res.json({
            model,
            newPrice,
            variantsCount: allResults.length,
            totalAmountAll,
            results: allResults,
            autoSyncResults: syncResults.length > 0 ? syncResults : undefined,
            currency: 'USD',
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Generate report by model (JSON) - supports specific sku or all variants — auto-syncs unsynced variants
app.get('/api/report-by-model/:model', async (req, res) => {
    try {
        const { model } = req.params;
        const newPrice = parseFloat(req.query.newPrice);
        const specificSku = req.query.sku;
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });
        const skus = await modelMapping.findSkuByModel(model);
        if (skus.length === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado. Sube el Excel de mapeo primero.' });
        }
        const targetSkus = specificSku ? [specificSku] : skus;
        // Auto-sync any unsynced SKUs first
        const syncResults = [];
        for (const sku of targetSkus) {
            const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
            if (existing.rows.length === 0) {
                const syncResult = await autoSyncSku(sku);
                syncResults.push({ sku, ...syncResult });
            }
        }
        const allReports = [];
        for (const sku of targetSkus) {
            try {
                const result = await report.generateCreditReport(sku, newPrice);
                allReports.push({ ...result, sku });
            }
            catch (e) {
                // Skip SKUs without receptions
            }
        }
        if (allReports.length === 0) {
            return res.status(404).json({
                error: 'No hay recepciones sincronizadas para ninguna variante',
                skus,
                autoSyncResults: syncResults.length > 0 ? syncResults : undefined,
            });
        }
        res.json({ model, skus: targetSkus, reports: allReports, autoSyncResults: syncResults.length > 0 ? syncResults : undefined });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Generate report by model (Excel download) - supports specific sku or all variants — auto-syncs unsynced variants
app.get('/api/report-by-model/:model/excel', async (req, res) => {
    try {
        const { model } = req.params;
        const newPrice = parseFloat(req.query.newPrice);
        const specificSku = req.query.sku;
        if (!newPrice || newPrice <= 0)
            return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });
        const skus = await modelMapping.findSkuByModel(model);
        if (skus.length === 0) {
            return res.status(404).json({ error: 'Modelo no encontrado. Sube el Excel de mapeo primero.' });
        }
        const targetSkus = specificSku ? [specificSku] : skus;
        // Auto-sync any unsynced SKUs first
        const syncResults = [];
        for (const sku of targetSkus) {
            const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
            if (existing.rows.length === 0) {
                const syncResult = await autoSyncSku(sku);
                syncResults.push({ sku, ...syncResult });
            }
        }
        // Build worksheet with all variants
        const wsData = [
            ['Modelo', 'SKU', 'Producto', 'Primera RC con precio Nuevo', 'Fecha primera RC', 'Sucursal stock nuevo', 'Stock Nuevo', 'Precio nuevo',
                'Ultima recepción a precio viejo', 'Fecha de ultima RC', 'Sucursal stock viejo', 'Precio Viejo', 'Stock Viejo',
                'Diferencia unitaria', 'Total de nota de credito'],
        ];
        for (const sku of targetSkus) {
            try {
                const result = await report.generateCreditReport(sku, newPrice);
                wsData.push([
                    model,
                    sku,
                    result.producto,
                    result.primeraRcPrecioNuevo || '',
                    result.fechaPrimeraRc || '',
                    result.sucursalStockNuevo || '',
                    String(result.stockNuevo),
                    String(result.precioNuevo),
                    result.ultimaRcPrecioViejo || '',
                    result.fechaUltimaRc || '',
                    result.sucursalStockViejo || '',
                    result.precioViejo !== null ? String(result.precioViejo) : '',
                    String(result.stockViejo),
                    result.diferenciaUnitaria !== null ? String(result.diferenciaUnitaria) : '',
                    result.totalNotaCredito !== null ? String(result.totalNotaCredito) : '',
                ]);
            }
            catch (e) {
                // Skip SKUs without receptions
            }
        }
        if (wsData.length === 1) {
            return res.status(404).json({
                error: 'No hay recepciones sincronizadas para ninguna variante',
                autoSyncResults: syncResults.length > 0 ? syncResults : undefined,
            });
        }
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [
            { wch: 12 }, { wch: 20 }, { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 12 },
            { wch: 28 }, { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 22 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Reporte Nota Credito');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', `attachment; filename="reporte_nota_credito_${model}_${newPrice}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Bulk calculate from Excel: columns = Modelo, PrecioNuevo
// AUTO-SAVES credit notes to database!
app.post('/api/bulk-calculate', upload.single('file'), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: 'Archivo Excel requerido' });
        const buffer = require('fs').readFileSync(req.file.path);
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
        require('fs').unlinkSync(req.file.path);
        // Detect header
        let dataStart = 0;
        for (let i = 0; i < Math.min(rows.length, 5); i++) {
            const row = rows[i];
            if (row && row.length >= 2) {
                const first = String(row[0] || '').toLowerCase().trim();
                if (first.includes('modelo') || first.includes('model')) {
                    dataStart = i + 1;
                    break;
                }
            }
        }
        const results = [];
        const errors = [];
        let totalSavedNotes = 0;
        let totalSavedAmount = 0;
        for (let i = dataStart; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 2)
                continue;
            const model = String(row[0] || '').trim();
            const newPrice = parseFloat(String(row[1] || '').replace(/[^0-9.]/g, ''));
            if (!model || isNaN(newPrice) || newPrice <= 0) {
                errors.push(`Fila ${i + 1}: modelo o precio inválido`);
                continue;
            }
            try {
                const skus = await modelMapping.findSkuByModel(model);
                if (skus.length === 0) {
                    errors.push(`Fila ${i + 1}: modelo "${model}" no encontrado`);
                    continue;
                }
                // Process ALL variants for this model
                const variantResults = [];
                let modelTotalAmount = 0;
                let modelSavedNotes = 0;
                for (const sku of skus) {
                    // Auto-sync if needed
                    const existing = await database_1.pool.query('SELECT 1 FROM receptions WHERE sku = $1 LIMIT 1', [sku]);
                    if (existing.rows.length === 0) {
                        await autoSyncSku(sku);
                    }
                    const stockItems = await credit.getStockForCredit(sku);
                    if (!stockItems.length)
                        continue;
                    const calc = credit.calculateCreditNotes(stockItems, newPrice);
                    if (calc.creditNotes.length > 0) {
                        // AUTO-SAVE credit notes!
                        await credit.saveCreditNotes(calc.creditNotes);
                        modelTotalAmount += calc.totalAmount;
                        modelSavedNotes += calc.creditNotes.length;
                        totalSavedAmount += calc.totalAmount;
                        totalSavedNotes += calc.creditNotes.length;
                        variantResults.push({
                            sku,
                            productName: stockItems[0]?.productName,
                            creditNotesCount: calc.creditNotes.length,
                            totalAmount: calc.totalAmount,
                        });
                    }
                }
                if (variantResults.length === 0) {
                    errors.push(`Fila ${i + 1}: modelo "${model}" — no hay notas de crédito para generar (precio nuevo >= costo actual)`);
                    continue;
                }
                results.push({
                    row: i + 1,
                    model,
                    newPrice,
                    variantsProcessed: variantResults.length,
                    totalAmount: modelTotalAmount,
                    savedNotes: modelSavedNotes,
                    variants: variantResults,
                });
            }
            catch (e) {
                errors.push(`Fila ${i + 1}: ${e.message}`);
            }
        }
        res.json({
            success: true,
            processed: results.length,
            totalSavedNotes,
            totalSavedAmount,
            errors: errors.length > 0 ? errors : undefined,
            results,
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ============ VIP PDF EXTRACTOR ============
// Extract Modelo + Precio from VIP PDF catalogues
function parseVipCatalog(text, sourceFile) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const results = [];
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const priceMatch = line.match(/^\$\s*([\d,.]+)$/);
        if (!priceMatch)
            continue;
        let priceStr = priceMatch[1].replace(',', '.');
        const precioNuevo = parseFloat(priceStr);
        if (isNaN(precioNuevo) || precioNuevo <= 0 || precioNuevo > 5000)
            continue;
        let modelo = null;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const candidate = lines[j];
            if (candidate.length < 2 || candidate.length > 25)
                continue;
            if (candidate.match(/^\d+$/))
                continue;
            const lower = candidate.toLowerCase();
            if (lower.includes('cajas') || lower.includes('ventilador') || lower.includes('powerbank') ||
                lower.includes('bocina') || lower.includes('smartwatch') || lower.includes('cargador') ||
                lower.includes('soporte') || lower.includes('rasuradora'))
                continue;
            if (candidate.startsWith('$'))
                break;
            const modelWithSpaceQty = candidate.match(/^([A-Z]{1,4}-?\d{2,5}[A-Z]?)\s+\d+$/);
            if (modelWithSpaceQty) {
                modelo = modelWithSpaceQty[1];
                break;
            }
            const modelMatch = candidate.match(/^[A-Z]{1,4}-?\d{2,5}[A-Z]?$/);
            if (modelMatch) {
                modelo = modelMatch[0];
                break;
            }
            const concatMatch = candidate.match(/^([A-Z]{1,4}-?\d{2,5}[A-Z]?)(12|20|24|40|48|50|60|100)$/);
            if (concatMatch) {
                modelo = concatMatch[1];
                break;
            }
        }
        if (!modelo)
            continue;
        const key = `${modelo}-${precioNuevo}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        results.push({ modelo, precioNuevo, sourceFile });
    }
    return results;
}
app.post('/api/extract-vip-pdf', upload.array('files', 20), async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0)
            return res.status(400).json({ error: 'Archivo PDF requerido' });
        const allProducts = [];
        const errors = [];
        const seen = new Set();
        for (const file of files) {
            try {
                const buffer = fs_1.default.readFileSync(file.path);
                const pdfData = await (0, pdf_parse_1.default)(buffer);
                fs_1.default.unlinkSync(file.path);
                const products = parseVipCatalog(pdfData.text, file.originalname);
                for (const p of products) {
                    const key = `${p.modelo}-${p.precioNuevo}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        allProducts.push(p);
                    }
                }
            }
            catch (e) {
                errors.push(`${file.originalname}: ${e.message}`);
                try {
                    fs_1.default.unlinkSync(file.path);
                }
                catch (_) { }
            }
        }
        if (allProducts.length === 0) {
            return res.status(404).json({ error: 'No se encontraron productos en ningun PDF. Asegurate de que sean catalogos VIP de Moreka.', details: errors });
        }
        // Build Excel
        const wsData = [['Modelo', 'PrecioNuevo'], ...allProducts.map(r => [r.modelo, r.precioNuevo])];
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [{ wch: 15 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Precios VIP');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const fileName = files.length === 1 ? 'vip-precios' : `vip-precios-${files.length}-pdfs`;
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}-${Date.now()}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ============ EXISTING ENDPOINTS ============
app.get('/', (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../public/index.html'));
});
app.listen(PORT, () => {
    console.log(`Inventory Credit App running on port ${PORT}`);
});
