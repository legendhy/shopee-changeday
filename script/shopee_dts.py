#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
蝦皮台灣 備貨天數 → 1 天（純 API 獨立腳本）

用蝦皮賣家中心的完整 cookie 直接呼叫 API，全程不需瀏覽器：
  生成備貨天數模板 → 等產出 → 下載 zip → 把每個 xlsx 的備貨天數欄改 1
  → 逐個上傳（每個等處理完成再傳下一個）

⚠ 重要：光 SPC_F 不夠（API 會回 403）。需要「完整 cookie 集」
（含 httpOnly 的 SPC_T 等）。用瀏覽器擴充功能 Cookie-Editor 匯出：

  1. Chrome 裝「Cookie-Editor」擴充功能
  2. 登入 https://seller.shopee.tw 後，在該頁面開 Cookie-Editor → Export（JSON）
  3. 把內容存成同目錄 cookies.json
  4. python shopee_dts.py

cookie 過期（約數週）就重新匯出。要自動登入請改用 Chrome 擴充功能版（../extension/）。
"""
import json, re, sys, time, uuid, zipfile, io, os
import requests

BASE = "https://seller.shopee.tw"
DTS_TEMPLATE_TYPE = 4            # 備貨天數
DTS_VALUE = 1
DTS_FIELD_KEY = "et_title_product_dts"   # xlsx 第1列的欄位 key
POLL_INTERVAL = 3
GEN_TIMEOUT = 240
UPLOAD_SETTLE_TIMEOUT = 180


def log(msg, lvl="info"):
    print(f"[{time.strftime('%H:%M:%S')}] [{lvl}] {msg}", flush=True)


def load_cookies():
    """讀 Cookie-Editor 匯出的 cookies.json（[{name,value,domain,path,...}, ...]）。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookies.json")
    if not os.path.exists(path):
        sys.exit(
            "缺少 cookies.json：請用 Cookie-Editor 等擴充功能，在已登入的 "
            "seller.shopee.tw 頁面匯出 cookie（JSON）存成同目錄 cookies.json。\n"
            "（光 SPC_F 不夠，API 會 403；需要完整 cookie 集）"
        )
    with open(path, encoding="utf-8") as f:
        raw = f.read().strip()
    # Cookie-Editor 可能匯出為 JSON 陣列，或 "name=value; name=value" 字串
    cookies = []
    if raw.startswith("["):
        for c in json.loads(raw):
            cookies.append((c["name"], str(c["value"]), c.get("domain", ".shopee.tw")))
    else:
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                cookies.append((k, v, ".shopee.tw"))
    if not cookies:
        sys.exit("cookies.json 解析失敗")
    log(f"載入 {len(cookies)} 個 cookie")
    return cookies


def make_session(cookies):
    s = requests.Session()
    for name, value, domain in cookies:
        try:
            s.cookies.set(name, value, domain=domain, path="/")
        except Exception:
            pass
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": BASE + "/portal/product-mass/mass-update/download",
        "Origin": BASE,
        "locale": "zh-Hant",
    })
    return s


def _cds():
    return {"SPC_CDS": str(uuid.uuid4()), "SPC_CDS_VER": 2}


# ----------------------------- API 層 ----------------------------------------
def api_generate(s):
    """生成備貨天數模板，回傳新建記錄 id。"""
    url = f"{BASE}/api/mass/mpsku/generate_template/"
    r = s.post(url, params=_cds(), json={"is_query": False, "template_type": DTS_TEMPLATE_TYPE}, timeout=30)
    if r.status_code != 200 or r.json().get("code") != 0:
        raise RuntimeError(f"generate 失敗: HTTP {r.status_code} {r.text[:200]}")
    log("已請求生成備貨天數模板")
    # 取當前最大 id 作為基準，回傳它（下一步輪詢找 id 更大的）
    recs = api_list(s, op=3)
    return max((x["id"] for x in recs), default=0)


def api_list(s, op):
    """列記錄。op=3 下載/生成；op=4 上傳。"""
    url = f"{BASE}/api/tool/mass_product/get_mass_record_list/"
    r = s.get(url, params={**_cds(), "page_number": 1, "page_size": 10, "operation_type": op}, timeout=30)
    if r.status_code != 200:
        return []  # 403/反爬：當空，下一輪重試
    j = r.json()
    return (j.get("data") or {}).get("list") or []


