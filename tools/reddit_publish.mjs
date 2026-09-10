#!/usr/bin/env node
/**
 * Reddit 자동 게시 — docs/blog/reddit/*.md → 서브레딧 텍스트 포스트 (공식 API, 의존성 0)
 *
 *   node scripts/reddit_publish.mjs auth                  # 1회: 브라우저 승인 → refresh token을 .env.local에 저장 (비밀번호는 저장하지 않음)
 *   node scripts/reddit_publish.mjs list                  # 원고 상태
 *   node scripts/reddit_publish.mjs push <file.md> --now  # 즉시 게시 (Reddit엔 초안이 없어 --now 없이는 미리보기만)
 *   node scripts/reddit_publish.mjs next                  # status: queued 중 가장 오래된 1편 게시 (주간 크론용)
 *
 * 원고 front matter: title · subreddit · status(draft|queued|published) · flair(선택, 서브 플레어 텍스트)
 * .env.local: REDDIT_CLIENT_ID · REDDIT_CLIENT_SECRET (reddit.com/prefs/apps → "script" 앱, redirect uri = http://localhost:8765/callback)
 *             REDDIT_REFRESH_TOKEN (auth가 저장) · REDDIT_USER_AGENT(선택)
 * 주의: 서브레딧마다 self-promo 규칙이 다르다 — 원고는 "먼저 답하고 마지막에 개발자 공개" 형식만. 주 1편 넘게 올리지 않는다.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvLocal, saveEnvKey, parsePost, listPosts, markPublished, stripEditorNotes } from './lib/blogmd.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs', 'blog', 'reddit');
const REDIRECT = 'http://localhost:8765/callback';
const UA = () => process.env.REDDIT_USER_AGENT || 'macos:appa-blog:0.1 (by /u/appa-dev)';

function creds() {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('❌ .env.local에 REDDIT_CLIENT_ID · REDDIT_CLIENT_SECRET이 필요해요 — https://www.reddit.com/prefs/apps 에서 "script" 앱을 만들고 redirect uri를 http://localhost:8765/callback 으로.');
  return { id, secret, basic: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') };
}

async function tokenRequest(body) {
  const { basic } = creds();
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA() },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Reddit 토큰 ${r.status}: ${j.error || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** 1회 승인 — 로컬 콜백 서버로 code를 받아 refresh token 저장 */
async function auth() {
  const { id } = creds();
  const state = randomBytes(8).toString('hex');
  const url = `https://www.reddit.com/api/v1/authorize?client_id=${encodeURIComponent(id)}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT)}&duration=permanent&scope=${encodeURIComponent('identity submit read')}`;
  console.log('브라우저에서 이 주소를 열어 승인해 주세요 (Reddit에 로그인된 브라우저):\n\n  ' + url + '\n');
  await new Promise((resolveP, rejectP) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      if (err || u.searchParams.get('state') !== state) { res.end('승인이 거절됐거나 state가 달라요. 터미널을 확인하세요.'); srv.close(); rejectP(new Error(`승인 실패: ${err || 'state mismatch'}`)); return; }
      try {
        const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
        saveEnvKey(ROOT, 'REDDIT_REFRESH_TOKEN', t.refresh_token);
        const me = await api('/api/v1/me', {}, t.access_token);
        res.end(`승인됐어요 (u/${me.name}). 이 창은 닫아도 돼요.`);
        console.log(`✓ u/${me.name} 로 승인 — refresh token을 .env.local에 저장했어요.`);
        srv.close(); resolveP();
      } catch (e) { res.end('토큰 교환 실패. 터미널을 확인하세요.'); srv.close(); rejectP(e); }
    }).listen(8765, '127.0.0.1');
    setTimeout(() => { srv.close(); rejectP(new Error('5분 안에 승인이 없어 종료했어요.')); }, 5 * 60 * 1000).unref();
  });
}

async function accessToken() {
  const rt = process.env.REDDIT_REFRESH_TOKEN;
  if (!rt) throw new Error('❌ REDDIT_REFRESH_TOKEN이 없어요 — 먼저 `node scripts/reddit_publish.mjs auth`');
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: rt })).access_token;
}

async function api(path, opts = {}, token) {
  const r = await fetch(`https://oauth.reddit.com${path}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA(), ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Reddit ${r.status} ${path}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function submit(p) {
  const token = await accessToken();
  const sr = (p.meta.subreddit || '').replace(/^r\//, '');
  if (!sr) throw new Error(`front matter에 subreddit 없음: ${p.file}`);
  const body = new URLSearchParams({ api_type: 'json', kind: 'self', sr, title: p.meta.title, text: stripEditorNotes(p.body), resubmit: 'true', sendreplies: 'true' });
  if (p.meta.flair_id) body.set('flair_id', p.meta.flair_id);
  const j = await api('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, token);
  const errs = j.json?.errors || [];
  if (errs.length) throw new Error(`Reddit 거절: ${errs.map((e) => e.join(' ')).join('; ')}`);
  const url = j.json?.data?.url;
  console.log(`게시 → ${url}`);
  markPublished(p, url);
  return url;
}

const argv = process.argv.slice(2), cmd = argv[0];
try {
  loadEnvLocal(ROOT);
  if (cmd === 'auth') await auth();
  else if (cmd === 'list') for (const p of listPosts(DIR)) console.log(`${p.meta.status.padEnd(9)} r/${(p.meta.subreddit || '?').replace(/^r\//, '')}  ${p.meta.title}  (${p.file.replace(ROOT + '/', '')})`);
  else if (cmd === 'push') {
    const p = parsePost(resolve(argv[1] || ''));
    if (!argv.includes('--now')) { console.log(`--- r/${p.meta.subreddit} · ${p.meta.title}\n\n${stripEditorNotes(p.body)}\n\n(미리보기만 — 실제 게시는 --now)`); }
    else await submit(p);
  } else if (cmd === 'next') {
    const q = listPosts(DIR).filter((p) => p.meta.status === 'queued');
    if (!q.length) console.log('queued 원고가 없어요.'); else await submit(q[0]);
  } else console.log('사용법: auth | list | push <file> [--now] | next');
} catch (e) { console.error(e.message.startsWith('❌') ? e.message : `❌ ${e.message}`); process.exit(1); }
