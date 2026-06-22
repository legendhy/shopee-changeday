# 蝦皮台灣 備貨天數 批次工具

每周自動把賣場所有商品的**備貨天數**改為 **1 天**。透過 Playwright
模擬登入蝦皮賣家中心，下載商品資料 zip → 解出 xls → 把備貨天數改 1 →
重新打包 zip → 上傳回蝦皮。

## 安裝

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

## 設定帳號

複製設定檔並填入帳號、密碼、`SPC_F` cookie：

```bash
cp config.example.json config.json
```

```json
{
  "account": "你的蝦皮帳號",
  "password": "你的蝦皮密碼",
  "spc_f": "貼上 SPC_F cookie 的值",
  "headless": false
}
```

> `config.json` 已加入 `.gitignore`，不會進版控。
> 除錯階段建議 `"headless": false`，看得到瀏覽器比較好抓 selector。

## 執行

```bash
python run.py
```

打開 http://127.0.0.1:8000 ，點「**立即執行**」即可。即時記錄與下載的
檔案清單都會顯示在頁面上。

## 目前進度

| 階段 | 狀態 |
|---|---|
| 登入（SPC_F cookie + 帳密備援） | ✅ |
| 下載商品資料 zip、解出 xls | ✅ |
| 備貨天數全改 1 | ⏳ 已 scaffold，待用真實匯出檔驗證欄位名 |
| 重新打包 zip | ⏳ scaffold |
| 上傳回蝦皮 | ⏳ 待實作 |

## Selector 維護

所有賣家中心的 UI 文字與 selector 集中在
[app/shopee/selectors.py](app/shopee/selectors.py)。蝦皮改版時只需改這支
檔案，流程邏輯（[client.py](app/shopee/client.py)、[download.py](app/shopee/download.py)）
不用動。每個步驟都會在 `screenshots/` 存截圖方便對照。
