"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.initDatabase = initDatabase;
const pg_1 = require("pg");
exports.pool = new pg_1.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'inventory_credit',
    user: process.env.DB_USER || 'inventory_user',
    password: process.env.DB_PASS || '',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
async function initDatabase() {
    const client = await exports.pool.connect();
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
        await client.query(`
      CREATE TABLE IF NOT EXISTS product_mappings (
        id SERIAL PRIMARY KEY,
        model TEXT NOT NULL UNIQUE,
        sku TEXT NOT NULL,
        product_name TEXT,
        variant_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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
    }
    finally {
        client.release();
    }
}
