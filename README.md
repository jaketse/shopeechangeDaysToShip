# changeDaysToShipElectron_v2

Electron + Vue + SQLite 版本的 Shopee Days To Ship 工具，功能對齊 `changeDaysToShip`：

- 多帳號管理（新增 / 驗證 / 刪除）
- 透過 Shopee API 拉取商品並落地 SQLite
- 維護變更清單（加入/移除）
- 批次修改 `days_to_ship`（0-30，單商品最多重試 3 次）
- 產品同步與批次修改操作日誌
- 任務互斥：同帳號同時只允許一個任務執行

## Run

```bash
npm install
npm run dev
```

## Build renderer

```bash
npm run build
npm run start
```

## Cookie JSON required keys

- `SPC_CDS`
- `SPC_CDS_VER`
- `SPC_SI`
- `SPC_F`
- `SPC_T_ID`
- `SPC_T_IV`
- `SPC_U`

## Data file

SQLite 位置：

- `~/.shopee-days-to-ship-electron.db`
