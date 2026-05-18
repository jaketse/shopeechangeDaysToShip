<template>
  <div class="wrap" @focusin="handleFocusIn" @focusout="handleFocusOut">
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
          <button :class="{activeTab: active==='cron'}" @click="active='cron'; scheduleView='list'; loadSchedules()">定時任務</button>
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

        <section v-else-if="active==='change'">
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
          </div>
          <div class="toolbar">
            <input v-model.trim="changeFilter" placeholder="搜尋 ID / 名稱" />
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
            <span>第 {{ changePage }} / {{ changeTotalPages }} 頁（共 {{ filteredChangeList.length }} 筆）</span>
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
        <section v-else>
          <template v-if="scheduleView==='list'">
          <div class="toolbar">
            <button class="primary" @click="createScheduleTask">新建任務</button>
            <button @click="loadSchedules">刷新</button>
          </div>
          <table>
            <thead><tr>
              <th>任務ID</th><th>名稱</th><th>備注</th><th>狀態</th><th>當前進度</th><th>商品數</th><th>操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="t in scheduleTasks" :key="t.id" :class="{ active: selectedScheduleTaskId===t.id }">
                <td>{{ t.id }}</td>
                <td>{{ t.name }}</td>
                <td>{{ t.note }}</td>
                <td>{{ t.is_active ? '已啟動' : '已暫停' }}</td>
                <td>
                  <div v-if="scheduleTaskProgressPercent(t) > 0 && scheduleTaskProgressPercent(t) < 100" class="progress-bar mini">
                    <div class="progress-fill" :style="{ width: `${scheduleTaskProgressPercent(t)}%` }"></div>
                  </div>
                  <span class="hint">{{ scheduleTaskProgressText(t) }}</span>
                </td>
                <td>{{ t.product_count }}</td>
                <td>
                  <button @click="openScheduleDetail(t.id, true)">編輯</button>
                  <button @click="toggleScheduleTaskActive(t)">{{ t.is_active ? '暫停' : '啟動' }}</button>
                  <button @click="deleteScheduleTask(t.id)">刪除</button>
                </td>
              </tr>
            </tbody>
          </table>
          </template>

          <div v-else-if="selectedScheduleTask" class="schedule-box">
            <div class="toolbar schedule-head">
              <button @click="goBackScheduleList">返回任務列表</button>
              <span class="muted">任務ID：{{ selectedScheduleTask.id }}</span>
              <span class="muted">狀態：{{ selectedScheduleTask.is_active ? '已啟動' : '已暫停' }}</span>
              <div class="schedule-head-right" v-if="editingScheduleTaskId===selectedScheduleTask.id">
                <button class="primary" @click="saveScheduleTaskEdit">保存</button>
                <button @click="cancelScheduleTaskEdit">取消</button>
              </div>
            </div>
            <h4>定時任務詳情</h4>
            <div class="schedule-form" v-if="editingScheduleTaskId===selectedScheduleTask.id">
              <label class="field">
                <span class="field-label">任務名稱</span>
                <input v-model.trim="scheduleDraftName" placeholder="請輸入任務名稱" />
              </label>
              <label class="field">
                <span class="field-label">備注</span>
                <input v-model.trim="scheduleDraftNote" placeholder="請輸入備注" />
              </label>
            </div>

            <div class="toolbar section-head">
              <h5>商品清單（{{ filteredScheduleTaskProducts.length }}）</h5>
              <div class="toolbar">
                <button @click="openScheduleProductPicker">添加商品</button>
                <button :disabled="scheduleTaskCheckedProducts.size===0" @click="removeSelectedScheduleProducts">批量刪除（{{ scheduleTaskCheckedProducts.size }}）</button>
              </div>
            </div>
            <div class="toolbar">
              <input v-model.trim="scheduleTaskProductFilter" placeholder="搜尋 ID / 名稱" />
            </div>
            <table>
              <thead><tr>
                <th>
                  <select v-model="scheduleTaskProductBulkAction" @change="applyScheduleTaskProductBulkAction">
                    <option value="">勾選操作</option>
                    <option value="select_page">選擇當前頁</option>
                    <option value="select_all">選擇全部</option>
                    <option value="unselect_page">取消當前頁</option>
                    <option value="unselect_all">取消全部</option>
                  </select>
                  <div class="pick-stat">已選 {{ scheduleTaskCheckedProducts.size }} / 本頁 {{ pagedScheduleTaskProducts.length }}</div>
                </th>
                <th>商品ID</th><th>名稱</th><th>備貨天數</th><th>操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="p in pagedScheduleTaskProducts" :key="p.product_id">
                  <td><input type="checkbox" :checked="scheduleTaskCheckedProducts.has(p.product_id)" @change="toggleScheduleTaskProduct(p.product_id, $event.target.checked)" /></td>
                  <td>{{ p.product_id }}</td><td>{{ p.name }}</td><td>{{ p.days_to_ship }}</td>
                  <td><button @click="removeScheduleProducts([p.product_id])">移除</button></td>
                </tr>
              </tbody>
            </table>
            <div class="pager">
              <button @click="scheduleTaskProductPage=1" :disabled="scheduleTaskProductPage<=1">首頁</button>
              <button @click="scheduleTaskProductPage-=1" :disabled="scheduleTaskProductPage<=1">上一頁</button>
              <span>第 {{ scheduleTaskProductPage }} / {{ scheduleTaskProductTotalPages }} 頁（共 {{ filteredScheduleTaskProducts.length }} 筆）</span>
              <button @click="scheduleTaskProductPage+=1" :disabled="scheduleTaskProductPage>=scheduleTaskProductTotalPages">下一頁</button>
              <button @click="scheduleTaskProductPage=scheduleTaskProductTotalPages" :disabled="scheduleTaskProductPage>=scheduleTaskProductTotalPages">末頁</button>
            </div>

            <div class="toolbar section-head">
              <h5>定時規則（{{ scheduleDraftRules.length }}）</h5>
              <button class="primary" @click="openRuleModalForCreate">添加規則</button>
            </div>
            <table>
              <thead><tr><th>ID</th><th>類型</th><th>時間</th><th>備貨天數</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="r in scheduleDraftRules" :key="r.id">
                  <td>{{ r.id }}</td>
                  <td>{{ r.rule_type==='daily' ? '每天' : '每周' }}</td>
                  <td>{{ r.rule_type==='daily' ? r.daily_time : (`周${['日','一','二','三','四','五','六'][r.weekly_day]} ${r.weekly_time}`) }}</td>
                  <td>{{ r.days_to_ship }}</td>
                  <td><button @click="openRuleModalForEdit(r)">編輯</button> <button @click="deleteScheduleRule(r.id)">刪除</button></td>
                </tr>
              </tbody>
            </table>
            <div class="log-head">
              <span>定時任務日誌</span>
              <div class="toolbar">
                <select v-model="scheduleTaskLogGroupId" @change="loadScheduleTaskLogs">
                  <option value="">全部分組</option>
                  <option v-for="g in scheduleTaskLogGroups" :key="g.id" :value="String(g.id)">{{ scheduleLogGroupLabel(g) }}</option>
                </select>
                <button @click="loadScheduleTaskLogs">刷新</button>
              </div>
            </div>
            <LogPanel :logs="scheduleTaskLogs" />
          </div>

          <div v-if="showScheduleProductPicker" class="picker-mask">
            <div class="picker-card">
              <h4>添加商品到定時任務</h4>
              <div class="toolbar">
                <input v-model.trim="scheduleCandidateFilter" placeholder="搜尋 ID / 名稱" />
                <button @click="loadScheduleProductCandidates">刷新候選</button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>
                      <select v-model="scheduleCandidateBulkAction" @change="applyScheduleCandidateBulkAction">
                        <option value="">勾選操作</option>
                        <option value="select_page">選擇當前頁</option>
                        <option value="select_all">選擇全部</option>
                        <option value="unselect_page">取消當前頁</option>
                        <option value="unselect_all">取消全部</option>
                      </select>
                      <div class="pick-stat">已選 {{ scheduleCandidateChecked.size }} / 本頁 {{ pagedScheduleCandidates.length }}</div>
                    </th>
                    <th>商品ID</th>
                    <th>名稱</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in pagedScheduleCandidates" :key="p.product_id">
                    <td><input type="checkbox" :checked="scheduleCandidateChecked.has(p.product_id)" @change="toggleScheduleCandidate(p.product_id, $event.target.checked)" /></td>
                    <td>{{ p.product_id }}</td><td>{{ p.name }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="pager">
                <button @click="scheduleCandidatePage=1" :disabled="scheduleCandidatePage<=1">首頁</button>
                <button @click="scheduleCandidatePage-=1" :disabled="scheduleCandidatePage<=1">上一頁</button>
                <span>第 {{ scheduleCandidatePage }} / {{ scheduleCandidateTotalPages }} 頁（共 {{ filteredScheduleCandidates.length }} 筆）</span>
                <button @click="scheduleCandidatePage+=1" :disabled="scheduleCandidatePage>=scheduleCandidateTotalPages">下一頁</button>
                <button @click="scheduleCandidatePage=scheduleCandidateTotalPages" :disabled="scheduleCandidatePage>=scheduleCandidateTotalPages">末頁</button>
              </div>
              <div class="toolbar">
                <button class="primary" @click="confirmAddScheduleProducts">保存</button>
                <button @click="closeScheduleProductPicker">取消</button>
              </div>
            </div>
          </div>
          <div v-if="showRuleModal" class="picker-mask">
            <div class="picker-card rule-card">
              <h4>{{ editingRuleId ? '編輯規則' : '添加規則' }}</h4>
              <div class="schedule-form">
                <label class="field">
                  <span class="field-label">規則類型</span>
                  <select v-model="ruleFormType">
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                  </select>
                </label>
                <label class="field" v-if="ruleFormType==='daily'">
                  <span class="field-label">執行時間</span>
                  <button type="button" class="time-trigger" @click="openTimePicker('daily')">{{ ruleFormDailyTime || '選擇時間' }}</button>
                </label>
                <template v-else>
                  <label class="field">
                    <span class="field-label">每周幾</span>
                    <select v-model.number="ruleFormWeeklyDay">
                      <option :value="0">周日</option><option :value="1">周一</option><option :value="2">周二</option>
                      <option :value="3">周三</option><option :value="4">周四</option><option :value="5">周五</option><option :value="6">周六</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">執行時間</span>
                    <button type="button" class="time-trigger" @click="openTimePicker('weekly')">{{ ruleFormWeeklyTime || '選擇時間' }}</button>
                  </label>
                </template>
                <label class="field">
                  <span class="field-label">備貨天數</span>
                  <input v-model.number="ruleFormDays" type="number" min="0" max="30" placeholder="0-30" />
                </label>
              </div>
              <div class="toolbar">
                <button class="primary" @click="saveRuleModal">保存</button>
                <button @click="closeRuleModal">取消</button>
              </div>
            </div>
          </div>
          <div v-if="showTimePicker" class="time-picker-mask">
            <div class="time-picker-pop">
              <h4>選擇時間</h4>
              <div class="time-picker-row">
                <label class="field">
                  <select v-model.number="timePickerHour">
                    <option v-for="h in 24" :key="h-1" :value="h-1">{{ String(h-1).padStart(2,'0') }}</option>
                  </select>
                </label>
                <label class="field">
                  <select v-model.number="timePickerMinute">
                    <option v-for="m in 60" :key="m-1" :value="m-1">{{ String(m-1).padStart(2,'0') }}</option>
                  </select>
                </label>
              </div>
              <div class="time-picker-actions">
                <button class="primary" @click="confirmTimePicker">確定</button>
                <button @click="cancelTimePicker">取消</button>
              </div>
            </div>
          </div>
          <div v-else class="empty">
            <h3>未選擇定時任務</h3>
            <p>請先返回任務列表，點擊某個任務的「詳情」。</p>
          </div>
        </section>
      </template>
    </main>
    <div v-if="showProxySettings" class="picker-mask">
      <div class="picker-card rule-card">
        <h4>代理設定</h4>
        <div class="schedule-form">
          <label class="field">
            <span class="field-label">啓用代理</span>
            <select v-model="proxyEnabled">
              <option :value="false">關閉</option>
              <option :value="true">開啓</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">代理地址</span>
            <input v-model.trim="proxyUrl" placeholder="http://127.0.0.1:7890" />
          </label>
        </div>
        <div class="toolbar">
          <button class="primary" @click="saveProxySettings">保存</button>
          <button @click="closeProxySettings">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, reactive, defineComponent, h, computed, watch } from 'vue';

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
let editBlurTimer = null;
let cronTimer = null;
let offOpenProxySettings = null;
let refreshingProducts = false;
let refreshingChangeList = false;
let refreshingSchedules = false;
const suspendProductsRefresh = ref(false);
const suspendChangeRefresh = ref(false);
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
const changeFilter = ref('');
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
const scheduleTasks = ref([]);
const selectedScheduleTaskId = ref(null);
const scheduleView = ref('list');
const editingScheduleTaskId = ref(null);
const scheduleDraftName = ref('');
const scheduleDraftNote = ref('');
const scheduleDraftProducts = ref([]);
const scheduleDraftRules = ref([]);
const showRuleModal = ref(false);
const editingRuleId = ref(null);
const ruleFormType = ref('daily');
const ruleFormDailyTime = ref('09:00');
const ruleFormWeeklyDay = ref(1);
const ruleFormWeeklyTime = ref('09:00');
const ruleFormDays = ref(2);
const showTimePicker = ref(false);
const timePickerTarget = ref('daily');
const timePickerHour = ref(9);
const timePickerMinute = ref(0);
const showScheduleProductPicker = ref(false);
const scheduleProductCandidates = ref([]);
const scheduleCandidateChecked = reactive(new Set());
const scheduleCandidateFilter = ref('');
const scheduleCandidateBulkAction = ref('');
const scheduleCandidatePage = ref(1);
const scheduleCandidatePageSize = ref(20);
const scheduleTaskProductFilter = ref('');
const scheduleTaskCheckedProducts = reactive(new Set());
const scheduleTaskProductBulkAction = ref('');
const scheduleTaskProductPage = ref(1);
const scheduleTaskProductPageSize = ref(20);
const scheduleTaskLogs = ref([]);
const scheduleTaskLogGroups = ref([]);
const scheduleTaskLogGroupId = ref('');
const showProxySettings = ref(false);
const proxyEnabled = ref(false);
const proxyUrl = ref('');

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
const filteredChangeList = computed(() => {
  const keyword = changeFilter.value.toLowerCase();
  if (!keyword) return changeList.value;
  return changeList.value.filter((p) => (
    String(p.product_id).includes(keyword)
    || String(p.name || '').toLowerCase().includes(keyword)
  ));
});
const changeTotalPages = computed(() => Math.max(1, Math.ceil(filteredChangeList.value.length / changePageSize.value)));
const sortedChangeList = computed(() => {
  const list = [...filteredChangeList.value];
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
const selectedScheduleTask = computed(() => scheduleTasks.value.find((x) => x.id === selectedScheduleTaskId.value) || null);
const filteredScheduleCandidates = computed(() => {
  const kw = scheduleCandidateFilter.value.toLowerCase();
  if (!kw) return scheduleProductCandidates.value;
  return scheduleProductCandidates.value.filter((p) => (
    String(p.product_id).includes(kw) || String(p.name || '').toLowerCase().includes(kw)
  ));
});
const scheduleCandidateTotalPages = computed(() => Math.max(1, Math.ceil(filteredScheduleCandidates.value.length / scheduleCandidatePageSize.value)));
const pagedScheduleCandidates = computed(() => {
  const start = (scheduleCandidatePage.value - 1) * scheduleCandidatePageSize.value;
  return filteredScheduleCandidates.value.slice(start, start + scheduleCandidatePageSize.value);
});
const allCandidatesChecked = computed(() => (
  pagedScheduleCandidates.value.length > 0
  && pagedScheduleCandidates.value.every((x) => scheduleCandidateChecked.has(x.product_id))
));
const filteredScheduleTaskProducts = computed(() => {
  const list = scheduleDraftProducts.value || [];
  const kw = scheduleTaskProductFilter.value.toLowerCase();
  if (!kw) return list;
  return list.filter((p) => (
    String(p.product_id).includes(kw) || String(p.name || '').toLowerCase().includes(kw)
  ));
});
const scheduleTaskProductTotalPages = computed(() => Math.max(1, Math.ceil(filteredScheduleTaskProducts.value.length / scheduleTaskProductPageSize.value)));
const pagedScheduleTaskProducts = computed(() => {
  const start = (scheduleTaskProductPage.value - 1) * scheduleTaskProductPageSize.value;
  return filteredScheduleTaskProducts.value.slice(start, start + scheduleTaskProductPageSize.value);
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
watch([changeFilter], () => {
  changePage.value = 1;
});
watch([selectedId], () => {
  scheduleTasks.value = [];
  selectedScheduleTaskId.value = null;
  scheduleView.value = 'list';
  scheduleTaskCheckedProducts.clear();
  scheduleTaskProductFilter.value = '';
  scheduleTaskProductBulkAction.value = '';
  scheduleTaskProductPage.value = 1;
});
watch([scheduleCandidateFilter], () => {
  scheduleCandidatePage.value = 1;
});
watch([filteredScheduleCandidates, scheduleCandidatePageSize], () => {
  if (scheduleCandidatePage.value > scheduleCandidateTotalPages.value) scheduleCandidatePage.value = scheduleCandidateTotalPages.value;
  if (scheduleCandidatePage.value < 1) scheduleCandidatePage.value = 1;
});
watch([scheduleTaskProductFilter], () => {
  scheduleTaskProductPage.value = 1;
});
watch([filteredScheduleTaskProducts, scheduleTaskProductPageSize], () => {
  if (scheduleTaskProductPage.value > scheduleTaskProductTotalPages.value) scheduleTaskProductPage.value = scheduleTaskProductTotalPages.value;
  if (scheduleTaskProductPage.value < 1) scheduleTaskProductPage.value = 1;
});
watch([selectedScheduleTaskId], () => {
  scheduleTaskCheckedProducts.clear();
  scheduleTaskProductFilter.value = '';
  scheduleTaskProductBulkAction.value = '';
  scheduleTaskProductPage.value = 1;
  scheduleTaskLogGroupId.value = '';
  loadScheduleTaskLogs().catch(() => {});
});
function resetScheduleDraftFromTask(task) {
  if (!task) {
    scheduleDraftName.value = '';
    scheduleDraftNote.value = '';
    scheduleDraftProducts.value = [];
    scheduleDraftRules.value = [];
    return;
  }
  scheduleDraftName.value = task.name || '';
  scheduleDraftNote.value = task.note || '';
  scheduleDraftProducts.value = Array.isArray(task.products) ? task.products.map((x) => ({ ...x })) : [];
  scheduleDraftRules.value = Array.isArray(task.rules) ? task.rules.map((x) => ({ ...x })) : [];
}
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
async function openProxySettings() {
  try {
    const cfg = await getApi().getProxySettings();
    proxyEnabled.value = Boolean(cfg?.enabled);
    proxyUrl.value = String(cfg?.url || '');
    showProxySettings.value = true;
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function closeProxySettings() {
  showProxySettings.value = false;
}
async function saveProxySettings() {
  try {
    await getApi().saveProxySettings({ enabled: proxyEnabled.value, url: proxyUrl.value });
    showProxySettings.value = false;
    showNotice('代理設定已保存', 'success');
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
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
async function loadSchedules() {
  if (!selectedId.value) return;
  scheduleTasks.value = await getApi().getScheduleTasks(selectedId.value);
  if (selectedScheduleTaskId.value && !scheduleTasks.value.find((x) => x.id === selectedScheduleTaskId.value)) {
    selectedScheduleTaskId.value = null;
  }
}
async function loadScheduleTaskLogs() {
  if (!selectedScheduleTaskId.value) {
    scheduleTaskLogs.value = [];
    scheduleTaskLogGroups.value = [];
    scheduleTaskLogGroupId.value = '';
    return;
  }
  const api = getApi();
  if (typeof api.getScheduleTaskLogGroups === 'function') {
    scheduleTaskLogGroups.value = await api.getScheduleTaskLogGroups(selectedScheduleTaskId.value);
  } else {
    scheduleTaskLogGroups.value = [];
  }
  const gid = scheduleTaskLogGroupId.value ? Number(scheduleTaskLogGroupId.value) : null;
  scheduleTaskLogs.value = await api.getScheduleTaskLogs(selectedScheduleTaskId.value, 300, gid);
}
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
    } catch {
      // 避免一次 IPC 失败把旧的 running 状态永久留住
      runningByAccount[String(a.id)] = false;
    }
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
function isEditableEl(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el.isContentEditable);
}
function inProductsSection(el) {
  return Boolean(el && el.closest && el.closest('section') && active.value === 'products');
}
function inChangeSection(el) {
  return Boolean(el && el.closest && el.closest('section') && active.value === 'change');
}
function updateSectionSuspendByActiveElement() {
  const ae = document.activeElement;
  if (!isEditableEl(ae)) {
    suspendProductsRefresh.value = false;
    suspendChangeRefresh.value = false;
    return;
  }
  suspendProductsRefresh.value = inProductsSection(ae);
  suspendChangeRefresh.value = inChangeSection(ae);
}
function handleFocusIn(e) {
  if (isEditableEl(e?.target)) {
    if (editBlurTimer) {
      clearTimeout(editBlurTimer);
      editBlurTimer = null;
    }
    const target = e.target;
    suspendProductsRefresh.value = inProductsSection(target);
    suspendChangeRefresh.value = inChangeSection(target);
  }
}
function handleFocusOut() {
  if (editBlurTimer) clearTimeout(editBlurTimer);
  editBlurTimer = setTimeout(() => {
    updateSectionSuspendByActiveElement();
  }, 120);
}
function startLiveLogPolling() {
  if (logsTimer) return;
  logsTimer = setInterval(() => {
    // 進度/日誌持續更新；僅在輸入時暫停會觸發表格重渲染的列表刷新
    loadLogs().catch(() => {});
    refreshRunningState().catch(() => {});
    refreshAccountBadges().catch(() => {});
    if (!suspendProductsRefresh.value && !refreshingProducts && selectedId.value && isAccountRunning(selectedId.value) && active.value === 'products') {
      refreshingProducts = true;
      getApi().getProducts(selectedId.value)
        .then((rows) => { products.value = rows; })
        .catch(() => {})
        .finally(() => { refreshingProducts = false; });
    }
    if (!suspendChangeRefresh.value && !refreshingChangeList && selectedId.value && isAccountRunning(selectedId.value) && active.value === 'change') {
      refreshingChangeList = true;
      getApi().getChangeList(selectedId.value)
        .then((rows) => { changeList.value = rows; })
        .catch(() => {})
        .finally(() => { refreshingChangeList = false; });
    }
    if (selectedId.value && active.value === 'cron') {
      loadSchedules().catch(() => {});
      loadScheduleTaskLogs().catch(() => {});
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
function selectScheduleTask(id) {
  selectedScheduleTaskId.value = id;
}
async function openScheduleDetail(id, openEdit = false) {
  try {
    // 每次進入詳情前都先從 DB 重讀，避免使用前端暫存態
    await loadSchedules();
    selectedScheduleTaskId.value = id;
    scheduleView.value = 'detail';
    const t = scheduleTasks.value.find((x) => x.id === id);
    if (t) {
      resetScheduleDraftFromTask(t);
      if (openEdit) startEditScheduleTask(t);
    }
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function goBackScheduleList() {
  scheduleView.value = 'list';
  closeRuleModal();
  scheduleTaskLogs.value = [];
  scheduleTaskLogGroups.value = [];
  scheduleTaskLogGroupId.value = '';
}
function scheduleLogGroupLabel(g) {
  const ts = Number(g?.id || g?.created_at || 0);
  const dt = ts ? new Date(ts * 1000) : null;
  const label = dt && !Number.isNaN(dt.getTime()) ? dt.toLocaleString() : String(ts || '-');
  const msg = String(g?.sample_message || '');
  const rule = (msg.match(/rule=(\d+)/i) || [])[1] || '-';
  const days = (msg.match(/days=(\d+)/i) || [])[1] || '-';
  return `${label} / 規則${rule} / days ${days}`;
}
function scheduleTaskProgressPercent(t) {
  const total = Number(t?.run_total || 0);
  const done = Number(t?.run_done || 0);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}
function scheduleTaskProgressText(t) {
  const status = String(t?.run_status || '');
  const total = Number(t?.run_total || 0);
  const done = Number(t?.run_done || 0);
  const ok = Number(t?.run_success || 0);
  const fail = Number(t?.run_fail || 0);
  const skip = Number(t?.run_skip || 0);
  const startedAt = Number(t?.run_started_at || 0);
  const started = startedAt ? new Date(startedAt * 1000).toLocaleString() : '';
  if (status === 'running' && total > 0) return `${started ? `${started} / ` : ''}${done}/${total} success=${ok} fail=${fail} skip=${skip}`;
  if (status === 'failed') return `${started ? `${started} / ` : ''}上次執行失敗`;
  if (status === 'idle' && total > 0) return `${started ? `${started} / ` : ''}${done}/${total} success=${ok} fail=${fail} skip=${skip}`;
  return '-';
}
function toggleScheduleTaskProduct(id, on) {
  if (on) scheduleTaskCheckedProducts.add(id); else scheduleTaskCheckedProducts.delete(id);
}
function applyScheduleTaskProductBulkAction() {
  const action = scheduleTaskProductBulkAction.value;
  if (!action) return;
  if (action === 'select_page') {
    for (const p of pagedScheduleTaskProducts.value) scheduleTaskCheckedProducts.add(p.product_id);
  } else if (action === 'select_all') {
    for (const p of filteredScheduleTaskProducts.value) scheduleTaskCheckedProducts.add(p.product_id);
  } else if (action === 'unselect_page') {
    for (const p of pagedScheduleTaskProducts.value) scheduleTaskCheckedProducts.delete(p.product_id);
  } else if (action === 'unselect_all') {
    scheduleTaskCheckedProducts.clear();
  }
  scheduleTaskProductBulkAction.value = '';
}
async function createScheduleTask() {
  try {
    if (!selectedId.value) throw new Error('請先選擇賬戶');
    const name = `新建任務 ${new Date().toLocaleString()}`;
    await getApi().createScheduleTask(selectedId.value, { name, note: '' });
    await loadSchedules();
    await loadScheduleTaskLogs();
    if (scheduleTasks.value.length) {
      const created = [...scheduleTasks.value].sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (created) {
        selectedScheduleTaskId.value = created.id;
        scheduleView.value = 'detail';
        resetScheduleDraftFromTask(created);
        startEditScheduleTask(created);
      }
    }
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function startEditScheduleTask(task) {
  editingScheduleTaskId.value = task.id;
  scheduleDraftName.value = task.name || '';
  scheduleDraftNote.value = task.note || '';
}
function cancelScheduleTaskEdit() {
  const task = selectedScheduleTask.value;
  if (task) resetScheduleDraftFromTask(task);
  scheduleTaskCheckedProducts.clear();
  closeRuleModal();
}
async function saveScheduleTaskEdit() {
  try {
    const task = selectedScheduleTask.value;
    if (!task) return;
    const id = task.id;
    const name = scheduleDraftName.value.trim();
    if (!name) throw new Error('任務名稱不能為空');
    const note = scheduleDraftNote.value || '';
    await getApi().updateScheduleTask(id, { name, note });

    await loadSchedules();
    await loadScheduleTaskLogs();
    const latest = scheduleTasks.value.find((x) => x.id === id);
    if (latest) resetScheduleDraftFromTask(latest);
    showNotice('定時任務已保存', 'success');
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function toggleScheduleTaskActive(task) {
  try {
    await getApi().setScheduleTaskActive(task.id, !task.is_active);
    await loadSchedules();
    await loadScheduleTaskLogs();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function deleteScheduleTask(id) {
  try {
    const ret = await getApi().confirmDialog({
      title: '刪除定時任務',
      message: '確定刪除該定時任務？',
      detail: '刪除後規則與商品清單會一起清除。',
      buttons: ['刪除', '取消'],
      defaultId: 1,
      cancelId: 1,
    });
    if (!ret?.confirmed) return;
    await getApi().deleteScheduleTask(id);
    if (selectedScheduleTaskId.value === id) selectedScheduleTaskId.value = null;
    await loadSchedules();
    await loadScheduleTaskLogs();
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function createScheduleRule() {
  openRuleModalForCreate();
}
async function deleteScheduleRule(ruleId) {
  try {
    await getApi().deleteScheduleRule(ruleId);
    await loadSchedules();
    await loadScheduleTaskLogs();
    const latest = scheduleTasks.value.find((x) => x.id === selectedScheduleTaskId.value);
    if (latest) resetScheduleDraftFromTask(latest);
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function openRuleModalForCreate() {
  editingRuleId.value = null;
  ruleFormType.value = 'daily';
  ruleFormDailyTime.value = '09:00';
  ruleFormWeeklyDay.value = 1;
  ruleFormWeeklyTime.value = '09:00';
  ruleFormDays.value = 2;
  showRuleModal.value = true;
}
function openRuleModalForEdit(rule) {
  editingRuleId.value = rule.id;
  ruleFormType.value = rule.rule_type === 'weekly' ? 'weekly' : 'daily';
  ruleFormDailyTime.value = rule.daily_time || '09:00';
  ruleFormWeeklyDay.value = Number.isInteger(rule.weekly_day) ? rule.weekly_day : 1;
  ruleFormWeeklyTime.value = rule.weekly_time || '09:00';
  ruleFormDays.value = Number(rule.days_to_ship ?? 2);
  showRuleModal.value = true;
}
function closeRuleModal() {
  showRuleModal.value = false;
  editingRuleId.value = null;
  showTimePicker.value = false;
}
function openTimePicker(target) {
  timePickerTarget.value = target;
  const src = target === 'daily' ? ruleFormDailyTime.value : ruleFormWeeklyTime.value;
  const m = String(src || '09:00').match(/^(\d{1,2}):(\d{1,2})$/);
  timePickerHour.value = m ? Math.max(0, Math.min(23, Number(m[1]))) : 9;
  timePickerMinute.value = m ? Math.max(0, Math.min(59, Number(m[2]))) : 0;
  showTimePicker.value = true;
}
function confirmTimePicker() {
  const hh = String(timePickerHour.value).padStart(2, '0');
  const mm = String(timePickerMinute.value).padStart(2, '0');
  const v = `${hh}:${mm}`;
  if (timePickerTarget.value === 'daily') ruleFormDailyTime.value = v;
  else ruleFormWeeklyTime.value = v;
  showTimePicker.value = false;
}
function cancelTimePicker() {
  showTimePicker.value = false;
}
async function saveRuleModal() {
  try {
    const task = selectedScheduleTask.value;
    if (!task) throw new Error('請先選擇定時任務');
    const payload = {
      rule_type: ruleFormType.value,
      daily_time: ruleFormDailyTime.value,
      weekly_day: ruleFormWeeklyDay.value,
      weekly_time: ruleFormWeeklyTime.value,
      days_to_ship: Number(ruleFormDays.value),
    };
    if (!Number.isFinite(payload.days_to_ship) || payload.days_to_ship < 0 || payload.days_to_ship > 30) {
      throw new Error('備貨天數需為 0-30');
    }
    if (editingRuleId.value) {
      await getApi().updateScheduleRule(editingRuleId.value, payload);
    } else {
      await getApi().createScheduleRule(task.id, payload);
    }
    closeRuleModal();
    await loadSchedules();
    const latest = scheduleTasks.value.find((x) => x.id === task.id);
    if (latest) resetScheduleDraftFromTask(latest);
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function toggleScheduleCandidate(id, on) {
  if (on) scheduleCandidateChecked.add(id); else scheduleCandidateChecked.delete(id);
}
function toggleAllCandidates(on) {
  if (on) {
    for (const p of pagedScheduleCandidates.value) scheduleCandidateChecked.add(p.product_id);
  } else {
    for (const p of pagedScheduleCandidates.value) scheduleCandidateChecked.delete(p.product_id);
  }
}
function applyScheduleCandidateBulkAction() {
  const action = scheduleCandidateBulkAction.value;
  if (!action) return;
  if (action === 'select_page') {
    for (const p of pagedScheduleCandidates.value) scheduleCandidateChecked.add(p.product_id);
  } else if (action === 'select_all') {
    for (const p of filteredScheduleCandidates.value) scheduleCandidateChecked.add(p.product_id);
  } else if (action === 'unselect_page') {
    for (const p of pagedScheduleCandidates.value) scheduleCandidateChecked.delete(p.product_id);
  } else if (action === 'unselect_all') {
    scheduleCandidateChecked.clear();
  }
  scheduleCandidateBulkAction.value = '';
}
async function loadScheduleProductCandidates() {
  if (!selectedId.value || !selectedScheduleTask.value) return;
  scheduleProductCandidates.value = await getApi().getScheduleProductCandidates(selectedId.value, selectedScheduleTask.value.id);
}
async function openScheduleProductPicker() {
  try {
    if (!selectedScheduleTask.value) throw new Error('請先選擇定時任務');
    scheduleCandidateChecked.clear();
    scheduleCandidateFilter.value = '';
    scheduleCandidateBulkAction.value = '';
    scheduleCandidatePage.value = 1;
    await loadScheduleProductCandidates();
    showScheduleProductPicker.value = true;
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
function closeScheduleProductPicker() {
  showScheduleProductPicker.value = false;
  scheduleCandidateChecked.clear();
}
async function confirmAddScheduleProducts() {
  try {
    const task = selectedScheduleTask.value;
    if (!task) return;
    const ids = [...new Set([...scheduleCandidateChecked].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    if (!ids.length) throw new Error('請先選擇商品');
    await getApi().addScheduleProducts(task.id, ids);
    closeScheduleProductPicker();
    await loadSchedules();
    const latest = scheduleTasks.value.find((x) => x.id === task.id);
    if (latest) resetScheduleDraftFromTask(latest);
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function removeScheduleProducts(ids) {
  try {
    const task = selectedScheduleTask.value;
    if (!task) return;
    await getApi().removeScheduleProducts(task.id, ids);
    for (const id of ids) scheduleTaskCheckedProducts.delete(id);
    await loadSchedules();
    const latest = scheduleTasks.value.find((x) => x.id === task.id);
    if (latest) resetScheduleDraftFromTask(latest);
  } catch (e) {
    showNotice(getErrMsg(e), 'error');
  }
}
async function removeSelectedScheduleProducts() {
  const ids = [...new Set([...scheduleTaskCheckedProducts].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) return;
  await removeScheduleProducts(ids);
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
    for (const p of filteredChangeList.value) checkedChange.add(p.product_id);
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
  const ids = [...new Set([...checkedChange].map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  const total = ids.length;
  const days = Number(String(newDays.value ?? '').trim());
  if (!Number.isInteger(days) || days < 0 || days > 30) {
    showNotice('天數必須是 0-30 的整數', 'error');
    return;
  }
  if (total <= 0) {
    showNotice('請先勾選商品', 'error');
    return;
  }
  const confirmRet = await getApi().confirmDialog({
    title: '確認批量修改',
    message: '確認批量修改？',
    detail: `商品數量：${total}\n修改為：${days} 天`,
    buttons: ['確認', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  const ok = Boolean(confirmRet?.confirmed);
  if (!ok) return;

  runningByAccount[String(id)] = true;
  changeTaskStartedAt.value = Math.floor(Date.now() / 1000);
  changeProgressPercent.value = 0;
  changeProgressText.value = '修改任務啟動中...';
  activeTaskAccounts.add(String(id));
  startLiveLogPolling();
  try {
    await getApi().batchChangeDaysToShip(id, days, ids);
    checkedChange.clear();
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
  const confirmRet = await getApi().confirmDialog({
    title: '確認停止任務',
    message: '確認強制停止當前任務？',
    detail: '已完成的項目會保留，未完成的會中斷。',
    buttons: ['確認停止', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  const ok = Boolean(confirmRet?.confirmed);
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
  if (!cronTimer) {
    cronTimer = setInterval(() => {
      if (!selectedId.value || active.value !== 'cron') return;
      if (refreshingSchedules) return;
      refreshingSchedules = true;
      loadSchedules()
        .then(() => loadScheduleTaskLogs())
        .catch(() => {})
        .finally(() => { refreshingSchedules = false; });
    }, 1000);
  }
  try {
    const api = getApi();
    if (typeof api.onOpenProxySettings === 'function') {
      offOpenProxySettings = api.onOpenProxySettings(() => {
        openProxySettings().catch(() => {});
      });
    }
  } catch {}
});

onBeforeUnmount(() => {
  if (editBlurTimer) {
    clearTimeout(editBlurTimer);
    editBlurTimer = null;
  }
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
  if (offOpenProxySettings) {
    offOpenProxySettings();
    offOpenProxySettings = null;
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
.progress-bar.mini{width:140px;height:6px;margin-bottom:4px}
.progress-fill{height:100%;background:#2563eb;transition:width .35s ease}
.icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:999px;transition:all .2s ease}
.icon-btn.danger{border:1px solid #fca5a5;background:#fff;color:#dc2626;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.icon-btn.danger:hover{background:#fef2f2;border-color:#ef4444;box-shadow:0 2px 6px rgba(220,38,38,.2)}
.icon-btn.danger:active{transform:scale(.96)}
.stop-dot{width:16px;height:16px;border:2px solid currentColor;border-radius:999px;display:inline-flex;align-items:center;justify-content:center}
.stop-square{width:7px;height:7px;background:currentColor;border-radius:2px;display:block}
.schedule-box{margin-top:12px;padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:#fff}
.schedule-head{display:flex;align-items:center;gap:12px}
.schedule-head-right{margin-left:auto;display:flex;gap:8px}
.schedule-edit-row input{max-width:320px}
.section-head{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.schedule-box h4,.schedule-box h5{margin:8px 0}
.muted{font-size:12px;color:#6b7280}
.schedule-form{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.schedule-form .field{display:flex;flex-direction:column;gap:6px}
.field-label{font-size:12px;color:#374151}
.picker-mask{position:fixed;inset:0;background:rgba(17,24,39,.35);display:flex;align-items:center;justify-content:center;z-index:1000}
.picker-card{width:min(900px,92vw);max-height:84vh;overflow:auto;background:#fff;border-radius:10px;padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.rule-card{width:min(680px,90vw)}
.rule-card .toolbar{flex-wrap:wrap}
.time-trigger{width:100%;text-align:left;background:#fff;min-height:36px}
.time-picker-mask{
  position:fixed;
  inset:0;
  background:rgba(17,24,39,.25);
  display:flex;
  align-items:center;
  justify-content:center;
  z-index:1100;
}
.time-picker-pop{
  width:min(360px,90vw);
  padding:14px;
  border:1px solid #dbeafe;
  border-radius:10px;
  background:#fff;
  box-shadow:0 8px 24px rgba(0,0,0,.18);
}
.time-picker-pop h4{margin:0 0 10px}
.time-picker-row{display:flex;align-items:end;justify-content:flex-start;gap:4px}
.time-picker-row .field{gap:0;min-width:0}
.time-picker-row select{width:74px;padding:6px}
.time-picker-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
</style>
