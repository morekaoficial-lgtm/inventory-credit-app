import { pool } from '../config/database';

export interface CreditReportRow {
  producto: string;
  primeraRcPrecioNuevo: string | null;
  fechaPrimeraRc: string | null;
  stockNuevo: number;
  precioNuevo: number;
  ultimaRcPrecioViejo: string | null;
  fechaUltimaRc: string | null;
  precioViejo: number | null;
  stockViejo: number;
  diferenciaUnitaria: number | null;
  totalNotaCredito: number | null;
}

function formatDate(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp * 1000);
  return d.toISOString().split('T')[0];
}

export async function generateCreditReport(sku: string, newPrice: number): Promise<CreditReportRow> {
  const client = await pool.connect();
  try {
    // Traer todas las recepciones del SKU con sus créditos ya aplicados
    const receptionsResult = await client.query(`
      SELECT 
        r.id,
        r.document_number,
        r.admission_date,
        r.original_cost,
        r.quantity_remaining,
        COALESCE(SUM(cn.quantity_credited), 0) as already_credited
      FROM receptions r
      LEFT JOIN credit_notes cn ON cn.reception_id = r.id AND cn.status != 'cancelled'
      WHERE r.sku = $1
      GROUP BY r.id, r.document_number, r.admission_date, r.original_cost, r.quantity_remaining
      ORDER BY r.admission_date ASC
    `, [sku]);

    const receptions = receptionsResult.rows;

    if (!receptions.length) {
      throw new Error('No hay recepciones sincronizadas para este SKU');
    }

    const productName = (await client.query(
      'SELECT product_name FROM receptions WHERE sku = $1 LIMIT 1',
      [sku]
    )).rows[0]?.product_name || sku;

    // Separar recepciones por precio
    const receptionsNewPrice = receptions.filter((r: any) => parseFloat(r.original_cost) === newPrice);
    const receptionsOldPrice = receptions.filter((r: any) => parseFloat(r.original_cost) > newPrice);

    // Para precio NUEVO: tomar la PRIMERA (más antigua)
    const firstNew = receptionsNewPrice.length > 0 ? receptionsNewPrice[0] : null;
    const stockNuevo = receptionsNewPrice.reduce((sum: number, r: any) => sum + parseInt(r.quantity_remaining), 0);

    // Para precio VIEJO: tomar la ÚLTIMA (más nueva)
    const lastOld = receptionsOldPrice.length > 0 ? receptionsOldPrice[receptionsOldPrice.length - 1] : null;
    
    // Stock viejo = suma de (quantity_remaining - already_credited) de recepciones con costo > newPrice
    const stockViejo = receptionsOldPrice.reduce((sum: number, r: any) => {
      const available = parseInt(r.quantity_remaining) - parseInt(r.already_credited);
      return sum + Math.max(0, available);
    }, 0);

    const precioViejo = lastOld ? parseFloat(lastOld.original_cost) : null;
    const diferenciaUnitaria = precioViejo !== null ? precioViejo - newPrice : null;
    const totalNotaCredito = diferenciaUnitaria !== null ? diferenciaUnitaria * stockViejo : null;

    return {
      producto: productName,
      primeraRcPrecioNuevo: firstNew?.document_number || null,
      fechaPrimeraRc: formatDate(firstNew?.admission_date),
      stockNuevo,
      precioNuevo: newPrice,
      ultimaRcPrecioViejo: lastOld?.document_number || null,
      fechaUltimaRc: formatDate(lastOld?.admission_date),
      precioViejo,
      stockViejo,
      diferenciaUnitaria,
      totalNotaCredito,
    };
  } finally {
    client.release();
  }
}
