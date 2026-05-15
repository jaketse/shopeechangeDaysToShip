<template>
  <div class="wrap">
    <aside class="left">
      <h2>賬戶</h2>
      <div class="account-actions">
        <button class="primary" @click="toggleAddForm">{{ showAddForm ? "收起" : "添加賬戶" }}</button>
      </div>

      <div v-if="showAddForm" class="add-form">
        <input v-model="newShopId" placeholder="Shop ID" />
        <textarea v-model="newCookieJson" rows="6" placeholder="Cookie JSON" />
        <div class="add-row">
          <button class="primary" @click="addAccount">保存</button>
          <button @click="toggleAddForm">取消</button>
        </div>
      </div>

      <ul class="account-list" :class="{ disabled: switchingAccount }">
        <li v-for="a in accounts" :key="a.id" :class="{active: selectedId===a.id}" @click="selectAccount(a.id)">
          <div class="account-head">
            <span>{{ a.shop_name || '-' }} (#{{ a.shop_id }})</span>
            <span v-if="accountBadge(a.id)" class="account-badge">{{ accountBadge(a.id) }}</span>
          </div>
          <div class="row">
            <button @click.stop="startEditAccount(a)">編輯</button>
            <button @click.stop="validate(a.id)">驗證</button>
            <button @click.stop="removeAccount(a.id)">刪除</button>
          </div>
          <div v-if="editingAccountId===a.id" class="edit-form" @click.stop>
            <input v-model="editShopId" placeholder="Shop ID" />
            <textarea v-model="editCookieJson" rows="5" placeholder="Cookie JSON" />
            <div class="add-row">
              <button class="primary" @click="saveEditAccount(a.id)">保存</button>
              <button @click="cancelEditAccount">取消</button>
            </div>
          </div>
        </li>
      </ul>
    </aside>

    <main class="right">
      <div v-if="notice.text" :class="['notice', notice.type]">{{ notice.text }}</div>
      <div v-if="!selectedId" class="empty">
        <h3>請先選擇賬戶</h3>
        <p>左側選中已有賬戶，或先點「添加賬戶」。</p>
      </div>

      <template v-else>
        <header>
          <button :class="{activeTab: active==='products'}" @click="active='products'">商品列表</button>
          <button :class="{activeTab: active==='change'}" @click="active='change'">修改清單</button>
        </header>

        <section v-if="active==='products'">
          <div v-if="isAccountRunning(selectedId) || productProgressText" class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: `${productProgressPercent}%` }"></div>
            </div>
            <span>{{ productProgressText || '詳情拉取進行中...' }}</span>
            <button v-if="isAccountRunning(selectedId)" class="icon-btn danger" title="強制停止任務" @click="confirmStopTask" aria-label="強制停止任務">
              <span class="stop-dot"><span class="stop-square"></span></span>
            </button>
          </div>
          <div class="toolbar">
            <button :disabled="isAccountRunning(selectedId)" @click="fetchProducts">拉取商品</button>
            <button @click="loadProducts">刷新</button>
            <button @click="addCheckedToChangeList" :disabled="checked.size===0">加入修改清單（已選 {{ checked.size }}）</button>
          </div>
          <div class="toolbar">
            <input v-model.trim="productFilter" placeholder="搜尋 ID / 名稱" />
            <label class="inline"><input type="checkbox" v-model="onlyStale" /> 只看 Latest=N</label>
            <select v-model.number="productPageSize">
              <option :value="20">20 / 頁</option>
              <option :value="50">50 / 頁</option>
              <option :value="100">100 / 頁</option>
            </select>
          </div>
          <table>
            <thead><tr>
              <th>
                <select v-model="productBulkAction" @change="applyProductBulkAction">
                  <option value="">勾選操作</option>
                  <option value="select_page">選擇當前頁</option>
                  <option value="select_all">選擇全部</option>
                  <option value="unselect_page">取消當前頁</option>
                  <option value="unselect_all">取消全部</option>
                </select>
                <div class="pick-stat">已選 {{ checked.size }} / 本頁 {{ pagedProducts.length }}</div>
              </th>
              <th class="sortable" @click="toggleProductSort('product_id')">商品ID <span class="sort-arrow" :class="sortState(productSortKey, productSortDir, 'product_id')"></span></th>
              <th class="sortable" @click="toggleProductSort('name')">商品名稱 <span class="sort-arrow" :class="sortState(productSortKey, productSortDir, 'name')"></span></th>
              <th class="sortable" @click="toggleProductSort('days_to_ship')">備貨天數 <span class="sort-arrow" :class="sortState(productSortKey, productSortDir, 'days_to_ship')"></span></th>
              <th class="sortable" @click="toggleProductSort('exists_in_latest')">是否最新 <span class="sort-arrow" :class="sortState(productSortKey, productSortDir, 'exists_in_latest')"></span></th>
              <th class="sortable" @click="toggleProductSort('in_change_list')">是否在修改清單 <span class="sort-arrow" :class="sortState(productSortKey, productSortDir, 'in_change_list')"></span></th>
            </tr></thead>
            <tbody>
              <tr v-for="p in pagedProducts" :key="p.product_id" :class="{ stale: !p.exists_in_latest }">
                <td><input type="checkbox" :checked="checked.has(p.product_id)" @change="toggleCheck(p.product_id, $event.target.checked)" /></td>
                <td>{{ p.product_id }}</td><td>{{ p.name }}</td><td>{{ p.days_to_ship }}</td><td>{{ p.exists_in_latest ? 'Y' : 'N' }}</td><td>{{ p.in_change_list ? 'Y' : 'N' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="pager">
            <button @click="productPage = 1" :disabled="productPage<=1">首頁</button>
            <button @click="productPage -= 1" :disabled="productPage<=1">上一頁</button>
            <span>第 {{ productPage }} / {{ productTotalPages }} 頁（共 {{ filteredProducts.length }} 筆）</span>
            <button @click="productPage += 1" :disabled="productPage>=productTotalPages">下一頁</button>
            <button @click="productPage = productTotalPages" :disabled="productPage>=productTotalPages">末頁</button>
          </div>
          <div class="log-head">
            <span>任務日誌</span>
            <select v-model="productLogGroupId" @change="loadLogs">
              <option value="">全部</option>
              <option v-for="g in productLogGroups" :key="g.id" :value="String(g.id)">{{ groupLabel(g) }}</option>
            </select>
          </div>
          <LogPanel :logs="productLogs" />
        </section>

        <section v-else>
          <div v-if="isAccountRunning(selectedId)" class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: `${changeProgressPercent}%` }"></div>
            </div>
            <span>{{ changeProgressText || '批量修改進行中...' }}</span>
            <button v-if="isAccountRunning(selectedId)" class="icon-btn danger" title="強制停止任務" @click="confirmStopTask" aria-label="強制停止任務">
              <span class="stop-dot"><span class="stop-square"></span></span>
            </button>
          </div>
          <div class="toolbar">
            <div class="day-input-wrap">
              <input v-model="newDays" type="number" min="0" max="30" step="1" placeholder="輸入 0-30 天" />
              <div class="spinner-col">
                <button class="spin-btn" type="button" @click="adjustNewDays(1)" aria-label="增加">▲</button>
                <button class="spin-btn" type="button" @click="adjustNewDays(-1)" aria-label="減少">▼</button>
              </div>
            </div>
            <button :disabled="isAccountRunning(selectedId) || !canBatchChange" @click="batchChange">批量修改</button>
            <button @click="loadChangeList">刷新</button>
            <select v-model.number="changePageSize">
              <option :value="20">20 / 頁</option>
              <option :value="50">50 / 頁</option>
              <option :value="100">100 / 頁</option>
            </select>
          </div>
          <table>
            <thead><tr>
              <th>
                <select v-model="changeBulkAction" @change="applyChangeBulkAction">
                  <option value="">勾選操作</option>
                  <option value="select_page">選擇當前頁</option>
                  <option value="select_all">選擇全部</option>
                  <option value="unselect_page">取消當前頁</option>
                  <option value="unselect_all">取消全部</option>
                </select>
                <div class="pick-stat">已選 {{ checkedChange.size }} / 本頁 {{ pagedChangeList.length }}</div>
              </th>
              <th class="sortable" @click="toggleChangeSort('product_id')">商品ID <span class="sort-arrow" :class="sortState(changeSortKey, changeSortDir, 'product_id')"></span></th>
              <th class="sortable" @click="toggleChangeSort('name')">商品名稱 <span class="sort-arrow" :class="sortState(changeSortKey, changeSortDir, 'name')"></span></th>
              <th class="sortable" @click="toggleChangeSort('days_to_ship')">備貨天數 <span class="sort-arrow" :class="sortState(changeSortKey, changeSortDir, 'days_to_ship')"></span></th>
            </tr></thead>
            <tbody>
              <tr v-for="p in pagedChangeList" :key="p.product_id"><td><input type="checkbox" :checked="checkedChange.has(p.product_id)" @change="toggleChange(p.product_id, $event.target.checked)" /></td><td>{{ p.product_id }}</td><td>{{ p.name }}</td><td>{{ p.days_to_ship }}</td></tr>
            </tbody>
          </table>
          <div class="pager">
            <button @click="changePage = 1" :disabled="changePage<=1">首頁</button>
            <button @click="changePage -= 1" :disabled="changePage<=1">上一頁</button>
            <span>第 {{ changePage }} / {{ changeTotalPages }} 頁（共 {{ changeList.length }} 筆）</span>
            <button @click="changePage += 1" :disabled="changePage>=changeTotalPages">下一頁</button>
            <button @click="changePage = changeTotalPages" :disabled="changePage>=changeTotalPages">末頁</button>
          </div>
          <div class="hint">批量修改會作用於整個「修改清單」(共 {{ changeList.length }} 筆)，勾選僅用於移除。</div>
          <button @click="removeCheckedFromChangeList" :disabled="checkedChange.size===0">移除選中（已選 {{ checkedChange.size }}）</button>
          <div class="log-head">
            <span>任務日誌</span>
            <select v-model="changeLogGroupId" @change="loadLogs">
              <option value="">全部</option>
              <option v-for="g in changeLogGroups" :key="g.id" :value="String(g.id)">{{ groupLabel(g) }}</option>
            </select>
          </div>
          <LogPanel :logs="changeLogs" />
        </section>
      </template>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, reactive, defineComponent, h, computed, watch } from 'vue';

