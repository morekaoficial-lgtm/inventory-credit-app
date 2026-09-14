"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCOUNT_OTHER = exports.DISCOUNT_MOREKA = void 0;
exports.isMorekaProduct = isMorekaProduct;
exports.getDiscountPct = getDiscountPct;
exports.calculateCreditNotes = calculateCreditNotes;
exports.getStockForCredit = getStockForCredit;
exports.saveCreditNotes = saveCreditNotes;
exports.getPendingCreditNotes = getPendingCreditNotes;
exports.getPendingByFolio = getPendingByFolio;
exports.markCreditNotePaid = markCreditNotePaid;
exports.markFolioPaid = markFolioPaid;
exports.getCreditNoteSummary = getCreditNoteSummary;
exports.deleteAllCreditNotes = deleteAllCreditNotes;
const database_1 = require("../config/database");
// ============================================
// BRAND DISCOUNT RULES
// Moreka = 8% discount | Other brands = 7% discount
// ============================================
exports.DISCOUNT_MOREKA = 0.08;
exports.DISCOUNT_OTHER = 0.07;
function isMorekaProduct(sku, productName) {
    const s = (sku || '').toUpperCase();
    const p = (productName || '').toUpperCase();
    return s.includes('MOR') || p.includes('MOREKA');
}
function getDiscountPct(sku, productName) {
    return isMorekaProduct(sku, productName) ? exports.DISCOUNT_MOREKA : exports.DISCOUNT_OTHER;
}
function calculateCreditNotes(stockItems, newPrice) {
    const creditNotes = [];
    let totalAmount = 0;
    let totalWithDiscount = 0;
    for (const item of stockItems) {
        if (item.availableForCredit <= 0)
            continue;
        if (newPrice >= item.originalCost)
            continue;
        const diff = item.originalCost - newPrice;
        const amount = diff * item.availableForCredit;
        const moreka = isMorekaProduct(item.sku, item.productName);
        const discountPct = moreka ? exports.DISCOUNT_MOREKA : exports.DISCOUNT_OTHER;
        const amountWithDiscount = amount * (1 - discountPct);
        creditNotes.push({
            receptionId: item.receptionId,
            sku: item.sku,
            productName: item.productName,
            oldCost: item.originalCost,
            newCost: newPrice,
            quantity: item.availableForCredit,
            marca: moreka ? 'Moreka' : 'Otra',
            discountPct,
            amountWithDiscount,
        });
        totalAmount += amount;
        totalWithDiscount += amountWithDiscount;
    }
    return { creditNotes, totalAmount, totalWithDiscount };
}
async function getStockForCredit(sku) {
    const result = await database_1.pool.query(`
    SELECT 
      r.id as receptionId,
      r.sku,
      r.product_name as productName,
      r.original_cost as originalCost,
      r.quantity_remaining as quantityRemaining,
      COALESCE(SUM(cn.quantity_credited), 0) as alreadyCredited
    FROM receptions r
    LEFT JOIN credit_notes cn ON cn.reception_id = r.id AND cn.status != 'cancelled'
    WHERE r.sku = $1
    GROUP BY r.id
    ORDER BY r.admission_date ASC
  `, [sku]);
    return result.rows.map((row) => ({
        receptionId: row.receptionid,
        sku: row.sku,
        productName: row.productname,
        originalCost: parseFloat(row.originalcost),
        quantityRemaining: parseInt(row.quantityremaining),
        alreadyCredited: parseInt(row.alreadycredited),
        availableForCredit: Math.max(0, parseInt(row.quantityremaining) - parseInt(row.alreadycredited)),
    }));
}
// Generate next folio for today: NC-YYYYMMDD-###
async function generateFolio(client) {
    const today = new Date();
    const ymd = today.getFullYear().toString()
        + String(today.getMonth() + 1).padStart(2, '0')
        + String(today.getDate()).padStart(2, '0');
    const prefix = `NC-${ymd}`;
    const result = await client.query(`SELECT folio FROM credit_notes WHERE folio LIKE $1 ORDER BY folio DESC LIMIT 1`, [`${prefix}-%`]);
    let seq = 1;
    if (result.rows.length > 0) {
        const lastFolio = result.rows[0].folio;
        const lastSeq = parseInt(lastFolio.split('-').pop() || '0', 10);
        if (!isNaN(lastSeq))
            seq = lastSeq + 1;
    }
    return `${prefix}-${String(seq).padStart(3, '0')}`;
}
async function saveCreditNotes(notes, pdfId, folio) {
    const client = await database_1.pool.connect();
    try {
        await client.query('BEGIN');
        // Generate folio if not provided
        const finalFolio = folio || await generateFolio(client);
        for (const note of notes) {
            const amount = (note.oldCost - note.newCost) * note.quantity;
            const moreka = isMorekaProduct(note.sku, note.productName);
            const discountPct = moreka ? exports.DISCOUNT_MOREKA : exports.DISCOUNT_OTHER;
            const amountWithDiscount = amount * (1 - discountPct);
            await client.query(`
        INSERT INTO credit_notes 
        (reception_id, sku, product_name, old_cost, new_cost, quantity_credited, amount, pdf_id, folio)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [note.receptionId, note.sku, note.productName, note.oldCost, note.newCost, note.quantity, amount, pdfId || null, finalFolio]);
        }
        await client.query('COMMIT');
        return finalFolio;
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}
async function getPendingCreditNotes() {
    const result = await database_1.pool.query(`
    SELECT cn.*, r.document_number, r.admission_date
    FROM credit_notes cn
    JOIN receptions r ON r.id = cn.reception_id
    WHERE cn.status = 'pending'
    ORDER BY cn.folio DESC, cn.created_at DESC
  `);
    return result.rows;
}
// Pending credit notes grouped by folio
async function getPendingByFolio() {
    const result = await database_1.pool.query(`
    SELECT 
      cn.folio,
      COUNT(*) as notes_count,
      SUM(cn.quantity_credited) as total_qty,
      SUM(cn.amount) as total_amount,
      SUM(cn.amount * (1 - CASE 
        WHEN UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%' 
        THEN ${exports.DISCOUNT_MOREKA} ELSE ${exports.DISCOUNT_OTHER} END)) as total_with_discount,
      bool_or(UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%') as has_moreka,
      bool_and(UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%') as all_moreka,
      MIN(cn.created_at) as created_at
    FROM credit_notes cn
    WHERE cn.status = 'pending'
    GROUP BY cn.folio
    ORDER BY cn.folio DESC
  `);
    return result.rows.map((r) => ({
        folio: r.folio,
        notesCount: parseInt(r.notes_count),
        totalQty: parseInt(r.total_qty),
        totalAmount: parseFloat(r.total_amount),
        totalWithDiscount: parseFloat(r.total_with_discount),
        brand: r.all_moreka ? 'Moreka' : (r.has_moreka ? 'Mixta' : 'Otra'),
        discountPct: r.all_moreka ? exports.DISCOUNT_MOREKA : (r.has_moreka ? null : exports.DISCOUNT_OTHER),
        createdAt: r.created_at,
    }));
}
async function markCreditNotePaid(id) {
    await database_1.pool.query(`UPDATE credit_notes SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
}
// Mark all credit notes of a folio as paid
async function markFolioPaid(folio) {
    const result = await database_1.pool.query(`UPDATE credit_notes SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE folio = $1 AND status = 'pending'`, [folio]);
    return result.rowCount || 0;
}
async function getCreditNoteSummary() {
    const pending = await database_1.pool.query(`
    SELECT 
      COALESCE(SUM(amount), 0) as total,
      COALESCE(SUM(amount * (1 - CASE 
        WHEN UPPER(sku) LIKE '%MOR%' OR UPPER(product_name) LIKE '%MOREKA%' 
        THEN ${exports.DISCOUNT_MOREKA} ELSE ${exports.DISCOUNT_OTHER} END)), 0) as total_with_discount
    FROM credit_notes WHERE status = 'pending'
  `);
    const paid = await database_1.pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM credit_notes WHERE status = 'paid'`);
    const count = await database_1.pool.query(`SELECT COUNT(*) as c FROM credit_notes WHERE status = 'pending'`);
    const folios = await database_1.pool.query(`SELECT COUNT(DISTINCT folio) as c FROM credit_notes WHERE status = 'pending'`);
    const totalPending = parseFloat(pending.rows[0].total);
    const totalPendingWithDiscount = parseFloat(pending.rows[0].total_with_discount);
    return {
        totalPending,
        totalPendingWithDiscount,
        totalDiscountAmount: totalPending - totalPendingWithDiscount,
        totalPaid: parseFloat(paid.rows[0].total),
        countPending: parseInt(count.rows[0].c),
        foliosPending: parseInt(folios.rows[0].c),
    };
}
async function deleteAllCreditNotes() {
    const result = await database_1.pool.query(`DELETE FROM credit_notes WHERE status = 'pending'`);
    return result.rowCount || 0;
}
