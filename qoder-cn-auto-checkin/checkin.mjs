#!/usr/bin/env node
/**
 * qoder-cn-auto-checkin —— Qoder CN 每日领取 100 Credits 自动化
 *
 * 思路（仿 workbuddy-auto-signin / trae-cn-auto-checkin）：不走 UI，
 * 复用本机 Qoder CN 桌面端的登录态，直接调用官方 campaigns API 领取。
 *
 * - 凭据来源：%APPDATA%\com.qodercn.app.stable\auth.v1.dat
 *   标准 Chromium v10 信封：AES-256-GCM，密钥由同目录 Local State 的
 *   os_crypt.encrypted_key 经 Windows DPAPI（CurrentUser）解开。
 *   DPAPI 由 PowerShell 子进程完成（System.Security.ProtectedData），
 *   AES-GCM 由 node:crypto 完成——全程零第三方依赖。
 * - 接口（与官方客户端一致）：
 *     GET  {openapi}/sash/api/v1/me/campaigns                  列活动
 *     POST {openapi}/sash/api/v1/me/campaigns/{id}/claim       领取
 *   头：Accept: application/json；Authorization: Bearer <token>；
 *       Cosy-ClientType: 10；User-Agent: Qoder
 *   （桌面端内嵌活动页的请求由 app 经 webRequest 注入同样的头，逆向自 app.asar）
 * - 领取策略：领取所有 actionType=CLAIM_BENEFIT 且 claimStatus=CLAIMABLE
 *   的活动（通常就是"每日领 100 Credits"）；重复 claim 服务端拒绝（replayed），
 *   幂等安全。
 * - 不处理 token 刷新：token 约半个月有效，打开一次 Qoder CN 即自动续期。
 *
 * 需要 Node.js >= 18 与 PowerShell（Windows 自带）。
 * 脚本永远不会输出 token 本体，日志中不含任何凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

// ---------- 常量 ----------

const ROAMING = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
const DATA_DIR = process.env.QODERCN_DATA_DIR || path.join(ROAMING, 'com.qodercn.app.stable');
const AUTH_FILE = process.env.QODERCN_AUTH_FILE || path.join(DATA_DIR, 'auth.v1.dat');
const LOCAL_STATE = process.env.QODERCN_LOCAL_STATE || path.join(DATA_DIR, 'Local State');

const OPENAPI_BASE = process.env.QODERCN_OPENAPI_BASE || 'https://openapi.qoder.com.cn';
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';

const REQUEST_TIMEOUT_MS = 15_000;
const LIST_RETRIES = 2;
const CLAIM_RETRIES = 1;             // 服务端有 replayed 防重放，网络失败重试 1 次安全
const RETRY_DELAYS = [2_000, 8_000];
const RUN_BUDGET_MS = 120_000;

const LOG_FILE = process.env.QODERCN_CHECKIN_LOG ||
  path.join(import.meta.dirname || process.cwd(), 'checkin.log');

// ---- token 失效自动恢复：启动 Qoder CN 让其续期，完成后关闭 ----
const APP_IMAGE = 'Qoder CN.exe';
const APP_EXE_CANDIDATES = [
  process.env.QODERCN_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Qoder CN', 'Qoder CN.exe'),
  'C:\\Program Files\\Qoder CN\\Qoder CN.exe',
].filter(Boolean);
const KEEP_APP = /^(1|true|yes|on)$/i.test(process.env.QODERCN_KEEP_APP || ''); // 续期后不关闭客户端
const RENEW_WAIT_MS = 180_000; // 最多等 3 分钟
const RENEW_POLL_MS = 10_000;
let renewNote = ''; // 拼进本次运行汇报

let runStart = Date.now(); // 续期耗时后重置（见 renewViaApp）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

// ---------- 凭据解密 ----------

class CredentialError extends Error {
  constructor(code, detail) { super(detail); this.code = code; this.detail = detail; }
}

function dpapiUnprotect(blob) {
  // PowerShell 5.1 兼容写法：数组切片去 DPAPI 前缀
  const b64 = blob.toString('base64');
  const ps = [
    `$b=[Convert]::FromBase64String('${b64}')`,
    'Add-Type -AssemblyName System.Security',
    `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b[5..($b.Length-1)], $null, 'CurrentUser'))`,
  ].join('; ');
  try {
    return Buffer.from(execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20_000 }).trim(), 'base64');
  } catch (e) {
    throw new CredentialError('RUNTIME_UNAVAILABLE', `DPAPI 解密失败（PowerShell）：${e.message}`);
  }
}

function loadAuth() {
  let dat;
  try { dat = fs.readFileSync(AUTH_FILE); }
  catch { throw new CredentialError('NO_AUTH', `未找到 Qoder CN 登录凭据：${AUTH_FILE}（请先安装并登录 Qoder CN）`); }
  if (dat.subarray(0, 3).toString() !== 'v10') {
    throw new CredentialError('UNSUPPORTED_ENVELOPE', `凭据信封不是 v10：${dat.subarray(0, 6).toString('hex')}`);
  }
  let ls;
  try { ls = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf-8')); }
  catch { throw new CredentialError('NO_AUTH', `无法读取 ${LOCAL_STATE}`); }
  const encKey = ls?.os_crypt?.encrypted_key;
  if (!encKey) throw new CredentialError('INVALID_FORMAT', 'Local State 中没有 os_crypt.encrypted_key');
  const key = dpapiUnprotect(Buffer.from(encKey, 'base64'));
  try {
    const d = createDecipheriv('aes-256-gcm', key, dat.subarray(3, 15));
    d.setAuthTag(dat.subarray(-16));
    const json = Buffer.concat([d.update(dat.subarray(15, -16)), d.final()]).toString('utf-8');
    const auth = JSON.parse(json);
    if (!auth?.token) throw new Error('missing token');
    return auth;
  } catch {
    throw new CredentialError('DECRYPT_FAILED', 'auth.v1.dat 解密失败（可能换了机器/用户，请在 Qoder CN 中重新登录一次）');
  }
}

// ---------- token 失效自动恢复 ----------

function appIsRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 10_000 });
    return out.toLowerCase().includes(APP_IMAGE.toLowerCase());
  } catch { return false; }
}

function readFreshAuth() {
  try {
    const a = loadAuth();
    const exp = Date.parse(a.expiresAt || '');
    return Number.isFinite(exp) && exp > Date.now() ? a : null;
  } catch { return null; } // 客户端回写一半时解密失败，下一轮再试
}

async function closePidTree(pid) {
  // 类 VS Code 应用会忽略 WM_CLOSE（驻留托盘），先优雅后强制
  const alive = () => {
    try {
      return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 10_000 }).includes(String(pid));
    } catch { return false; }
  };
  try { execFileSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', timeout: 15_000 }); } catch { /* 已退出 */ }
  for (let i = 0; i < 8 && alive(); i++) await sleep(1_000);
  if (alive()) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 }); } catch { /* 已退出 */ }
  }
}

