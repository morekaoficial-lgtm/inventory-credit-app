import fetch from 'node-fetch';

const BSALE_BASE_URL = 'https://api.bsale.io/v1';
const TOKEN = process.env.BSALE_ACCESS_TOKEN || '';

export interface BsaleCost {
  reception_detail: { id: number; href: string };
  admissionDate: number;
  cost: number;
  availableFifo: number;
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

export async function getProductName(productId: string): Promise<string> {
  const data = await bsaleFetch(`/products/${productId}.json`);
  return data.name || 'Sin nombre';
}

export function formatBsaleDate(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return d.toISOString().split('T')[0];
}
