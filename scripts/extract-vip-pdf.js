const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');

/**
 * Extract products from VIP PDF catalogues.
 *
 * The PDF text has fields on separate lines:
 *   $238
 *   FS-133
 *   12
 *   VENTILADOR CON PANEL SOLAR...
 *
 * We need to detect price lines ($xxx) and find the model
 * in the following lines.
 */
function parseVipCatalog(text, sourceFile) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const results = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect price line: starts with $ followed by number
    const priceMatch = line.match(/^\$\s*([\d,.]+)$/);
    if (!priceMatch) continue;

    let priceStr = priceMatch[1].replace(',', '.');
    const precioNuevo = parseFloat(priceStr);
    if (isNaN(precioNuevo) || precioNuevo <= 0 || precioNuevo > 5000) continue;

    // Look ahead for model code in next few lines
    let modelo = null;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const candidate = lines[j];
      if (candidate.length < 2 || candidate.length > 25) continue;
      if (candidate.match(/^\d+$/)) continue; // skip pure numbers (quantities)
      if (candidate.toLowerCase().includes('cajas')) continue;
      if (candidate.toLowerCase().includes('ventilador')) continue;
      if (candidate.toLowerCase().includes('powerbank')) continue;
      if (candidate.toLowerCase().includes('bocina')) continue;
      if (candidate.toLowerCase().includes('smartwatch')) continue;
      if (candidate.toLowerCase().includes('cargador')) continue;
      if (candidate.toLowerCase().includes('soporte')) continue;
      if (candidate.startsWith('$')) break; // next price found

      // Try to extract model from "MODEL QTY" patterns like "SF110 40" or "K103 60"
      const modelWithSpaceQty = candidate.match(/^([A-Z]{1,4}-?\d{2,5}[A-Z]?)\s+\d+$/);
      if (modelWithSpaceQty) {
        modelo = modelWithSpaceQty[1];
        break;
      }

      // Try plain model: FS-133, K109, SF110, MT-02140, etc.
      const modelMatch = candidate.match(/^[A-Z]{1,4}-?\d{2,5}[A-Z]?$/);
      if (modelMatch) {
        modelo = modelMatch[0];
        break;
      }

      // Handle cases where model and quantity are concatenated: SF11040, K10360
      // Common box quantities: 12, 20, 24, 40, 48, 50, 60, 100
      const concatMatch = candidate.match(/^([A-Z]{1,4}-?\d{2,5}[A-Z]?)(12|20|24|40|48|50|60|100)$/);
      if (concatMatch) {
        modelo = concatMatch[1];
        break;
      }
    }

    if (!modelo) continue;

    // Skip duplicates
    const key = `${modelo}-${precioNuevo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ modelo, precioNuevo, sourceFile: path.basename(sourceFile) });
  }

  return results;
}

async function processPdf(pdfPath) {
  console.log(`Processing: ${path.basename(pdfPath)}...`);
  try {
    const buffer = fs.readFileSync(pdfPath);
    const data = await pdfParse(buffer);
    const products = parseVipCatalog(data.text, pdfPath);
    console.log(`  -> Found ${products.length} products`);
    return products;
  } catch (e) {
    console.error(`  -> ERROR: ${e.message}`);
    return [];
  }
}

async function main() {
  const inputDir = process.argv[2] || './downloads';
  const outputPath = process.argv[3] || './vip-precios.xlsx';

  // Only process the specific VIP PDFs passed by user
  const targetFiles = [
    '19fed242-6b82-84e1-8000-000003e58e02_VENTILADOR_VIP_1_.pdf',
    '19fed23e-6962-8e40-8000-00001d7e0143_SMARTWATCH_VIP.pdf',
    '19fed23f-5a22-8c97-8000-0000bbb8ed74_POWERBANK_VIP.pdf',
    '19fed23f-30a2-8678-8000-0000b2eed1fd_OTRO_VIP.pdf',
    '19fed243-aa12-8fce-8000-0000c09401a0_MULTICONTACTO_RASURADORA_SOPORTE_VIP_1_.pdf',
    '19fed246-8912-860c-8000-0000e5745a3e_CARGADOR_CABLE_PULGIN_VIP_1_.pdf',
    '19fed244-7422-8c05-8000-0000b671534b_BOCINA_2_VIP.pdf',
    '19fed246-4472-86c3-8000-000076784bcb_BOCINA_1_VIP.pdf',
  ];

  const pdfFiles = targetFiles
    .map(f => path.join(inputDir, f))
    .filter(f => fs.existsSync(f));

  console.log(`Processing ${pdfFiles.length} VIP PDF files...\n`);

  let allResults = [];
  for (const pdfPath of pdfFiles) {
    const products = await processPdf(pdfPath);
    allResults = allResults.concat(products);
  }

  if (allResults.length === 0) {
    console.log('\n❌ No products extracted.');
    return;
  }

  // Remove duplicates
  const seen = new Set();
  const unique = [];
  for (const r of allResults) {
    if (!seen.has(r.modelo)) {
      seen.add(r.modelo);
      unique.push(r);
    }
  }

  // Build Excel
  const wsData = [['Modelo', 'PrecioNuevo'], ...unique.map(r => [r.modelo, r.precioNuevo])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 15 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Precios VIP');
  XLSX.writeFile(wb, outputPath);

  console.log(`\n✅ Excel generado: ${outputPath}`);
  console.log(`   Total productos: ${unique.length}`);
  console.log(`\n   Productos:`);
  unique.forEach(r => console.log(`   ${r.modelo} -> $${r.precioNuevo}`));
}

main().catch(console.error);