async function renewViaApp() {
  const fresh = readFreshAuth();
  if (fresh) return { auth: fresh }; // 竞态下已被续期
  let spawnedPid = null;
  if (!appIsRunning()) {
    const exe = APP_EXE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!exe) return { error: `未找到 Qoder CN（${APP_EXE_CANDIDATES.join('；')}），可用环境变量 QODERCN_EXE 指定` };
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
      child.unref();
      spawnedPid = child.pid;
    } catch (e) { return { error: `启动 Qoder CN 失败：${e.message}` }; }
  }
  const deadline = Date.now() + RENEW_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RENEW_POLL_MS);
    const a = readFreshAuth();
    if (a) {
      if (spawnedPid && !KEEP_APP) await closePidTree(spawnedPid); // 只关自己拉起的进程树
      runStart = Date.now();
      return { auth: a, launched: !!spawnedPid };
    }
  }
  return { error: `等待 ${RENEW_WAIT_MS / 60000} 分钟未见续期，可能需要重新登录（客户端窗口已保留）`, launched: !!spawnedPid };
}

// ---------- HTTP ----------

class NetworkError extends Error {}
class ApiError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

const budgetLeft = () => RUN_BUDGET_MS - (Date.now() - runStart);

function authHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
  };
}

async function request(token, url, method = 'GET') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(REQUEST_TIMEOUT_MS, Math.max(1, budgetLeft())));
  try {
    const res = await fetch(url, { method, headers: authHeaders(token), signal: ctrl.signal });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = undefined; }
    if (!res.ok) throw new ApiError(res.status, data ?? text.slice(0, 200));
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new NetworkError(e.name === 'AbortError' ? `请求超时（${url}）` : `网络错误：${e.message}`);
  } finally { clearTimeout(timer); }
}

async function requestRetry(token, url, method, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(RETRY_DELAYS[Math.min(i - 1, RETRY_DELAYS.length - 1)]);
    try { return await request(token, url, method); }
    catch (e) {
      if (e instanceof ApiError) throw e;
      lastErr = e;
      if (budgetLeft() < 3_000) break;
    }
  }
  throw lastErr;
}