const accounts = ref([]);
const selectedId = ref(null);
const active = ref('products');
const products = ref([]);
const changeList = ref([]);
const productLogs = ref([]);
const changeLogs = ref([]);
const showAddForm = ref(false);
const newShopId = ref('');
const newCookieJson = ref('');
const editingAccountId = ref(null);
const editShopId = ref('');
const editCookieJson = ref('');
const newDays = ref('');
const checked = reactive(new Set());
const checkedChange = reactive(new Set());
const notice = ref({ text: '', type: 'error' });
let noticeTimer = null;
let logsTimer = null;
let refreshingProducts = false;
let refreshingChangeList = false;
const runningByAccount = reactive({});
const activeTaskAccounts = reactive(new Set());
const productProgressPercent = ref(0);
const changeProgressPercent = ref(0);
const productProgressText = ref('');
const changeProgressText = ref('');
const productTaskStartedAt = ref(0);
const changeTaskStartedAt = ref(0);
const accountProgressMap = reactive({});
const productFilter = ref('');
const onlyStale = ref(false);
const productSortKey = ref('');
const productSortDir = ref('');
const productPage = ref(1);
const productPageSize = ref(20);
const changePage = ref(1);
const changePageSize = ref(20);
const changeSortKey = ref('');
const changeSortDir = ref('');
const productBulkAction = ref('');
const changeBulkAction = ref('');
const productLogGroups = ref([]);
const changeLogGroups = ref([]);
const productLogGroupId = ref('');
const changeLogGroupId = ref('');
let selectAccountReqSeq = 0;
const switchingAccount = ref(false);

