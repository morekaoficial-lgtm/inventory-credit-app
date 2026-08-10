"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateCreditNotes = calculateCreditNotes;
exports.getStockForCredit = getStockForCredit;
exports.saveCreditNotes = saveCreditNotes;
exports.getPendingCreditNotes = getPendingCreditNotes;
exports.markCreditNotePaid = markCreditNotePaid;
exports.getCreditNoteSummary = getCreditNoteSummary;
exports.deleteAllCreditNotes = deleteAllCreditNotes;
const database_1 = require("../config/database");
function calculateCreditNotes(stockItems, newPrice) {
    const creditNotes = [];
    let totalAmount = 0;
    for (const item of stockItems) {
        if (item.availableForCredit <= 0)
            continue;
        if (newPrice >= item.originalCost)
            continue;
        const diff = item.originalCost - newPrice;
        const amount = diff * item.availableForCredit;
        creditNotes.push({
            receptionId: item.receptionId,
            sku: item.sku,
            productName: item.productName,
            oldCost: item.originalCost,
            newCost: newPrice,
            quantity: item.availableForCredit,
        });
        totalAmount += amount;
    }
    return { creditNotes, totalAmount };
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
async function saveCreditNotes(notes, pdfId) {
    const client = await database_1.pool.connect();
    try {
        await client.query('BEGIN');
        for (const note of notes) {
            const amount = (note.oldCost - note.newCost) * note.quantity;
            await client.query(`
        INSERT INTO credit_notes 
        (reception_id, sku, product_name, old_cost, new_cost, quantity_credited, amount, pdf_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [note.receptionId, note.sku, note.productName, note.oldCost, note.newCost, note.quantity, amount, pdfId || null]);
        }
        await client.query('COMMIT');
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
    ORDER BY cn.created_at DESC
  `);
    return result.rows;
}
async function markCreditNotePaid(id) {
    await database_1.pool.query(`UPDATE credit_notes SET status = 'paid' WHERE id = $1`, [id]);
}
async function getCreditNoteSummary() {
    const pending = await database_1.pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM credit_notes WHERE status = 'pending'`);
    const paid = await database_1.pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM credit_notes WHERE status = 'paid'`);
    const count = await database_1.pool.query(`SELECT COUNT(*) as c FROM credit_notes WHERE status = 'pending'`);
    return {
        totalPending: parseFloat(pending.rows[0].total),
        totalPaid: parseFloat(paid.rows[0].total),
        countPending: parseInt(count.rows[0].c),
    };
}
async function deleteAllCreditNotes() {
    const result = await database_1.pool.query(`DELETE FROM credit_notes WHERE status = 'pending'`);
    return result.rowCount || 0;
}
