# 蝦皮備貨天數 → 1 天（Python 純 API 腳本）

用蝦皮賣家中心的**完整 cookie** 直接呼叫 API，**全程不用瀏覽器**：
生成備貨天數模板 → 等產出 → 下載 zip → 改值 → 逐個上傳。

> 給自己用、可排程（cron / Task Scheduler）。要分發給別人、自動登入，請用 Chrome 擴充功能版（`../extension/`）。

## ⚠ 重要：需要完整 cookie（光 SPC_F 不夠）

實測：只用 `SPC_F` 呼叫 API 會回 **403**。蝦皮需要**完整 cookie 集**（含 httpOnly 的 `SPC_T` 等）。用瀏覽器擴充功能匯出：

1. Chrome 安裝 **Cookie-Editor**（或任何能匯出 httpOnly cookie 的工具）。
2. 登入 `https://seller.shopee.tw` 後，在該頁面打開 Cookie-Editor → **Export** → 選 **JSON** 格式。
3. 把匯出內容存成本目錄 **`cookies.json`**（一個 `[{name, value, domain, ...}, ...]` 陣列）。
4. 執行 `python shopee_dts.py`。

> Cookie 過期（約數週）就重新匯出。需要完全自動（含登入）請用擴充功能版。

## 安裝與執行

```bash
pip install requests
# 放好 cookies.json（見上）
python shopee_dts.py
```

## 排程（每周）

Windows Task Scheduler / Linux cron 每周跑一次 `python shopee_dts.py`。

## 流程（5 個 API，皆只靠 cookie）

| 步驟 | API |
|---|---|
| 生成模板 | `POST /api/mass/mpsku/generate_template` body `{"is_query":false,"template_type":4}` |
| 輪詢下載進度 | `GET /api/tool/mass_product/get_mass_record_list?operation_type=3` |
| 下載 zip | `GET /api/tool/mass_product/download_record_file?record_id=<id>` |
| 上傳 xlsx | `POST /api/mass/mpsku/upload_edit_template`（multipart, operation_type=4） |
| 輪詢上傳進度 | `GET /api/tool/mass_product/get_mass_record_list?operation_type=4` |

備貨天數欄 = xlsx 第 I 欄（`et_title_product_dts`），第 5 列起為資料。改值採 XML 層修改，原樣保留格式，同時相容 shared-string / inline-string 兩種格式。
