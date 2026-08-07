import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { initDatabase, pool } from './config/database';
import * as bsale from './services/bsaleService';
import * as credit from './services/creditNoteService';
import * as report from './services/reportService';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ dest: 'uploads/' });

initDatabase();

// Health
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'inventory-credit-app', timestamp: new Date().toISOString() });
});

// Stats
app.get('/api/stats', async (_req, res) => {
  try {
    const summary = await credit.getCreditNoteSummary();
    const totalProducts = (await pool.query('SELECT COUNT(DISTINCT sku) as c FROM receptions')).rows[0].c || 0;
    const totalReceptions = (await pool.query('SELECT COUNT(*) as c FROM receptions')).rows[0].c || 0;
    res.json({ ...summary, totalProducts, totalReceptions });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Sync product from Bsale
app.post('/api/sync/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const variant = await bsale.getVariantBySku(sku);
    if (!variant) return res.status(404).json({ error: 'Producto no encontrado en Bsale' });

    const productName = await bsale.getProductName(variant.product.id);
    const stock = await bsale.getStock(variant.id);
    const costs = await bsale.getCosts(variant.id);

    for (const item of costs.history) {
      const detailId = item.reception_detail?.id || 0;
      await pool.query(`
        INSERT INTO receptions (id, variant_id, sku, product_name, original_cost, quantity_received, quantity_remaining, bsale_reception_detail_id, admission_date, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
          quantity_remaining = EXCLUDED.quantity_remaining,
          original_cost = EXCLUDED.original_cost,
          synced_at = CURRENT_TIMESTAMP
      `, [detailId, variant.id, sku, productName, item.cost, item.availableFifo, item.availableFifo, detailId, item.admissionDate]);
    }

    res.json({
      sku, productName, variantId: variant.id,
      stock: stock?.quantityAvailable || 0,
      receptions: costs.history.length,
      costs: costs.history.map(h => ({ cost: h.cost, available: h.availableFifo, date: bsale.formatBsaleDate(h.admissionDate) })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get product detail
app.get('/api/product/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const stockForCredit = await credit.getStockForCredit(sku);
    const product = (await pool.query('SELECT * FROM receptions WHERE sku = $1 LIMIT 1', [sku])).rows[0];

    if (!product) return res.status(404).json({ error: 'Producto no sincronizado. Usa POST /api/sync/:sku primero.' });

    res.json({
      sku, productName: product.product_name, receptions: stockForCredit,
      totalRemaining: stockForCredit.reduce((sum, s) => sum + s.quantityRemaining, 0),
      totalCredited: stockForCredit.reduce((sum, s) => sum + s.alreadyCredited, 0),
      availableForCredit: stockForCredit.reduce((sum, s) => sum + s.availableForCredit, 0),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Calculate credit notes
app.post('/api/calculate/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const { newPrice } = req.body;
    if (!newPrice || newPrice <= 0) return res.status(400).json({ error: 'newPrice requerido y mayor a 0' });

    const stockItems = await credit.getStockForCredit(sku);
    if (!stockItems.length) return res.status(404).json({ error: 'No hay stock sincronizado' });

    const result = credit.calculateCreditNotes(stockItems, newPrice);
    res.json({ sku, productName: stockItems[0]?.productName, newPrice, creditNotes: result.creditNotes, totalAmount: result.totalAmount, currency: 'USD' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Generate credit report (JSON)
app.get('/api/report/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const newPrice = parseFloat(req.query.newPrice as string);
    if (!newPrice || newPrice <= 0) return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });

    const result = await report.generateCreditReport(sku, newPrice);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Generate credit report (Excel download)
app.get('/api/report/:sku/excel', async (req, res) => {
  try {
    const { sku } = req.params;
    const newPrice = parseFloat(req.query.newPrice as string);
    if (!newPrice || newPrice <= 0) return res.status(400).json({ error: 'newPrice query param requerido y mayor a 0' });

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
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Save credit notes
app.post('/api/credit-notes', async (req, res) => {
  try {
    const { notes, pdfId } = req.body;
    if (!notes?.length) return res.status(400).json({ error: 'notes array requerido' });
    await credit.saveCreditNotes(notes, pdfId);
    res.json({ success: true, count: notes.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get pending credit notes
app.get('/api/credit-notes', async (_req, res) => {
  try {
    const notes = await credit.getPendingCreditNotes();
    res.json(notes);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Mark as paid
app.post('/api/credit-notes/:id/pay', async (req, res) => {
  try {
    await credit.markCreditNotePaid(parseInt(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// List products
app.get('/api/products', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.sku, MAX(r.product_name) as product_name, SUM(r.quantity_remaining) as total_stock,
             COUNT(r.id) as receptions, MAX(r.synced_at) as last_sync
      FROM receptions r
      GROUP BY r.sku
      ORDER BY product_name
    `);
    res.json(result.rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Upload PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'PDF requerido' });
    const supplier = req.body.supplier || '';
    const result = await pool.query(
      `INSERT INTO price_pdfs (filename, original_name, supplier) VALUES ($1, $2, $3) RETURNING id`,
      [req.file.filename, req.file.originalname, supplier]
    );
    res.json({ success: true, pdfId: result.rows[0].id, filename: req.file.originalname });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Inventory Credit App running on port ${PORT}`);
});
