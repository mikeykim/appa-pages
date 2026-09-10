// 블로그 원고 공용 — front matter 파싱 + 마크다운→HTML (wp_publish · naver_pack · reddit_publish가 공유)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvLocal(root) {
  const f = join(root, '.env.local');
  try {
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch { /* 없으면 셸 환경만 */ }
}

/** .env.local의 키 하나를 추가/교체한다 (토큰 저장용). 값은 절대 출력하지 않는다. */
export function saveEnvKey(root, key, value) {
  const f = join(root, '.env.local');
  let s = ''; try { s = readFileSync(f, 'utf8'); } catch { /* 새 파일 */ }
  const line = `${key}=${value}`;
  s = new RegExp(`^${key}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^${key}=.*$`, 'm'), line) : s.replace(/\s*$/, '') + `\n${line}\n`;
  writeFileSync(f, s);
}

export function parsePost(file) {
  const src = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`front matter 없음: ${file}`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    meta[kv[1]] = v;
  }
  for (const k of ['title', 'status']) if (!meta[k]) throw new Error(`front matter에 ${k} 없음: ${file}`);
  return { file, meta, body: m[2], raw: src, fm: m[1] };
}

/** front matter status → published + 게시일·URL 기록 */
export function markPublished(p, link) {
  const fm = p.fm.replace(/^status:.*$/m, 'status: published') + `\npublished_at: ${new Date().toISOString().slice(0, 10)}\npublished_url: ${link}`;
  writeFileSync(p.file, `---\n${fm}\n---\n${p.body}`);
}

export function listPosts(dir) {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/^\d.*\.md$/.test(n)) files.push(f); } };
  walk(dir);
  return files.sort().map((f) => { try { return parsePost(f); } catch { return null; } }).filter(Boolean);
}

/** '> ' 편집 메모 블록(제목 후보·태그·이미지 안내)을 뺀 본문 — Reddit 등 마크다운 그대로 올리는 곳용 */
export function stripEditorNotes(md) {
  return md.replace(/\r/g, '').split('\n').filter((l) => !/^> ?/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])((https?:\/\/)[^\s<)]+)/g, '$1<a href="$2">$2</a>');
}

/** 마크다운 → HTML. 원고에 쓰는 문법만: #/##/### · 문단 · **굵게** · 링크 · 표 · -목록 · 1.목록 · --- . '> ' 블록은 편집 메모라 제외.
 *  h1은 플랫폼 제목이 되므로 본문에선 h2부터 (# → h2, ## → h3). */
export function mdToHtml(md, { tableClass = 'wp-block-table' } = {}) {
  const out = [];
  const lines = md.replace(/\r/g, '').split('\n');
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { flush(); i++; continue; }
    if (/^> ?/.test(l)) { flush(); while (i < lines.length && /^> ?/.test(lines[i])) i++; continue; }
    if (/^---+$/.test(l.trim())) { flush(); out.push('<hr>'); i++; continue; }
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) { flush(); const lv = h[1].length + 1; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
    if (/^\|/.test(l)) {
      flush(); const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]); const body = rows.slice(1).filter((r) => !/^\|\s*:?-+/.test(r));
      out.push(`<figure class="${tableClass}"><table><thead><tr>` + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></figure>');
      continue;
    }
    if (/^- /.test(l)) {
      flush(); const items = [];
      while (i < lines.length && /^- /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      out.push('<ul>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ul>'); continue;
    }
    if (/^\d+\. /.test(l)) {
      flush(); const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, '')); i++; }
      out.push('<ol>' + items.map((t) => `<li>${inline(t)}</li>`).join('') + '</ol>'); continue;
    }
    para.push(l.trim()); i++;
  }
  flush();
  return out.join('\n');
}