// ---------- 业务 ----------

const claimableOf = (listRes) => {
  const campaigns = Array.isArray(listRes?.campaigns) ? listRes.campaigns
    : Array.isArray(listRes?.data?.campaigns) ? listRes.data.campaigns : [];
  return campaigns.filter((c) =>
    c && c.actionType === 'CLAIM_BENEFIT' && c.claimStatus === 'CLAIMABLE' && typeof c.campaignId === 'string');
};

const describeBenefit = (c) => {
  const b = c.benefit || {};
  return b.kind === 'CREDITS' ? `${b.amount ?? '?'} Credits` : `${b.kind || '权益'}${b.amount ? ` ${b.amount}` : ''}`;
};

async function listCampaigns(token) {
  const d = await requestRetry(token, OPENAPI_BASE + CAMPAIGNS_PATH, 'GET', LIST_RETRIES);
  if (!d || !Array.isArray(d.campaigns) && !Array.isArray(d?.data?.campaigns)) {
    throw new Error(`活动列表返回格式异常：${JSON.stringify(d).slice(0, 200)}`);
  }
  return d;
}

async function claimOne(token, c) {
  const url = `${OPENAPI_BASE}${CAMPAIGNS_PATH}/${encodeURIComponent(c.campaignId)}/claim`;
  try {
    const r = await requestRetry(token, url, 'POST', CLAIM_RETRIES);
    if (r?.status === 'CLAIMED' || r?.replayed === true) {
      return { ok: true, replayed: !!r?.replayed, name: describeBenefit(c) };
    }
    // 响应异常 → 复核
    const after = await listCampaigns(token);
    const still = claimableOf(after).some((x) => x.campaignId === c.campaignId);
    if (!still) return { ok: true, replayed: false, name: describeBenefit(c) };
    return { ok: false, name: describeBenefit(c), err: `领取响应异常：${JSON.stringify(r).slice(0, 150)}` };
  } catch (e) {
    if (e instanceof NetworkError) throw e;
    const after = await listCampaigns(token).catch(() => undefined);
    const still = after ? claimableOf(after).some((x) => x.campaignId === c.campaignId) : true;
    if (!still) return { ok: true, replayed: false, name: describeBenefit(c) };
    const msg = e instanceof ApiError ? `HTTP ${e.status} ${typeof e.body === 'object' ? JSON.stringify(e.body) : e.body}` : e.message;
    return { ok: false, name: describeBenefit(c), err: msg };
  }
}

async function cmdAuto(auth) {
  const list = await listCampaigns(auth.token);
  const todo = claimableOf(list);
  if (todo.length === 0) {
    return { result: 'ALREADY', report: '今日无可领取的活动（已领完或暂无活动）', exit: 0 };
  }
  const results = [];
  for (const c of todo) {
    if (budgetLeft() < 5_000) { results.push({ ok: false, name: describeBenefit(c), err: '时间预算耗尽，留待下次' }); break; }
    results.push(await claimOne(auth, c));
  }
  const okAll = results.every((r) => r.ok);
  const got = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok);
  if (okAll) {
    return { result: 'SUCCESS', report: `领取成功：${got.join('、')}`, detail: { claimed: got }, exit: 0 };
  }
  if (got.length) {
    return { result: 'PARTIAL', report: `部分领取成功（${got.join('、')}）；失败：${failed.map((f) => `${f.name}（${f.err}）`).join('；')}`, needs_attention: true, detail: { claimed: got, failed }, exit: 1 };
  }
  return { result: 'CLAIM_REJECTED', report: `领取失败：${failed.map((f) => `${f.name}（${f.err}）`).join('；')}`, needs_attention: true, detail: { failed }, exit: 1 };
}

async function cmdStatus(auth) {
  const list = await listCampaigns(auth.token);
  const todo = claimableOf(list);
  const campaigns = (list?.campaigns || list?.data?.campaigns || []);
  const lines = campaigns.map((c) => `${c.campaignKey}: ${c.actionType}/${c.claimStatus}${c.benefit?.kind === 'CREDITS' ? ` (${c.benefit.amount} Credits)` : ''}`);
  return {
    result: 'OK',
    report: `可领取 ${todo.length} 个活动` + (lines.length ? `；当前：${lines.join('，')}` : ''),
    detail: { claimable: todo.map(describeBenefit) },
    exit: 0,
  };
}