const filteredProducts = computed(() => {
  const keyword = productFilter.value.toLowerCase();
  const list = products.value.filter((p) => {
    if (onlyStale.value && p.exists_in_latest) return false;
    if (!keyword) return true;
    return String(p.product_id).includes(keyword) || String(p.name || '').toLowerCase().includes(keyword);
  });
  if (productSortKey.value) {
    const dir = productSortDir.value === 'asc' ? 1 : -1;
    const key = productSortKey.value;
    list.sort((a, b) => {
      const av = a?.[key];
      const bv = b?.[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hant') * dir;
    });
  }
  return list;
});
const productTotalPages = computed(() => Math.max(1, Math.ceil(filteredProducts.value.length / productPageSize.value)));
const pagedProducts = computed(() => {
  const start = (productPage.value - 1) * productPageSize.value;
  return filteredProducts.value.slice(start, start + productPageSize.value);
});
const changeTotalPages = computed(() => Math.max(1, Math.ceil(changeList.value.length / changePageSize.value)));
const sortedChangeList = computed(() => {
  const list = [...changeList.value];
  if (changeSortKey.value) {
    const dir = changeSortDir.value === 'asc' ? 1 : -1;
    const key = changeSortKey.value;
    list.sort((a, b) => {
      const av = a?.[key];
      const bv = b?.[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hant') * dir;
    });
  }
  return list;
});
const pagedChangeList = computed(() => {
  const start = (changePage.value - 1) * changePageSize.value;
  return sortedChangeList.value.slice(start, start + changePageSize.value);
});
const canBatchChange = computed(() => {
  const s = String(newDays.value ?? '').trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 30;
});

watch([filteredProducts, productPageSize], () => {
  if (productPage.value > productTotalPages.value) productPage.value = productTotalPages.value;
  if (productPage.value < 1) productPage.value = 1;
});
watch([productFilter, onlyStale, productSortKey, productSortDir], () => {
  productPage.value = 1;
});
watch([changeList, changePageSize, changeSortKey, changeSortDir], () => {
  if (changePage.value > changeTotalPages.value) changePage.value = changeTotalPages.value;
  if (changePage.value < 1) changePage.value = 1;
});
const getApi = () => {
  if (!window.api) {
    throw new Error('未連接桌面端 API，請用 Electron App 打開，不要只開瀏覽器頁面。');
  }
  return window.api;
};
function showNotice(text, type = 'error') {
  notice.value = { text: String(text || ''), type };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = { text: '', type: 'error' }; }, 5000);
}
function isAccountRunning(accountId) {
  if (!accountId) return false;
  return Boolean(runningByAccount[String(accountId)]);
}
function getErrMsg(err) {
  const raw = String(err?.message || err || '');
  const marker = 'Error invoking remote method';
  if (!raw.includes(marker)) return raw;
  const idx = raw.indexOf('Error: ');
  if (idx >= 0) return raw.slice(idx + 7).trim();
  return raw;
}