def wait_download_ready(s, after_id):
    """輪詢 op=3，等 id>after_id 的記錄 status==1 且回傳。"""
    log(f"輪詢生成進度（等 id>{after_id} 完成）…")
    start = time.time()
    last = None
    while time.time() - start < GEN_TIMEOUT:
        recs = api_list(s, 3)
        new = [x for x in recs if x["id"] > after_id]
        if new:
            new.sort(key=lambda x: x["id"], reverse=True)
            rec = new[0]
            last = rec
            if rec["record_status"] == 1 and rec.get("result_file_name"):
                log(f"模板產出: {rec['result_file_name']} ({rec['handled_count']}/{rec['total_count']})")
                return rec
            log(f"  進度 {rec.get('handled_count',0)}/{rec.get('total_count',0)} (status {rec['record_status']})")
        time.sleep(POLL_INTERVAL)
    raise RuntimeError(f"生成逾時 last={last}")


def download_zip(s, record_id):
    """下載完成的 zip，回傳 bytes。"""
    url = f"{BASE}/api/tool/mass_product/download_record_file/"
    r = s.get(url, params={**_cds(), "record_id": record_id, "timestamp": int(time.time() * 1000)}, timeout=120)
    if r.status_code != 200:
        raise RuntimeError(f"下載失敗 HTTP {r.status_code}")
    log(f"下載 zip: {len(r.content)//1024} KB")
    return r.content


