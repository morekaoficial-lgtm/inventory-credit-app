import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'inventory_credit',
  user: process.env.DB_USER || 'inventory_user',
  password: process.env.DB_PASS || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS receptions (
        id INTEGER PRIMARY KEY,
        variant_id INTEGER NOT NULL,
        sku TEXT NOT NULL,
        product_name TEXT,
        document_number TEXT,
        admission_date INTEGER,
        original_cost NUMERIC(12,2) NOT NULL,
        quantity_received INTEGER NOT NULL,
        quantity_remaining INTEGER NOT NULL,
        bsale_reception_detail_id INTEGER,
        bsale_reception_id INTEGER,
        office_id INTEGER DEFAULT 2,
        office_name TEXT,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_receptions_sku ON receptions(sku)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_receptions_variant ON receptions(variant_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_notes (
        id SERIAL PRIMARY KEY,
        reception_id INTEGER NOT NULL REFERENCES receptions(id),
        sku TEXT NOT NULL,
        product_name TEXT,
        old_cost NUMERIC(12,2) NOT NULL,
        new_cost NUMERIC(12,2) NOT NULL,
        quantity_credited INTEGER NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        pdf_id INTEGER,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_credit_notes_sku ON credit_notes(sku)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_credit_notes_reception ON credit_notes(reception_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS price_pdfs (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL,
        original_name TEXT,
        supplier TEXT,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed BOOLEAN DEFAULT FALSE,
        processed_at TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pdf_items (
        id SERIAL PRIMARY KEY,
        pdf_id INTEGER NOT NULL REFERENCES price_pdfs(id),
        model TEXT,
        sku TEXT,
        new_price NUMERIC(12,2),
        extracted_text TEXT
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_pdf_items_model ON pdf_items(model)`);

    // Migration: add office_name to receptions if not exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='receptions' AND column_name='office_name') THEN
          ALTER TABLE receptions ADD COLUMN office_name TEXT;
        END IF;
      END $$;
    `);

    // Offices cache table
    await client.query(`
      CREATE TABLE IF NOT EXISTS offices (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // product_mappings: allow multiple SKUs per model (variants)
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_mappings (
        id SERIAL PRIMARY KEY,
        model TEXT NOT NULL,
        sku TEXT NOT NULL,
        product_name TEXT,
        variant_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(model, sku)
      )
    `);

    // Migration: drop old unique constraint on model if it exists (from previous schema)
    await client.query(`
      DO $$
      BEGIN
        ALTER TABLE product_mappings DROP CONSTRAINT IF EXISTS product_mappings_model_key;
      EXCEPTION WHEN undefined_table THEN
        NULL;
      END $$;
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_mappings_model ON product_mappings(model)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mappings_sku ON product_mappings(sku)`);

    // Normalize function for fuzzy model matching
    await client.query(`
      CREATE OR REPLACE FUNCTION normalize_model(text)
      RETURNS text AS $$
      BEGIN
        RETURN lower(regexp_replace($1, '[-\s]', '', 'g'));
      END;
      $$ LANGUAGE plpgsql IMMUTABLE;
    `);

    console.log('Database initialized');
  } finally {
    client.release();
  }
}