const LogPanel = defineComponent({
  props: { logs: { type: Array, required: true } },
  setup(props) {
    return () => h('div', { class: 'logs' }, props.logs.map((l) => h('div', { class: `log ${l.type}` }, `[${new Date(l.created_at * 1000).toLocaleString()}] ${l.message}`)));
  }
});

async function loadAccounts() { accounts.value = await getApi().getAccounts(); }
async function loadProducts() { if (selectedId.value) products.value = await getApi().getProducts(selectedId.value); await loadLogs(); }
async function loadChangeList() { if (selectedId.value) changeList.value = await getApi().getChangeList(selectedId.value); await loadLogs(); }
async function loadLogGroups() {
  if (!selectedId.value) return;
  try {
    productLogGroups.value = await getApi().getLogGroups(selectedId.value, 'products');
    changeLogGroups.value = await getApi().getLogGroups(selectedId.value, 'change');
  } catch {}
}
function groupLabel(g) {
  const dt = new Date((Number(g.created_at) || 0) * 1000);
  const ts = Number.isNaN(dt.getTime()) ? String(g.id) : dt.toLocaleString();
  const status = g.status === 'running' ? '進行中' : (g.status === 'done' ? '完成' : (g.status === 'stopped' ? '已終止' : '失敗'));
  return `${ts} (${status})`;
}
async function loadLogs() {
  if (!selectedId.value) return;
  const pTaskId = productLogGroupId.value ? Number(productLogGroupId.value) : null;
  const cTaskId = changeLogGroupId.value ? Number(changeLogGroupId.value) : null;
  productLogs.value = await getApi().getLogs(selectedId.value, 'products', pTaskId);
  changeLogs.value = await getApi().getLogs(selectedId.value, 'change', cTaskId);
  parseProgressFromLogs();
}
function parseProgressFromLogs() {
  const formatEta = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${ss}s`;
    return `${ss}s`;
  };
  const selectedRunning = isAccountRunning(selectedId.value);
  const productScopedLogs = (() => {
    if (!selectedRunning || !productTaskStartedAt.value) return productLogs.value;
    const scoped = productLogs.value.filter((x) => Number(x.created_at || 0) >= productTaskStartedAt.value);
    return scoped.length ? scoped : [];
  })();
  const changeScopedLogs = (() => {
    if (!selectedRunning || !changeTaskStartedAt.value) return changeLogs.value;
    const scoped = changeLogs.value.filter((x) => Number(x.created_at || 0) >= changeTaskStartedAt.value);
    return scoped.length ? scoped : [];
  })();
  const productStopped = productLogs.value.some((x) => /Stop requested by user|Task stopped by user/i.test(x.message));
  const changeStopped = changeLogs.value.some((x) => /Stop requested by user|Task stopped by user/i.test(x.message));

  if (!selectedRunning && productStopped) {
    productProgressText.value = '已終止';
    productProgressPercent.value = 0;
  } else {
  const dLog = productScopedLogs.find((x) => /Progress detail:/.test(x.message));
  if (dLog) {
    const m = dLog.message.match(/Progress detail:\s*(\d+)\/(\d+)\s+success=(\d+)\s+percent=(\d+)/);
    if (m) {
      const done = Number(m[1]) || 0;
      const total = Number(m[2]) || 0;
      const startIdx = productScopedLogs.findIndex((x) => /Start fetching products/.test(x.message));
      const scoped = startIdx >= 0 ? productScopedLogs.slice(0, startIdx + 1) : productScopedLogs;
      const progressLogs = [...scoped]
        .filter((x) => /Progress detail:/.test(x.message))
        .reverse();
      let extra = '';
      if (progressLogs.length >= 2) {
        const first = progressLogs[0];
        const last = progressLogs[progressLogs.length - 1];
        const fm = first.message.match(/Progress detail:\s*(\d+)\/(\d+)\s+success=(\d+)\s+percent=(\d+)/);
        const lm = last.message.match(/Progress detail:\s*(\d+)\/(\d+)\s+success=(\d+)\s+percent=(\d+)/);
        const deltaDone = (Number(lm?.[1]) || 0) - (Number(fm?.[1]) || 0);
        const deltaSec = Math.max(1, (Number(last.created_at) || 0) - (Number(first.created_at) || 0));
        if (deltaDone > 0) {
          const speed = deltaDone / deltaSec;
          const remain = Math.max(0, total - done);
          const eta = Math.round(remain / speed);
          extra = `，${speed.toFixed(2)} item/s，ETA ${formatEta(eta)}`;
        }
      }
      productProgressText.value = `詳情進度 ${m[1]}/${m[2]}，成功 ${m[3]}，${m[4]}%${extra}`;
      productProgressPercent.value = Number(m[4]) || 0;
    }
  } else {
    const pLog = productScopedLogs.find((x) => /Progress fetch:/.test(x.message));
    if (pLog) {
      const m = pLog.message.match(/products=(\d+)\/(\d+)\s+percent=(\d+)/);
      if (m) {
        productProgressText.value = `列表拉取中 ${m[1]}/${m[2]}（詳情等待中）`;
        productProgressPercent.value = 0;
      } else {
        productProgressText.value = '';
        productProgressPercent.value = 0;
      }
    } else {
      productProgressText.value = '';
      productProgressPercent.value = 0;
    }
  }
  }

  if (!selectedRunning && changeStopped) {
    changeProgressText.value = '已終止';
    changeProgressPercent.value = 0;
  } else {
  const cLog = changeScopedLogs.find((x) => /Progress change:/.test(x.message));
  if (cLog) {
    const m = cLog.message.match(/Progress change:\s*(\d+\/\d+)\s+success=(\d+)\s+fail=(\d+)(?:\s+skip=\d+)?\s+percent=(\d+)/);
    if (m) {
      const speedMatch = cLog.message.match(/speed=([0-9.]+)\s+eta=(\d+)s/);
      let extra = '';
      if (speedMatch) {
        extra = `，${Number(speedMatch[1]).toFixed(2)} item/s，ETA ${formatEta(Number(speedMatch[2]))}`;
      }
      changeProgressText.value = `修改進度 ${m[1]}，成功 ${m[2]}，失敗 ${m[3]}，${m[4]}%${extra}`;
      changeProgressPercent.value = Number(m[4]) || 0;
    }
  } else {
    changeProgressText.value = '';
    changeProgressPercent.value = 0;
  }
  }
}
async function refreshRunningState() {
  for (const a of accounts.value) {
    try {
      runningByAccount[String(a.id)] = await getApi().isTaskRunning(a.id);
    } catch {}
  }
  const hasRunning = Object.values(runningByAccount).some(Boolean);
  if (hasRunning) {
    for (const [k, v] of Object.entries(runningByAccount)) {
      if (v) activeTaskAccounts.add(String(k));
    }
    startLiveLogPolling();
  } else {
    activeTaskAccounts.clear();
    stopLiveLogPolling();
  }
}
async function refreshAccountBadges() {
  for (const a of accounts.value) {
    const id = a.id;
    const key = String(id);
    try {
      const pLogs = await getApi().getLogs(id, 'products');
      const cLogs = await getApi().getLogs(id, 'change');
      const pStartIdx = pLogs.findIndex((x) => /Start fetching products/.test(x.message));
      const pScoped = pStartIdx >= 0 ? pLogs.slice(0, pStartIdx + 1) : pLogs;
      const cStartIdx = cLogs.findIndex((x) => /Batch start\./.test(x.message));
      const cScoped = cStartIdx >= 0 ? cLogs.slice(0, cStartIdx + 1) : cLogs;
      const p = pScoped.find((x) => /Progress fetch:/.test(x.message));
      const d = pScoped.find((x) => /Progress detail:/.test(x.message));
      const c = cScoped.find((x) => /Progress change:/.test(x.message));
      const productCandidate = d || p || null;
      if (runningByAccount[key]) {
        const productTs = Number(productCandidate?.created_at || 0);
        const changeTs = Number(c?.created_at || 0);
        if (productTs >= changeTs && productCandidate) {
          const m = productCandidate.message.match(/percent=(\d+)/);
          if (d) {
            accountProgressMap[key] = `詳 ${m ? m[1] : 0}%`;
          } else {
            accountProgressMap[key] = `拉 ${m ? m[1] : 0}%`;
          }
        } else if (c) {
          const m = c.message.match(/percent=(\d+)/);
          accountProgressMap[key] = `改 ${m ? m[1] : 0}%`;
        } else {
          accountProgressMap[key] = '進行中';
        }
      } else {
        accountProgressMap[key] = '';
      }
    } catch {}
  }
}
function accountBadge(accountId) {
  return accountProgressMap[String(accountId)] || '';
}
function startLiveLogPolling() {
  if (logsTimer) return;
  logsTimer = setInterval(() => {
    loadLogs().catch(() => {});
    refreshRunningState().catch(() => {});
    refreshAccountBadges().catch(() => {});
    if (!refreshingProducts && selectedId.value && isAccountRunning(selectedId.value) && active.value === 'products') {
      refreshingProducts = true;
      getApi().getProducts(selectedId.value)
        .then((rows) => { products.value = rows; })
        .catch(() => {})
        .finally(() => { refreshingProducts = false; });
    }
    if (!refreshingChangeList && selectedId.value && isAccountRunning(selectedId.value) && active.value === 'change') {
      refreshingChangeList = true;
      getApi().getChangeList(selectedId.value)
        .then((rows) => { changeList.value = rows; })
        .catch(() => {})
        .finally(() => { refreshingChangeList = false; });
    }
  }, 1000);
}
function stopLiveLogPolling() {
  if (activeTaskAccounts.size > 0) return;
  if (logsTimer) {
    clearInterval(logsTimer);
    logsTimer = null;
  }
}

function toggleAddForm() { showAddForm.value = !showAddForm.value; }
async function selectAccount(id) {
  if (switchingAccount.value) return;
  switchingAccount.value = true;
  const reqSeq = ++selectAccountReqSeq;
  selectedId.value = id;
  checked.clear();
  checkedChange.clear();
  productLogGroupId.value = '';
  changeLogGroupId.value = '';
  products.value = [];
  changeList.value = [];
  productLogs.value = [];
  changeLogs.value = [];
  productProgressPercent.value = 0;
  changeProgressPercent.value = 0;
  productProgressText.value = '';
  changeProgressText.value = '';
  try {
    await Promise.all([loadLogGroups(), loadProducts(), loadChangeList()]);
  } finally {
    switchingAccount.value = false;
    if (reqSeq !== selectAccountReqSeq) return;
  }
}
function toggleCheck(id, on) { on ? checked.add(id) : checked.delete(id); }
function toggleChange(id, on) { on ? checkedChange.add(id) : checkedChange.delete(id); }
function sortMark(activeKey, activeDir, key) {
  const k = typeof activeKey === 'object' && activeKey !== null ? activeKey.value : activeKey;
  const d = typeof activeDir === 'object' && activeDir !== null ? activeDir.value : activeDir;
  if (k !== key) return '';
  return d === 'asc' ? '▲' : (d === 'desc' ? '▼' : '');
}
function sortState(activeKey, activeDir, key) {
  const k = typeof activeKey === 'object' && activeKey !== null ? activeKey.value : activeKey;
  const d = typeof activeDir === 'object' && activeDir !== null ? activeDir.value : activeDir;
  if (k !== key) return '';
  return d === 'asc' ? 'asc' : (d === 'desc' ? 'desc' : '');
}
function adjustNewDays(delta) {
  const s = String(newDays.value ?? '').trim();
  let n = /^\d+$/.test(s) ? Number(s) : 0;
  n = Math.max(0, Math.min(30, n + delta));
  newDays.value = String(n);
}
function toggleProductSort(key) {
  if (productSortKey.value !== key) {
    productSortKey.value = key;
    productSortDir.value = 'asc';
  } else if (productSortDir.value === 'asc') {
    productSortDir.value = 'desc';
  } else {
    productSortKey.value = '';
    productSortDir.value = '';
  }
}
function toggleChangeSort(key) {
  if (changeSortKey.value !== key) {
    changeSortKey.value = key;
    changeSortDir.value = 'asc';
  } else if (changeSortDir.value === 'asc') {
    changeSortDir.value = 'desc';
  } else {
    changeSortKey.value = '';
    changeSortDir.value = '';
  }
}
function applyProductBulkAction() {
  const action = productBulkAction.value;
  if (!action) return;
  if (action === 'select_page') {
    for (const p of pagedProducts.value) checked.add(p.product_id);
  } else if (action === 'select_all') {
    for (const p of filteredProducts.value) checked.add(p.product_id);
  } else if (action === 'unselect_page') {
    for (const p of pagedProducts.value) checked.delete(p.product_id);
  } else if (action === 'unselect_all') {
    checked.clear();
  }
  productBulkAction.value = '';
}
function applyChangeBulkAction() {
  const action = changeBulkAction.value;
  if (!action) return;
  if (action === 'select_page') {
    for (const p of pagedChangeList.value) checkedChange.add(p.product_id);
  } else if (action === 'select_all') {
    for (const p of changeList.value) checkedChange.add(p.product_id);
  } else if (action === 'unselect_page') {
    for (const p of pagedChangeList.value) checkedChange.delete(p.product_id);
  } else if (action === 'unselect_all') {
    checkedChange.clear();
  }
  changeBulkAction.value = '';
}

async function addAccount() {
  try {
    const shopId = Number(String(newShopId.value || '').trim());
    if (!Number.isInteger(shopId) || shopId <= 0) {
      throw new Error('Shop ID 必填且必須是正整數');
    }
    const cookieText = String(newCookieJson.value || '').trim();
    if (!cookieText) {
      throw new Error('Cookie JSON 不能為空');
    }
    await getApi().addAccount(shopId, cookieText);
    newShopId.value = '';
    newCookieJson.value = '';
    showAddForm.value = false;
    await loadAccounts();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

function startEditAccount(a) {
  editingAccountId.value = a.id;
  editShopId.value = String(a.shop_id ?? '');
  editCookieJson.value = String(a.cookie_json ?? '');
}

function cancelEditAccount() {
  editingAccountId.value = null;
  editShopId.value = '';
  editCookieJson.value = '';
}

async function saveEditAccount(id) {
  try {
    const acc = accounts.value.find((x) => x.id === id);
    if (!acc) throw new Error('Account not found');
    const shopId = Number(String(editShopId.value || '').trim());
    if (!Number.isInteger(shopId) || shopId <= 0) {
      throw new Error('Shop ID 必填且必須是正整數');
    }
    const cookieText = String(editCookieJson.value || '').trim();
    if (!cookieText) throw new Error('Cookie JSON 不能為空');

    await getApi().updateAccountCookie(id, cookieText);
    // 若用户修改了 shopId，则更新本地显示字段（不改校验逻辑：cookie 已验证属于该账号）
    if (shopId !== Number(acc.shop_id)) {
      const row = accounts.value.find((x) => x.id === id);
      if (row) row.shop_id = shopId;
    }
    cancelEditAccount();
    showNotice('賬戶已更新', 'success');
    await loadAccounts();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

async function validate(id) {
  try {
    await getApi().validateAccount(id);
    showNotice('賬戶驗證成功', 'success');
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function removeAccount(id) {
  try {
    if (selectedId.value === id) stopLiveLogPolling();
    await getApi().deleteAccount(id);
    if (selectedId.value === id) selectedId.value = null;
    await loadAccounts();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

async function fetchProducts() {
  const id = selectedId.value;
  runningByAccount[String(id)] = true;
  productTaskStartedAt.value = Math.floor(Date.now() / 1000);
  productProgressPercent.value = 0;
  productProgressText.value = '拉取任務啟動中...';
  activeTaskAccounts.add(String(id));
  startLiveLogPolling();
  try {
    await getApi().fetchProducts(id);
  } catch (e) {
    const msg = getErrMsg(e);
    if (/Task stopped by user/i.test(msg)) return;
    if (!/page size is exceed limit/i.test(msg)) {
      showNotice(msg, 'error');
    }
  } finally {
    runningByAccount[String(id)] = false;
    productTaskStartedAt.value = 0;
    accountProgressMap[String(id)] = '';
    activeTaskAccounts.delete(String(id));
    stopLiveLogPolling();
    await refreshRunningState();
    await refreshAccountBadges();
    await loadLogGroups();
    if (selectedId.value === id) await loadProducts();
  }
}

async function addCheckedToChangeList() {
  try {
    const ids = [...new Set([...checked].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (ids.length === 0) {
      showNotice('請先勾選商品', 'error');
      return;
    }
    await getApi().addToChangeList(selectedId.value, ids);
    checked.clear();
    showNotice(`已加入修改清單: ${ids.length} 筆`, 'success');
    await loadProducts();
    await loadChangeList();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

async function removeCheckedFromChangeList() {
  try {
    const ids = [...new Set([...checkedChange].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (ids.length === 0) {
      showNotice('請先勾選商品', 'error');
      return;
    }
    await getApi().removeFromChangeList(selectedId.value, ids);
    checkedChange.clear();
    showNotice(`已移除: ${ids.length} 筆`, 'success');
    await loadProducts();
    await loadChangeList();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

async function batchChange() {
  const id = selectedId.value;
  const total = changeList.value.length;
  const days = Number(String(newDays.value ?? '').trim());
  if (!Number.isInteger(days) || days < 0 || days > 30) {
    showNotice('天數必須是 0-30 的整數', 'error');
    return;
  }
  if (total <= 0) {
    showNotice('修改清單為空，無法批量修改', 'error');
    return;
  }
  const ok = window.confirm(`確認批量修改？\n商品數量：${total}\n修改為：${days} 天`);
  if (!ok) return;

  runningByAccount[String(id)] = true;
  changeTaskStartedAt.value = Math.floor(Date.now() / 1000);
  changeProgressPercent.value = 0;
  changeProgressText.value = '修改任務啟動中...';
  activeTaskAccounts.add(String(id));
  startLiveLogPolling();
  try {
    await getApi().batchChangeDaysToShip(id, days);
  } catch (e) {
    const msg = getErrMsg(e);
    if (/Task stopped by user/i.test(msg)) return;
    showNotice(msg, 'error');
  } finally {
    runningByAccount[String(id)] = false;
    changeTaskStartedAt.value = 0;
    accountProgressMap[String(id)] = '';
    activeTaskAccounts.delete(String(id));
    stopLiveLogPolling();
    await refreshRunningState();
    await refreshAccountBadges();
    await loadLogGroups();
    if (selectedId.value === id) {
      await loadProducts();
      await loadChangeList();
    }
  }
}

async function confirmStopTask() {
  const id = selectedId.value;
  if (!id || !isAccountRunning(id)) return;
  const ok = window.confirm('確認強制停止當前任務？\n已完成的項目會保留，未完成的會中斷。');
  if (!ok) return;
  try {
    await getApi().stopTask(id);
    showNotice('已發送停止請求，正在中斷任務...', 'success');
    await loadLogGroups();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}

onMounted(async () => {
  try {
    await loadAccounts();
    await refreshRunningState();
    await refreshAccountBadges();
    const hasRunning = Object.values(runningByAccount).some(Boolean);
    if (hasRunning) {
      for (const [k, v] of Object.entries(runningByAccount)) {
        if (v) activeTaskAccounts.add(String(k));
      }
      startLiveLogPolling();
    }
    if (accounts.value.length) {
      selectAccount(accounts.value[0].id);
      await loadLogGroups();
    }
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
});
</script>

<style>
*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#f5f7fb;color:#1f2a37}
.wrap{display:grid;grid-template-columns:340px 1fr;height:100vh}
.left{padding:16px;border-right:1px solid #e5e7eb;overflow:auto;background:#fff}
.right{padding:16px;overflow:auto}
h2{margin:0 0 12px}
.account-actions{margin-bottom:12px}
.add-form{border:1px solid #e5e7eb;border-radius:8px;padding:10px;background:#fafafa;margin-bottom:12px}
.edit-form{border:1px dashed #d1d5db;border-radius:8px;padding:8px;background:#f8fafc;margin-top:8px}
.add-row{display:flex;gap:8px}
input,textarea,button{padding:8px;border:1px solid #d1d5db;border-radius:6px}
input,textarea{width:100%}
button{background:#fff;cursor:pointer}
button.primary{background:#2563eb;color:#fff;border-color:#2563eb}
.account-list{list-style:none;padding:0;margin:0}
.account-list.disabled{opacity:.55;pointer-events:none;filter:grayscale(.2)}
li{border:1px solid #e5e7eb;padding:10px;margin:8px 0;cursor:pointer;border-radius:8px;background:#fff}
li.active{background:#eff6ff;border-color:#93c5fd}
.account-head{display:flex;justify-content:space-between;gap:8px;align-items:center}
.account-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;white-space:nowrap}
.row{display:flex;gap:8px;margin-top:8px}
header{display:flex;gap:8px;margin-bottom:12px}
.activeTab{background:#111827;color:#fff;border-color:#111827}
.toolbar{display:flex;gap:8px;margin-bottom:8px}
.day-input-wrap{position:relative;width:170px}
.day-input-wrap input[type="number"]{padding-right:30px}
.day-input-wrap input[type="number"]::-webkit-outer-spin-button,
.day-input-wrap input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.day-input-wrap input[type="number"]{-moz-appearance:textfield}
.spinner-col{position:absolute;right:4px;top:4px;bottom:4px;display:flex;flex-direction:column;justify-content:space-between;gap:3px}
.spin-btn{width:22px;height:15px;line-height:11px;padding:0;font-size:10px;border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#374151}
.spin-btn:hover{background:#f3f4f6}
.spin-btn:active{transform:scale(.97)}
.inline{display:flex;align-items:center;gap:6px;font-size:13px}
table{width:100%;border-collapse:collapse;margin-bottom:8px;background:#fff}
th,td{border:1px solid #e5e7eb;padding:6px;text-align:left}
.sortable{cursor:pointer;user-select:none}
.sort-arrow{display:inline-flex;align-items:center;justify-content:center;min-width:12px;height:12px;margin-left:4px;color:#2563eb;font-weight:700}
.sort-arrow.asc::before{content:'▲'}
.sort-arrow.desc::before{content:'▼'}
tr.stale{background:#fff2f2}
.pager{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.pager span{font-size:12px;color:#374151}
.hint{font-size:12px;color:#6b7280;margin-bottom:8px}
.pick-stat{font-size:11px;color:#6b7280;margin-top:4px}
.log-head{display:flex;justify-content:space-between;align-items:center;margin:8px 0 6px;font-size:12px;color:#374151}
.logs{border:1px solid #e5e7eb;padding:8px;max-height:180px;overflow:auto;background:#fff}
.log{font-size:12px;margin:4px 0}.log.error{color:#c00}.log.success{color:#0a7d21}
.empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#6b7280}
.notice{margin-bottom:10px;padding:10px;border-radius:8px;border:1px solid}
.notice.error{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.notice.success{background:#ecfdf5;border-color:#a7f3d0;color:#065f46}
.progress-wrap{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.progress-wrap span{font-size:12px;color:#374151}
.progress-bar{position:relative;width:220px;height:8px;border-radius:999px;background:#e5e7eb;overflow:hidden}
.progress-fill{height:100%;background:#2563eb;transition:width .35s ease}
.icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:999px;transition:all .2s ease}
.icon-btn.danger{border:1px solid #fca5a5;background:#fff;color:#dc2626;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.icon-btn.danger:hover{background:#fef2f2;border-color:#ef4444;box-shadow:0 2px 6px rgba(220,38,38,.2)}
.icon-btn.danger:active{transform:scale(.96)}
.stop-dot{width:16px;height:16px;border:2px solid currentColor;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}
.stop-square{width:7px;height:7px;background:currentColor;border-radius:2px;display:block}
</style>