def upload_one(s, filename, xlsx_bytes):
    """上傳一個 xlsx，回傳新建的上傳記錄 id。"""
    url = f"{BASE}/api/mass/mpsku/upload_edit_template/"
    files = {"file": (filename, xlsx_bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    data = {**_cds(), "operation_type": 4}
    r = s.post(url, files=files, data=data, timeout=120)
    if r.status_code != 200 or r.json().get("code") != 0:
        raise RuntimeError(f"上傳 {filename} 失敗: HTTP {r.status_code} {r.text[:200]}")
    recs = api_list(s, 4)
    return max((x["id"] for x in recs), default=0)


def wait_upload_done(s, after_id, filename):
    """輪詢 op=4，等 id>=after_id 的上傳記錄完成（status==1）。"""
    start = time.time()
    last = None
    while time.time() - start < UPLOAD_SETTLE_TIMEOUT:
        recs = api_list(s, 4)
        new = [x for x in recs if x["id"] >= after_id]
        if new:
            new.sort(key=lambda x: x["id"], reverse=True)
            rec = new[0]
            last = rec
            if rec["record_status"] == 1:
                total = rec.get("total_count", 0)
                handled = rec.get("handled_count", 0)
                if handled >= total:
                    log(f"✓ {filename} 完成 ({handled}/{total})")
                    return True
                else:
                    log(f"⚠ {filename} {handled}/{total} 部分失敗（可手動下載失敗明細）", "warn")
                    return False
            log(f"  {filename} {rec.get('handled_count',0)}/{rec.get('total_count',0)} (status {rec['record_status']})")
        time.sleep(POLL_INTERVAL)
    log(f"⚠ {filename} 等候完成逾時 last={last}", "warn")
    return False


# ---------------------- xlsx 改值（XML 層，保留格式）-------------------------
def _col_to_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def edit_dts_in_xlsx(xlsx_bytes):
    """把 xlsx 的 et_title_product_dts 欄（所有資料列，第5列起）改為 1。回傳新 bytes。"""
    zin = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
    sheet_name = next(n for n in zin.namelist() if re.match(r"xl/worksheets/sheet1\.xml$", n, re.I))
    xml = zin.read(sheet_name).decode("utf-8")

    # shared strings
    shared = []
    ss_name = next((n for n in zin.namelist() if re.match(r"xl/sharedstrings\.xml$", n, re.I)), None)
    if ss_name:
        ssx = zin.read(ss_name).decode("utf-8")
        shared = ["".join(re.findall(r"<t[^>]*>(.*?)</t>", m, re.S)) for m in re.findall(r"<si\b.*?</si>", ssx, re.S)]

    # 找目標欄（第1列 key 比對；同時支援 shared string 與 inline string）
    def _cell_val(inner):
        # inline string: <is><t>value</t></is>
        im = re.search(r"<is\b[^>]*>.*?<t[^>]*>(.*?)</t>.*?</is>", inner, re.S)
        if im:
            return im.group(1)
        vm = re.search(r"<v>([^<]*)</v>", inner)
        if vm:
            v = vm.group(1)
            return shared[int(v)] if (v.isdigit() and int(v) < len(shared)) else v
        return None

    m1 = re.search(r"<row\b[^>]*\br=\"1\"[^>]*>(.*?)</row>", xml, re.S)
    if not m1:
        raise RuntimeError("找不到第1列")
    target = None
    for cm in re.finditer(r'<c\b[^>]*\br="([A-Z]+)1"[^>]*>(.*?)</c>|<c\b[^>]*\br="([A-Z]+)1"[^>]*/>', m1.group(1), re.S):
        col = cm.group(1) or cm.group(3)
        val = _cell_val(cm.group(2) or "")
        if val == DTS_FIELD_KEY:
            target = col
            break
    if not target:
        raise RuntimeError(f"找不到欄位 {DTS_FIELD_KEY}")
    tnum = _col_to_num(target)

    # 改資料列
    def repl_row(m):
        attrs, inner = m.group(1), m.group(2)
        rm = re.search(r'\br="(\d+)"', attrs)
        if not rm:
            return m.group(0)
        rn = int(rm.group(1))
        if rn < 5:
            return m.group(0)
        cells = [{"num": _col_to_num(c.group(1)), "raw": c.group(0)}
                 for c in re.finditer(r'<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:/>|>.*?</c>)', inner, re.S)]
        new_cell = f'<c r="{target}{rn}"><v>{DTS_VALUE}</v></c>'
        idx = next((i for i, c in enumerate(cells) if c["num"] == tnum), -1)
        if idx >= 0:
            cells[idx]["raw"] = new_cell
        else:
            at = next((i for i, c in enumerate(cells) if c["num"] > tnum), len(cells))
            cells.insert(at, {"num": tnum, "raw": new_cell})
        return f"<row{attrs}>{''.join(c['raw'] for c in cells)}</row>"

    xml = re.sub(r"<row\b([^>]*)>(.*?)</row>", repl_row, xml, flags=re.S)

    # 重打包（只換 sheet，其餘原樣）
    out = io.BytesIO()
    zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == sheet_name:
            data = xml.encode("utf-8")
        zout.writestr(item, data)
    zout.close()
    return out.getvalue()


# ------------------------------ 主流程 ---------------------------------------
def main():
    cookies = load_cookies()
    s = make_session(cookies)

    log("=== 開始 ===")
    after = api_generate(s)
    rec = wait_download_ready(s, after)
    zip_bytes = download_zip(s, rec["id"])

    # 解 zip → 改每個 xlsx → 逐個上傳
    zin = zipfile.ZipFile(io.BytesIO(zip_bytes))
    names = sorted([n for n in zin.namelist() if not n.endswith("/") and n.lower().endswith(".xlsx")],
                   key=lambda x: int(re.search(r"(\d+)", os.path.basename(x)).group(1)))
    edited = {os.path.basename(n): edit_dts_in_xlsx(zin.read(n)) for n in names}
    log(f"已改值 {len(edited)} 個 xlsx（備貨天數=1）")

    for name in names:
        fn = os.path.basename(name)
        up_id = upload_one(s, fn, edited[fn])
        # 逐個上傳：等前一個完成再傳下一個（蝦皮一次只處理一份）
        ok = wait_upload_done(s, up_id, fn)
        if not ok:
            # 部分失敗重試一次
            log(f"重傳 {fn}…", "warn")
            up_id2 = upload_one(s, fn, edited[fn])
            wait_upload_done(s, up_id2, fn)

    log("=== 全部完成 ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"失敗: {e}", "error")
        sys.exit(1)
