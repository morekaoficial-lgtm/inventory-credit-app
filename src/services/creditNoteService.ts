import { pool } from '../config/database';

// ============================================
// BRAND DISCOUNT RULES
// Moreka = 8% discount | Other brands = 7% discount
// ============================================
export const DISCOUNT_MOREKA = 0.08;
export const DISCOUNT_OTHER = 0.07;

export function isMorekaProduct(sku: string, productName?: string): boolean {
  const s = (sku || '').toUpperCase();
  const p = (productName || '').toUpperCase();
  return s.includes('MOR') || p.includes('MOREKA');
}

export function getDiscountPct(sku: string, productName?: string): number {
  return isMorekaProduct(sku, productName) ? DISCOUNT_MOREKA : DISCOUNT_OTHER;
}

export interface CreditNoteInput {
  receptionId: number;
  sku: string;
  productName: string;
  oldCost: number;
  newCost: number;
  quantity: number;
  marca?: string;
  discountPct?: number;
  amountWithDiscount?: number;
}

export interface StockForCredit {
  receptionId: number;
  sku: string;
  productName: string;
  originalCost: number;
  quantityRemaining: number;
  alreadyCredited: number;
  availableForCredit: number;
}

export function calculateCreditNotes(stockItems: StockForCredit[], newPrice: number) {
  const creditNotes: CreditNoteInput[] = [];
  let totalAmount = 0;
  let totalWithDiscount = 0;

  for (const item of stockItems) {
    if (item.availableForCredit <= 0) continue;
    if (newPrice >= item.originalCost) continue;

    const diff = item.originalCost - newPrice;
    const amount = diff * item.availableForCredit;
    const moreka = isMorekaProduct(item.sku, item.productName);
    const discountPct = moreka ? DISCOUNT_MOREKA : DISCOUNT_OTHER;
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

export async function getStockForCredit(sku: string): Promise<StockForCredit[]> {
  const result = await pool.query(`
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

  return result.rows.map((row: any) => ({
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
async function generateFolio(client: any): Promise<string> {
  const today = new Date();
  const ymd = today.getFullYear().toString()
    + String(today.getMonth() + 1).padStart(2, '0')
    + String(today.getDate()).padStart(2, '0');
  const prefix = `NC-${ymd}`;
  const result = await client.query(
    `SELECT folio FROM credit_notes WHERE folio LIKE $1 ORDER BY folio DESC LIMIT 1`,
    [`${prefix}-%`]
  );
  let seq = 1;
  if (result.rows.length > 0) {
    const lastFolio = result.rows[0].folio as string;
    const lastSeq = parseInt(lastFolio.split('-').pop() || '0', 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

export async function saveCreditNotes(notes: CreditNoteInput[], pdfId?: number, folio?: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Generate folio if not provided
    const finalFolio = folio || await generateFolio(client);

    for (const note of notes) {
      const amount = (note.oldCost - note.newCost) * note.quantity;
      const moreka = isMorekaProduct(note.sku, note.productName);
      const discountPct = moreka ? DISCOUNT_MOREKA : DISCOUNT_OTHER;
      const amountWithDiscount = amount * (1 - discountPct);
      await client.query(`
        INSERT INTO credit_notes 
        (reception_id, sku, product_name, old_cost, new_cost, quantity_credited, amount, pdf_id, folio)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [note.receptionId, note.sku, note.productName, note.oldCost, note.newCost, note.quantity, amount, pdfId || null, finalFolio]);
    }
    await client.query('COMMIT');
    return finalFolio;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getPendingCreditNotes(): Promise<any[]> {
  const result = await pool.query(`
    SELECT cn.*, r.document_number, r.admission_date
    FROM credit_notes cn
    JOIN receptions r ON r.id = cn.reception_id
    WHERE cn.status = 'pending'
    ORDER BY cn.folio DESC, cn.created_at DESC
  `);
  return result.rows;
}

// Pending credit notes grouped by folio
export async function getPendingByFolio(): Promise<any[]> {
  const result = await pool.query(`
    SELECT 
      cn.folio,
      COUNT(*) as notes_count,
      SUM(cn.quantity_credited) as total_qty,
      SUM(cn.amount) as total_amount,
      SUM(cn.amount * (1 - CASE 
        WHEN UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%' 
        THEN ${DISCOUNT_MOREKA} ELSE ${DISCOUNT_OTHER} END)) as total_with_discount,
      bool_or(UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%') as has_moreka,
      bool_and(UPPER(cn.sku) LIKE '%MOR%' OR UPPER(cn.product_name) LIKE '%MOREKA%') as all_moreka,
      MIN(cn.created_at) as created_at
    FROM credit_notes cn
    WHERE cn.status = 'pending'
    GROUP BY cn.folio
    ORDER BY cn.folio DESC
  `);
  return result.rows.map((r: any) => ({
    folio: r.folio,
    notesCount: parseInt(r.notes_count),
    totalQty: parseInt(r.total_qty),
    totalAmount: parseFloat(r.total_amount),
    totalWithDiscount: parseFloat(r.total_with_discount),
    brand: r.all_moreka ? 'Moreka' : (r.has_moreka ? 'Mixta' : 'Otra'),
    discountPct: r.all_moreka ? DISCOUNT_MOREKA : (r.has_moreka ? null : DISCOUNT_OTHER),
    createdAt: r.created_at,
  }));
}

export async function markCreditNotePaid(id: number): Promise<void> {
  await pool.query(`UPDATE credit_notes SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
}

// Mark all credit notes of a folio as paid
export async function markFolioPaid(folio: string): Promise<number> {
  const result = await pool.query(
    `UPDATE credit_notes SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE folio = $1 AND status = 'pending'`,
    [folio]
  );
  return result.rowCount || 0;
}

export async function getCreditNoteSummary() {
  const pending = await pool.query(`
    SELECT 
      COALESCE(SUM(amount), 0) as total,
      COALESCE(SUM(amount * (1 - CASE 
        WHEN UPPER(sku) LIKE '%MOR%' OR UPPER(product_name) LIKE '%MOREKA%' 
        THEN ${DISCOUNT_MOREKA} ELSE ${DISCOUNT_OTHER} END)), 0) as total_with_discount
    FROM credit_notes WHERE status = 'pending'
  `);
  const paid = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM credit_notes WHERE status = 'paid'`);
  const count = await pool.query(`SELECT COUNT(*) as c FROM credit_notes WHERE status = 'pending'`);
  const folios = await pool.query(`SELECT COUNT(DISTINCT folio) as c FROM credit_notes WHERE status = 'pending'`);
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

export async function deleteAllCreditNotes(): Promise<number> {
  const result = await pool.query(`DELETE FROM credit_notes WHERE status = 'pending'`);
  return result.rowCount || 0;
}
