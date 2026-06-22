// Clean verification of the xlsx edit logic (mirrors background.js).
// Run: node test/verify_edit.js
const fs = require("fs");
const path = require("path");
const JSZip = require(path.join(__dirname, "..", "lib", "jszip.min.js"));

const DTS_KEY = "et_title_product_dts";
const colToNum = (l) => { let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n; };

async function editDts(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const sp = Object.keys(zip.files).find((n) => /xl\/worksheets\/sheet1\.xml$/i.test(n));
  let xml = await zip.file(sp).async("string");
  let shared = [];
  const ss = Object.keys(zip.files).find((n) => /xl\/sharedstrings\.xml$/i.test(n));
  if (ss) {
    const sx = await zip.file(ss).async("string");
    shared = [...sx.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) =>
      (m[0].match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
  }
  const row1 = xml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/);
  let target = null;
  const cre = /<c\b[^>]*\br="([A-Z]+)1"[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\br="([A-Z]+)1"[^>]*\/>/g;
  let cm;
  while ((cm = cre.exec(row1[1])) !== null) {
    const col = cm[1] || cm[3];
    const v = (cm[2] || "").match(/<v>([^<]*)<\/v>/);
    if (v && (shared[parseInt(v[1], 10)] ?? v[1]) === DTS_KEY) { target = col; break; }
  }
  const targetNum = colToNum(target);
  xml = xml.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, (full, attrs, inner) => {
    const rM = attrs.match(/\br="(\d+)"/); if (!rM) return full;
    const rn = parseInt(rM[1], 10); if (rn < 5) return full;
    const cells = [...inner.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)]
      .map((m) => ({ num: colToNum(m[1]), raw: m[0] }));
    const nc = `<c r="${target}${rn}"><v>1</v></c>`;
    const idx = cells.findIndex((c) => c.num === targetNum);
    if (idx >= 0) cells[idx].raw = nc;
    else { let at = cells.length; for (let i = 0; i < cells.length; i++) if (cells[i].num > targetNum) { at = i; break; } cells.splice(at, 0, { raw: nc }); }
    return `<row${attrs}>${cells.map((c) => c.raw).join("")}</row>`;
  });
  zip.file(sp, xml);
  return { buf: await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }), target };
}

(async () => {
  const src = "C:/Users/Administrator/Downloads/mass_update_dts_info_240240078_20260621171607/1.xlsx";
  const buf = fs.readFileSync(src);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const { buf: edited, target } = await editDts(ab);
  const out = path.join(__dirname, "edited_1.xlsx");
  fs.writeFileSync(out, Buffer.from(edited));

  // read back: count data rows where col <target> == 1
  const zip = await JSZip.loadAsync(edited);
  const xml = await zip.file(Object.keys(zip.files).find((n) => /xl\/worksheets\/sheet1\.xml$/i.test(n))).async("string");
  let total = 0, one = 0;
  const re = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const rn = parseInt(m[1], 10); if (rn < 5) continue;
    total++;
    const c = m[2].match(new RegExp(`<c r="${target}${rn}"[^>]*>([\\s\\S]*?)<\\/c>`));
    if (c) { const v = c[1].match(/<v>([^<]*)<\/v>/); if (v && v[1] === "1") one++; }
  }
  console.log(`target col: ${target}`);
  console.log(`data rows: ${total}, col ${target}=1: ${one}`);
  console.log(one === total && total > 0 ? "PASS ✅" : "FAIL ❌");
  console.log("output:", out);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
