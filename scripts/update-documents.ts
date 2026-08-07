// Script para actualizar document_number de recepciones existentes
import { pool } from './src/config/database';
import { extractReceptionId, getReceptionDocumentNumber } from './src/services/bsaleService';

async function updateExistingReceptions() {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT id, bsale_reception_detail_id FROM receptions WHERE document_number IS NULL');
    console.log(`Encontradas ${result.rows.length} recepciones sin document_number`);

    for (const row of result.rows) {
      // El bsale_reception_detail_id es el ID del detalle, no del reception
      // Necesitamos buscar el receptionId. Pero no lo tenemos guardado.
      // Alternativa: hacer sync de nuevo para cada SKU
      console.log(`Recepción ${row.id} necesita re-sync manual`);
    }
    
    console.log('\\nPara actualizar todas las recepciones, ejecuta:');
    console.log('curl -X POST http://localhost:3001/api/sync/BOCMORNEG405');
    console.log('(reemplaza BOCMORNEG405 por cada SKU)');
  } finally {
    client.release();
    pool.end();
  }
}

updateExistingReceptions();
