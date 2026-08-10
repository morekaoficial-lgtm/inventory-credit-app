const BSALE_BASE_URL = 'https://api.bsale.io/v1';
const TOKEN = process.env.BSALE_ACCESS_TOKEN || '';

export interface BsaleCost {
  reception_detail: { id: number; href: string };
  admissionDate: number;
  cost: number;
  availableFifo: number;
  documentNumber?: string | null;
}

export interface BsaleCostsResponse {
  averageCost: number;
  totalCost: number;
  history: BsaleCost[];
}

export async function bsaleFetch(endpoint: string): Promise<any> {
  const url = `${BSALE_BASE_URL}${endpoint}`;
  const res = await fetch(url, { headers: { access_token: TOKEN } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bsale API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getVariantBySku(sku: string): Promise<any | null> {
  const data = await bsaleFetch(`/variants.json?code=${sku}&limit=5`);
  return data.items?.[0] || null;
}

export async function getStock(variantId: number, officeId = 2): Promise<any | null> {
  const data = await bsaleFetch(`/stocks.json?variantid=${variantId}&officeid=${officeId}&limit=5`);
  return data.items?.[0] || null;
}

export async function getCosts(variantId: number): Promise<BsaleCostsResponse> {
  return bsaleFetch(`/variants/${variantId}/costs.json`);
}

// Extrae el receptionId del href de reception_detail
// href: https://api.bsale.io/v1/stocks/receptions/16514/details/31820.json
export function extractReceptionId(href: string): number | null {
  const match = href.match(/\/receptions\/(\d+)\/details\//);
  return match ? parseInt(match[1]) : null;
}

export async function getReceptionDocumentNumber(receptionId: number): Promise<string | null> {
  try {
    const data = await bsaleFetch(`/stocks/receptions/${receptionId}.json`);
    return data.documentNumber || null;
  } catch {
    return null;
  }
}

export async function getCostsWithDocumentNumbers(variantId: number): Promise<BsaleCostsResponse> {
  const costs = await getCosts(variantId);
  
  const history: BsaleCost[] = await Promise.all(
    costs.history.map(async (item) => {
      const receptionId = extractReceptionId(item.reception_detail.href);
      if (receptionId) {
        const documentNumber = await getReceptionDocumentNumber(receptionId);
        return { ...item, documentNumber };
      }
      return item;
    })
  );
  
  return { ...costs, history };
}

export async function getProductName(productId: string): Promise<string> {
  const data = await bsaleFetch(`/products/${productId}.json`);
  return data.name || 'Sin nombre';
}

export function formatBsaleDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return d.toISOString().split('T')[0];
}

// Offices / Sucursales
export async function getOffice(officeId: number): Promise<{ id: number; name: string } | null> {
  try {
    const data = await bsaleFetch(`/offices/${officeId}.json`);
    return { id: officeId, name: data.name || `Sucursal ${officeId}` };
  } catch {
    return null;
  }
}

export async function getAllOffices(): Promise<{ id: number; name: string }[]> {
  try {
    const data = await bsaleFetch('/offices.json?limit=50');
    return (data.items || []).map((o: any) => ({ id: o.id, name: o.name }));
  } catch {
    return [];
  }
}
