import { pool } from '../config/database';
import * as XLSX from 'xlsx';

/**
 * Normalize a model string for fuzzy matching:
 * - lowercase
 * - remove hyphens
 * - remove spaces
 */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/[-\s]/g, '')
    .trim();
}

/**
 * Load model-to-SKU mappings from an Excel buffer into the database.
 * Expects columns: Modelo, SKU
 */
export async function loadMappingsFromExcel(buffer: Buffer): Promise<{ inserted: number; errors: string[] }> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: any[] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

  const errors: string[] = [];
  let inserted = 0;

  // Detect header row (look for "Modelo" and "SKU")
  let dataStart = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const row = rows[i];
    if (row && row.length >= 2) {
      const first = String(row[0] || '').toLowerCase().trim();
      const second = String(row[1] || '').toLowerCase().trim();
      if (first.includes('modelo') || first.includes('model') || second.includes('sku')) {
        dataStart = i + 1;
        break;
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = dataStart; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 2) continue;

      const model = String(row[0] || '').trim();
      const sku = String(row[1] || '').trim();

      if (!model || !sku) continue;

      const normalized = normalizeModel(model);

      try {
        // Insert with (model, sku) unique constraint - allows multiple SKUs per model
        await client.query(
          `INSERT INTO product_mappings (model, sku, created_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (model, sku) DO NOTHING`,
          [model, sku]
        );

        // Also store a normalized lookup entry if different from original
        if (normalized !== model.toLowerCase().trim()) {
          await client.query(
            `INSERT INTO product_mappings (model, sku, created_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT (model, sku) DO NOTHING`,
            [normalized, sku]
          );
        }
        inserted++;
      } catch (e: any) {
        errors.push(`Row ${i + 1}: ${e.message}`);
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { inserted, errors };
}

/**
 * Find SKU(s) by model using fuzzy matching.
 * Tries exact match first, then normalized match.
 */
export async function findSkuByModel(model: string): Promise<string[]> {
  const normalized = normalizeModel(model);

  // 1. Exact match
  const exactResult = await pool.query(
    'SELECT sku FROM product_mappings WHERE model = $1',
    [model]
  );

  const skus = new Set<string>();
  for (const row of exactResult.rows) {
    skus.add(row.sku);
  }

  // 2. Normalized match
  const normalizedResult = await pool.query(
    'SELECT sku FROM product_mappings WHERE model = $1',
    [normalized]
  );

  for (const row of normalizedResult.rows) {
    skus.add(row.sku);
  }

  // 3. Partial normalized match (for cases like "405" matching "m405")
  if (skus.size === 0 && normalized.length >= 2) {
    const partialResult = await pool.query(
      `SELECT sku FROM product_mappings 
       WHERE normalize_model(model) LIKE $1 
       LIMIT 10`,
      [`%${normalized}%`]
    );
    for (const row of partialResult.rows) {
      skus.add(row.sku);
    }
  }

  return Array.from(skus);
}

/**
 * Get all mappings (for admin/debug)
 */
export async function getAllMappings(): Promise<{ model: string; sku: string }[]> {
  const result = await pool.query('SELECT model, sku FROM product_mappings ORDER BY model');
  return result.rows;
}

/**
 * Get mapping count
 */
export async function getMappingCount(): Promise<number> {
  const result = await pool.query('SELECT COUNT(*) as c FROM product_mappings');
  return parseInt(result.rows[0].c);
}

/**
 * Clear all mappings
 */
export async function clearMappings(): Promise<void> {
  await pool.query('DELETE FROM product_mappings');
}
