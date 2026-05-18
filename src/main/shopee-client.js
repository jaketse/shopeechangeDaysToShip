import { ProxyAgent } from 'undici';
import { getProxyConfig } from './proxy-config.js';

const FIXED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.5911.4 Safari/537.36';
const BASE = 'https://seller.shopee.tw';
const DEFAULT_REFERER = 'https://seller.shopee.tw/portal/product/list/live/all?operationSortBy=recommend_v2';
const DEFAULT_SC_FE_SESSION = '7E419DD0C34B6065';
const DEFAULT_SC_FE_VER = '21.146464';
let fetchFn = globalThis.fetch;
const proxyAgentCache = new Map();

async function ensureFetch() {
  if (fetchFn) return fetchFn;
  const mod = await import('node-fetch');
  fetchFn = mod.default;
  return fetchFn;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomSleep() { return sleep(500 + Math.floor(Math.random() * 1500)); }

function parseCookieJSON(cookieInput) {
  const input = (cookieInput || '').trim();
  if (!input) throw new Error('Cookie JSON 不能為空');
  if (!input.startsWith('{') && !input.startsWith('[')) {
    throw new Error('Cookie 必須是 JSON 格式（物件或陣列）');
  }

  let raw;
  try {
    raw = JSON.parse(input);
  } catch (e) {
    throw new Error(`Cookie JSON 解析失敗: ${e.message}`);
  }
  let obj = raw;
  if (Array.isArray(raw)) {
    obj = {};
    for (const item of raw) {
      if (item && item.name && item.value !== undefined) {
        obj[item.name] = String(item.value);
      }
    }
  }

  if (!obj.SPC_CDS_VER) obj.SPC_CDS_VER = '2';

  const required = ['SPC_CDS', 'SPC_SI', 'SPC_F', 'SPC_T_ID', 'SPC_T_IV', 'SPC_U'];
  for (const k of required) {
    if (!obj[k]) throw new Error(`Missing cookie: ${k}`);
  }
  return obj;
}

function cookieHeader(cookieMap) {
  return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(cookieMap, method, url, body) {
  const doFetch = await ensureFetch();
  const headers = {
    Cookie: cookieHeader(cookieMap),
    'User-Agent': FIXED_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
    Referer: DEFAULT_REFERER,
    Origin: BASE,
    DNT: '1',
    locale: 'zh-Hant',
    'caller-source': 'local_pc',
    'sc-fe-session': DEFAULT_SC_FE_SESSION,
    'sc-fe-ver': DEFAULT_SC_FE_VER,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Not/A)Brand";v="8.0.0.0", "Google Chrome";v="117.0.5911.4", "Chromium";v="117.0.5911.4"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };

  if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';

  const reqOpts = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };
  const p = getProxyConfig();
  if (p.enabled && p.url) {
    let agent = proxyAgentCache.get(p.url);
    if (!agent) {
      agent = new ProxyAgent(p.url);
      proxyAgentCache.set(p.url, agent);
    }
    reqOpts.dispatcher = agent;
  }
  const res = await doFetch(url, reqOpts);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export async function getShopInfo(cookieJSON) {
  const c = parseCookieJSON(cookieJSON);
  const u = `${BASE}/api/selleraccount/shop_info/?SPC_CDS=${encodeURIComponent(c.SPC_CDS)}&SPC_CDS_VER=2`;
  const data = await request(c, 'GET', u);
  if (data.code !== 0) throw new Error(data.message || 'shop_info failed');
  return data.data;
}

export async function fetchAllProducts(cookieJSON, onProgress, onPage, options = {}) {
  const c = parseCookieJSON(cookieJSON);
  let cursor = String(options?.startCursor || '');
  let page = Number(options?.startPage || 0);
  const pageSize = 12;
  const seenCursors = new Set();
  let totalProducts = Number(options?.knownTotal || 0);
  let totalPages = 0;
  let fetchedCount = Number(options?.fetchedCount || 0);

  if (cursor) {
    seenCursors.add(cursor);
  }

  while (true) {
    page += 1;
    onProgress?.(`Fetching page ${page}`);

    const qs = new URLSearchParams({
      SPC_CDS: c.SPC_CDS,
      SPC_CDS_VER: '2',
      page_size: String(pageSize),
      list_type: 'live_all',
      request_attribute: '',
      operation_sort_by: 'recommend_v2',
      need_ads: 'true',
    });
    if (cursor) qs.set('cursor', cursor);

    const u = `${BASE}/api/v3/opt/mpsku/list/v2/search_product_list?${qs.toString()}`;
    const data = await request(c, 'GET', u);
    if (data.code !== 0) throw new Error(data.message || 'search_product_list failed');

    const list = data.data?.product_list || data.data?.products || [];
    totalProducts = Number(data?.data?.page_info?.total || totalProducts || 0);
    totalPages = totalProducts > 0 ? Math.ceil(totalProducts / pageSize) : totalPages;
    onProgress?.(`Page ${page} product_list=${list.length}`);
    const normalizedList = [];
    for (const p of list) {
      const normalized = normalizeProduct(p);
      if (normalized.product_id) normalizedList.push(normalized);
    }
    fetchedCount += normalizedList.length;
    const percent = totalProducts > 0 ? Math.min(100, Math.floor((fetchedCount / totalProducts) * 100)) : 0;
    onProgress?.(`Progress fetch: page=${page}/${totalPages || '?'} products=${fetchedCount}/${totalProducts || '?'} percent=${percent}`);
    const nextCursor = data.data?.next_cursor || data.data?.page_info?.cursor || '';
    onPage?.(normalizedList, { page, totalPages, totalProducts, fetchedCount, percent, nextCursor });

    cursor = nextCursor;
    if (cursor && seenCursors.has(cursor)) break;
    if (cursor) seenCursors.add(cursor);
    if (!cursor) break;
    await randomSleep();
  }

  if (fetchedCount > 0) return { totalProducts: fetchedCount };
  onProgress?.('search_product_list returned 0, fallback to get_product_list');
  return fetchAllProductsFallback(c, onProgress, onPage, { startPage: Number(options?.startPageNumber || 1), knownTotal: totalProducts, fetchedCount });
}

function normalizeProduct(p) {
  const id = p?.id ?? p?.product_id ?? p?.item_id;
  return {
    product_id: id,
    name: p?.name || '',
    image: p?.image || p?.cover || p?.cover_image || '',
    price: p?.price_info?.min_price || p?.price_detail?.selling_price_min || p?.price_detail?.price_min || p?.price || '',
    stock: p?.stock_info?.total_stock ?? p?.stock_detail?.total_available_stock ?? p?.stock ?? 0,
    days_to_ship: p?.pre_order_info?.days_to_ship ?? p?.days_to_ship ?? 0,
    status: p?.status ?? 0,
    is_pre_order: Boolean(p?.pre_order_info?.pre_order ?? p?.is_pre_order),
  };
}

async function fetchAllProductsFallback(c, onProgress, onPage, options = {}) {
  const listTypes = 'live_all,all,restock,review_listing_detail,improve_new_product,banned,deboosted,deleted,reviewing,delisted,draft';
  const countUrl = `${BASE}/api/v3/opt/mpsku/list/v2/get_list_count?SPC_CDS=${encodeURIComponent(c.SPC_CDS)}&SPC_CDS_VER=2&list_types=${encodeURIComponent(listTypes)}`;
  const countData = await request(c, 'GET', countUrl);
  if (countData.code !== 0) throw new Error(countData.message || 'get_list_count failed');

  const countMap = countData?.data || {};
  let total = Number(countMap.live_all ?? countMap.all ?? 0);
  if ((!Number.isFinite(total) || total <= 0) && Array.isArray(countMap.count_infos)) {
    const live = countMap.count_infos.find((x) => x?.list_type === 'live_all');
    const allType = countMap.count_infos.find((x) => x?.list_type === 'all');
    total = Number(live?.count ?? allType?.count ?? 0);
  }
  if (!Number.isFinite(total) || total <= 0) return [];

  const pageSize = 20;
  const totalPage = Math.ceil(total / pageSize);
  let fetchedCount = Number(options?.fetchedCount || 0);
  let startPage = Number(options?.startPage || 1);
  if (!Number.isFinite(startPage) || startPage < 1) startPage = 1;
  if (startPage > totalPage) startPage = totalPage;
  for (let pageNumber = startPage; pageNumber <= totalPage; pageNumber += 1) {
    onProgress?.(`Fallback fetching page ${pageNumber}/${totalPage}`);
    const qs = new URLSearchParams({
      SPC_CDS: c.SPC_CDS,
      SPC_CDS_VER: '2',
      page_number: String(pageNumber),
      page_size: String(pageSize),
      list_type: 'live_all',
      request_attribute: '',
      need_ads: 'true',
      operation_sort_by: 'recommend_v2',
    });
    const url = `${BASE}/api/v3/opt/mpsku/list/v2/get_product_list?${qs.toString()}`;
    const data = await request(c, 'GET', url);
    if (data.code !== 0) throw new Error(data.message || 'get_product_list failed');
    const list = data?.data?.product_list || data?.data?.products || data?.data?.list || [];
    const normalizedList = [];
    for (const p of list) {
      const normalized = normalizeProduct(p);
      if (normalized.product_id) normalizedList.push(normalized);
    }
    fetchedCount += normalizedList.length;
    const percent = Math.min(100, Math.floor((pageNumber / totalPage) * 100));
    onProgress?.(`Progress fetch: page=${pageNumber}/${totalPage} products=${fetchedCount}/${total} percent=${percent}`);
    onPage?.(normalizedList, { page: pageNumber, totalPages: totalPage, totalProducts: total, fetchedCount, percent, nextCursor: '' });
    await randomSleep();
  }
  return { totalProducts: fetchedCount };
}

export async function getProductDetail(cookieJSON, productId) {
  const c = parseCookieJSON(cookieJSON);
  const qs = new URLSearchParams({
    SPC_CDS: c.SPC_CDS,
    SPC_CDS_VER: '2',
    product_ids: String(productId),
  });
  const u = `${BASE}/api/v3/opt/mpsku/list/v2/get_product_extensive_info?${qs.toString()}`;
  return request(c, 'GET', u);
}

async function getProductInfoById(cookieMap, productId, isDraft = false) {
  const qs = new URLSearchParams({
    SPC_CDS: cookieMap.SPC_CDS,
    SPC_CDS_VER: '2',
    product_id: String(productId),
    is_draft: String(Boolean(isDraft)),
  });
  const u = `${BASE}/api/v3/product/get_product_info?${qs.toString()}`;
  const data = await request(cookieMap, 'GET', u);
  if (data.code !== 0) throw new Error(data.message || data.msg || 'get_product_info failed');
  return data.data?.product_info || null;
}

export async function getProductInfo(cookieJSON, productId, isDraft = false) {
  const c = parseCookieJSON(cookieJSON);
  return getProductInfoById(c, productId, isDraft);
}

export async function updateDaysToShip(cookieJSON, productId, days, existingInfo = null) {
  const c = parseCookieJSON(cookieJSON);
  const qs = new URLSearchParams({ SPC_CDS: c.SPC_CDS, SPC_CDS_VER: '2' });
  const u = `${BASE}/api/v3/product/update_product_info?${qs.toString()}`;
  const info = existingInfo || await getProductInfoById(c, productId, false);
  if (!info) throw new Error('get_product_info returned empty product_info');

  const basePreOrder = info.pre_order_info || {};

  const body = {
    product_id: productId,
    product_info: {
      enable_model_level_dts: Boolean(info.enable_model_level_dts),
      description_info: info.description_info,
      pre_order_info: {
        ...basePreOrder,
        pre_order: days > 0,
        days_to_ship: days,
      },
    },
    is_draft: false,
  };

  const data = await request(c, 'POST', u, body);
  if (data.code !== 0) throw new Error(data.message || 'update_product_info failed');
}

export { randomSleep };