function cmdDoctor(auth) {
  const checks = [];
  const push = (name, ok, note) => checks.push({ name, ok, note: note || '' });
  push('Node >= 18', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
  push('凭据文件存在', fs.existsSync(AUTH_FILE), AUTH_FILE);
  push('登录会话可解密', !!auth?.token, auth ? `用户 ${auth.user?.name ?? auth.user?.id}` : '');
  if (auth) {
    const exp = Date.parse(auth.expiresAt || '');
    push('token 未过期', Number.isFinite(exp) && exp > Date.now(), `过期时间 ${auth.expiresAt || '未知'}`);
  }
  const allOk = checks.every((c) => c.ok);
  return {
    result: allOk ? 'OK' : 'PROBLEM',
    report: allOk ? '本机自检全部通过（未联网验证服务端认证）' : '本机自检存在问题：' + checks.filter((c) => !c.ok).map((c) => `${c.name}（${c.note}）`).join('；'),
    detail: checks,
    exit: allOk ? 0 : 1,
  };
}

// ---------- 输出 ----------

function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, `[${nowISO().replace('T', ' ').slice(0, 19)}] ${line}\n`, 'utf-8'); }
  catch { /* 日志写不进去不视为签到失败 */ }
}

function finish(out) {
  if (renewNote && !out.report.includes(renewNote)) out.report += renewNote;
  const line = JSON.stringify(out);
  if (mode === 'silent') appendLog(line);
  else console.log(line);
  process.exit(out.exit ?? 0);
}

// ---------- 入口 ----------

const mode = (process.argv[2] || 'auto').toLowerCase();

if (mode === 'help' || mode === '--help' || mode === '-h') {
  console.log(`用法: node checkin.mjs [auto|silent|status|doctor|help]

  auto     默认。列出活动，领取所有可领的 CLAIM_BENEFIT（通常是每日 100 Credits）
  silent   同 auto，但结果追加写入 ${LOG_FILE}（配合计划任务）
  status   只查活动与领取状态（只读）
  doctor   离线自检凭据与运行环境，不联网

环境变量: QODERCN_AUTH_FILE / QODERCN_LOCAL_STATE / QODERCN_OPENAPI_BASE / QODERCN_CHECKIN_LOG / QODERCN_EXE / QODERCN_KEEP_APP`);
  process.exit(0);
}

if (!['auto', 'silent', 'status', 'doctor'].includes(mode)) {
  finish({ result: 'ERROR', report: `未知模式：${mode}（见 help）`, exit: 1 });
}

let auth = null;
try {
  auth = loadAuth();
} catch (e) {
  if (e instanceof CredentialError) finish({ result: e.code, report: e.detail, needs_attention: true, exit: 1 });
  finish({ result: 'ERROR', report: `脚本运行异常（${e.message}）`, needs_attention: true, exit: 1 });
}

if (mode !== 'doctor') {
  const exp = Date.parse(auth.expiresAt || '');
  if (Number.isFinite(exp) && exp <= Date.now()) {
    if (mode !== 'auto' && mode !== 'silent') {
      finish({
        result: 'AUTH_EXPIRED',
        report: `登录 token 已过期（${auth.expiresAt}）。运行 auto 模式可自动启动 Qoder CN 续期，或手动打开一次 Qoder CN`,
        needs_attention: true, exit: 1,
      });
    }
    const r = await renewViaApp();
    if (!r.auth) {
      finish({
        result: 'AUTH_EXPIRED',
        report: `token 已失效，自动续期未成功：${r.error}。请打开 Qoder CN 检查登录状态`,
        needs_attention: true, exit: 1,
      });
    }
    auth = r.auth;
    renewNote = r.launched
      ? '（token 曾失效：已自动启动 Qoder CN 完成续期并关闭）'
      : '（token 已由正在运行的 Qoder CN 续期）';
  }
}

try {
  switch (mode) {
    case 'status': finish(await cmdStatus(auth));
    case 'doctor': finish(cmdDoctor(auth));
    default: finish(await cmdAuto(auth)); // auto / silent
  }
} catch (e) {
  const isNet = e instanceof NetworkError;
  const isAuth = e instanceof ApiError && (e.status === 401 || e.status === 403);
  finish({
    result: isAuth ? 'AUTH_REJECTED' : isNet ? 'NETWORK' : 'ERROR',
    report: isAuth ? `服务端拒绝认证（HTTP ${e.status}），请在 Qoder CN 中重新登录`
      : isNet ? `网络不可达：${e.message}，等待下一次运行重试`
      : `脚本运行异常（${e.message}）`,
    needs_attention: !isNet,
    exit: 1,
  });
}
