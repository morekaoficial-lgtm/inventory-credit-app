import { pool } from '../config/database';
import { getVariantBySku, getStockAllOffices } from './bsaleService';
import { isMorekaProduct, getDiscountPct } from './creditNoteService';

export interface LastReceptionOld {
  documento: string | null;
  fecha: string | null;
  sucursal: string | null;
  costo: number;
}

export interface CreditReportRow {
  sku: string;
  producto: string;
  marca: string;
  primeraRcPrecioNuevo: string | null;
  fechaPrimeraRc: string | null;
  sucursalStockNuevo: string | null;
  stockNuevo: number;
  precioNuevo: number;
  ultimasRcPrecioViejo: LastReceptionOld[];
  precioViejo: number | null;
  diferenciaUnitaria: number | null;
  descuentoPct: number;
  totalSinDescuento: number | null;
  totalNotaCredito: number | null;
  stockPorSucursal: { sucursal: string; stock: number }[];
  totalStock: number;
}

function formatDate(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp * 1000);
  return d.toISOString().split('T')[0];
}

export async function generateCreditReport(sku: string, newPrice: number): Promise<CreditReportRow> {
  const client = await pool.connect();
  try {
    // Traer todas las recepciones del SKU con sus creditos ya aplicados
    const receptionsResult = await client.query(`
      SELECT 
        r.id,
        r.document_number,
        r.admission_date,
        r.original_cost,
        r.quantity_remaining,
        r.office_name,
        COALESCE(SUM(cn.quantity_credited), 0) as already_credited
      FROM receptions r
      LEFT JOIN credit_notes cn ON cn.reception_id = r.id AND cn.status != 'cancelled'
      WHERE r.sku = $1
      GROUP BY r.id, r.document_number, r.admission_date, r.original_cost, r.quantity_remaining, r.office_name
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

    const moreka = isMorekaProduct(sku, productName);
    const marca = moreka ? 'Moreka' : 'Otra';
    const descuentoPct = getDiscountPct(sku, productName);

    // Separar recepciones por precio
    const receptionsNewPrice = receptions.filter((r: any) => parseFloat(r.original_cost) === newPrice);
    const receptionsOldPrice = receptions.filter((r: any) => parseFloat(r.original_cost) > newPrice);

    // Solo recepciones con documento INV- (recepcion formal)
    const receptionsNewPriceInv = receptionsNewPrice.filter((r: any) => r.document_number && r.document_number.toUpperCase().startsWith('INV-'));
    const receptionsOldPriceInv = receptionsOldPrice.filter((r: any) => r.document_number && r.document_number.toUpperCase().startsWith('INV-'));

    // Para precio NUEVO: tomar la PRIMERA (mas antigua) con INV-
    const firstNew = receptionsNewPriceInv.length > 0 ? receptionsNewPriceInv[0] : null;
    const stockNuevo = receptionsNewPrice.reduce((sum: number, r: any) => sum + parseInt(r.quantity_remaining), 0);

    // Para precio VIEJO: tomar las ULTIMAS 3 (mas nuevas) con INV-
    const lastThreeOld = receptionsOldPriceInv.slice(-3).reverse(); // mas reciente primero

    const ultimasRcPrecioViejo: LastReceptionOld[] = lastThreeOld.map((r: any) => ({
      documento: r.document_number || null,
      fecha: formatDate(r.admission_date),
      sucursal: r.office_name || null,
      costo: parseFloat(r.original_cost),
    }));

    // Stock viejo = suma de (quantity_remaining - already_credited) de recepciones con costo > newPrice
    // Se usa solo para el calculo interno, ya NO se expone como columna
    const stockViejo = receptionsOldPrice.reduce((sum: number, r: any) => {
      const available = parseInt(r.quantity_remaining) - parseInt(r.already_credited);
      return sum + Math.max(0, available);
    }, 0);

    const precioViejo = ultimasRcPrecioViejo.length > 0 ? ultimasRcPrecioViejo[0].costo : null;
    const diferenciaUnitaria = precioViejo !== null ? precioViejo - newPrice : null;
    const totalSinDescuento = diferenciaUnitaria !== null ? diferenciaUnitaria * stockViejo : null;
    const totalNotaCredito = totalSinDescuento !== null ? totalSinDescuento * (1 - descuentoPct) : null;

    // Obtener stock de TODAS las sucursales desde Bsale
    let stockPorSucursal: { sucursal: string; stock: number }[] = [];
    let totalStock = 0;
    try {
      const variant = await getVariantBySku(sku);
      if (variant) {
        const stocks = await getStockAllOffices(variant.id);
        stockPorSucursal = stocks.map((s) => ({ sucursal: s.officeName, stock: s.quantityAvailable }));
        totalStock = stocks.reduce((sum, s) => sum + s.quantityAvailable, 0);
      }
    } catch {
      // Si falla, dejar vacio
    }

    return {
      sku,
      producto: productName,
      marca,
      primeraRcPrecioNuevo: firstNew?.document_number || null,
      fechaPrimeraRc: formatDate(firstNew?.admission_date),
      sucursalStockNuevo: firstNew?.office_name || null,
      stockNuevo,
      precioNuevo: newPrice,
      ultimasRcPrecioViejo,
      precioViejo,
      diferenciaUnitaria,
      descuentoPct,
      totalSinDescuento,
      totalNotaCredito,
      stockPorSucursal,
      totalStock,
    };
  } finally {
    client.release();
  }
}
