"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bsaleFetch = bsaleFetch;
exports.getVariantBySku = getVariantBySku;
exports.getStock = getStock;
exports.getCosts = getCosts;
exports.getProductName = getProductName;
exports.formatBsaleDate = formatBsaleDate;
const BSALE_BASE_URL = 'https://api.bsale.io/v1';
const TOKEN = process.env.BSALE_ACCESS_TOKEN || '';
async function bsaleFetch(endpoint) {
    const url = `${BSALE_BASE_URL}${endpoint}`;
    const res = await fetch(url, { headers: { access_token: TOKEN } });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Bsale API error ${res.status}: ${text}`);
    }
    return res.json();
}
async function getVariantBySku(sku) {
    const data = await bsaleFetch(`/variants.json?code=${sku}&limit=5`);
    return data.items?.[0] || null;
}
async function getStock(variantId, officeId = 2) {
    const data = await bsaleFetch(`/stocks.json?variantid=${variantId}&officeid=${officeId}&limit=5`);
    return data.items?.[0] || null;
}
async function getCosts(variantId) {
    return bsaleFetch(`/variants/${variantId}/costs.json`);
}
async function getProductName(productId) {
    const data = await bsaleFetch(`/products/${productId}.json`);
    return data.name || 'Sin nombre';
}
function formatBsaleDate(timestamp) {
    const d = new Date(timestamp * 1000);
    return d.toISOString().split('T')[0];
}
