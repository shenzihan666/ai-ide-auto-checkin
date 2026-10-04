#!/usr/bin/env node
/**
 * trae-cn-auto-checkin —— Trae CN 每日签到（领 100 积分）自动化
 *
 * 思路（仿 workbuddy-auto-signin）：不走 UI，直接复用本机 Trae CN 桌面端
 * 的登录态，调用官方签到 HTTP 接口。
 *
 * - 凭据来源：%APPDATA%\Trae CN\User\globalStorage\storage.json
 *   键 `iCubeAuthInfo://icube.cloudide`，值为 Trae 自有信封加密的 UserInfo
 *   （含 access token / host）。信封格式逆向自 Trae CN 自带代码：
 *     magic "tc\x05\x10\x00\x00" + 32B 密钥材料 + AES-128-CBC 密文
 *     密钥派生：SHA512(SHA512(keyMat) ‖ Q^Z) 取前 16B 为 key、后 16B 为 iv
 *     明文前 64B 为 SHA512 校验头。
 * - 接口（与官方客户端完全相同）：
 *     POST {host}/trae/api/v2/ug/checkin_credits/status  body {req_source:1}
 *     POST {host}/trae/api/v2/ug/checkin_credits/claim    body {req_source:1}
 *     头：Content-Type: application/json; Authorization: Cloud-IDE-JWT <token>
 * - 不处理 token 刷新：token 约 14 天有效，打开一次 Trae CN 即自动续期。
 *
 * 零第三方依赖，仅需 Node.js >= 18（用到原生 fetch 与 node:crypto）。
 * 脚本永远不会输出 token 本体，日志中不含任何凭据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, createDecipheriv } from 'node:crypto';

// ---------- 常量 ----------

const REQ_SOURCE_DEFAULT = Number(process.env.TRAECN_REQ_SOURCE || 1); // 1 = Trae CN IDE（SOLO 为 2）
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_RETRIES = 2;            // status 只读，网络失败可重试
const CLAIM_RETRIES = 1;             // claim 当日幂等（重复领取服务端拒绝），网络失败可重试 1 次
const RETRY_DELAYS = [2_000, 8_000]; // 退避
const RUN_BUDGET_MS = 90_000;        // 单次运行总预算

const STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

// Trae CN iCubeAuth 信封（逆向自 resources\app\out\main.js）
const MAGIC = Buffer.from([116, 99, 5, 16, 0, 0]); // "tc\x05\x10\x00\x00"
const KEY_LEN = 32;
const CKSUM_LEN = 64;
const SALT_A = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
const DEFAULT_STORAGE = path.join(APPDATA, 'Trae CN', 'User', 'globalStorage', 'storage.json');
const STORAGE_FILE = process.env.TRAECN_STORAGE_FILE || DEFAULT_STORAGE;
const AUTH_KEY_DEFAULT = 'iCubeAuthInfo://icube.cloudide';
const LOG_FILE = process.env.TRAECN_CHECKIN_LOG ||
  path.join(import.meta.dirname || process.cwd(), 'checkin.log');

// 设备/用户头：领取接口（下单）校验必需。
// x-device-id 必须是服务端签发的真实设备号（storage.json 键 iCubeAuthInfo://icube-dc:<id>），
// 假值/缺失分别返回 9074（文案误导为"人太多"）与 9004。
function resolveDeviceIdFromStorage(storage) {
  const key = Object.keys(storage).find((k) => k.startsWith('iCubeAuthInfo://icube-dc:'));
  return key ? key.split('icube-dc:')[1] : undefined;
}

// ---- token 失效自动恢复：启动 Trae CN 让其续期，完成后关闭 ----
const APP_IMAGE = 'Trae CN.exe';
const APP_EXE_CANDIDATES = [
  process.env.TRAECN_EXE,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Trae CN', 'Trae CN.exe'),
  'C:\\Program Files\\Trae CN\\Trae CN.exe',
  'C:\\Program Files\\TRAE SOLO CN\\TRAE SOLO CN.exe',
].filter(Boolean);
const KEEP_APP = /^(1|true|yes|on)$/i.test(process.env.TRAECN_KEEP_APP || ''); // 续期后不关闭客户端
const RENEW_WAIT_MS = 180_000; // 最多等 3 分钟
const RENEW_POLL_MS = 10_000;
let renewNote = ''; // 拼进本次运行汇报

let runStart = Date.now(); // 续期耗时后重置（见 renewViaApp）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha512 = (b) => createHash('sha512').update(b).digest();
const localStamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ---------- 凭据解密 ----------

class CredentialError extends Error {
  constructor(code, detail) { super(detail); this.code = code; this.detail = detail; }
}

function decryptEnvelope(b64) {
  let blob;
  try { blob = Buffer.from(b64, 'base64'); } catch { throw new CredentialError('INVALID_FORMAT', '凭据不是合法 base64'); }
  if (blob.length < MAGIC.length + KEY_LEN + 16) throw new CredentialError('INVALID_FORMAT', '凭据长度不足');
  if (!blob.subarray(0, 6).equals(MAGIC)) throw new CredentialError('UNSUPPORTED_ENVELOPE', `未知信封版本: ${blob.subarray(0, 6).toString('hex')}`);
  const keyMat = blob.subarray(6, 6 + KEY_LEN);
  const ct = blob.subarray(6 + KEY_LEN);
  const n = Buffer.alloc(CKSUM_LEN + 64);
  n.set(sha512(keyMat), 0);
  for (let i = 0; i < 64; i++) n[CKSUM_LEN + i] = SALT_A[i] ^ SALT_B[i];
  const digest = sha512(n);
  n.set(digest, 0);
  let pt;
  try {
    const d = createDecipheriv('aes-128-cbc', n.subarray(0, 16), n.subarray(16, 32));
    pt = Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new CredentialError('DECRYPT_FAILED', 'AES 解密失败');
  }
  const data = pt.subarray(CKSUM_LEN);
  if (!pt.subarray(0, CKSUM_LEN).equals(sha512(data).subarray(0, CKSUM_LEN))) {
    throw new CredentialError('DECRYPT_FAILED', '校验和不匹配，凭据可能损坏');
  }
  return data.toString('utf-8');
}

function loadUserInfo() {
  let raw;
  try { raw = fs.readFileSync(STORAGE_FILE, 'utf-8'); }
  catch { throw new CredentialError('NO_AUTH', `未找到 Trae CN 登录凭据文件：${STORAGE_FILE}（请先安装并在 Trae CN 中登录一次）`); }
  let storage;
  try { storage = JSON.parse(raw); } catch { throw new CredentialError('INVALID_FORMAT', 'storage.json 不是合法 JSON'); }

  const candidates = [AUTH_KEY_DEFAULT,
    ...Object.keys(storage).filter((k) => k.startsWith('iCubeAuthInfo://') && k !== AUTH_KEY_DEFAULT)];
  const deviceId = process.env.TRAECN_DEVICE_ID || resolveDeviceIdFromStorage(storage);
  const errs = [];
  for (const key of candidates) {
    const v = storage[key];
    if (typeof v !== 'string' || !v) continue;
    let user;
    try { user = JSON.parse(decryptEnvelope(v)); }
    catch (e) { errs.push(`${key}: ${e.detail}`); continue; }
    if (user && typeof user.token === 'string' && typeof user.host === 'string') {
      return { ...user, _key: key, _deviceId: deviceId };
    }
  }
  throw new CredentialError('NO_SESSION',
    errs.length ? `凭据解密失败：${errs.join('；')}` : 'storage.json 中没有可用的登录会话（请先登录 Trae CN）');
}

// ---------- token 失效自动恢复 ----------

function appIsRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 10_000 });
    return out.toLowerCase().includes(APP_IMAGE.toLowerCase());
  } catch { return false; }
}

function readFreshUser() {
  try {
    const u = loadUserInfo();
    const exp = Date.parse(u.expiredAt || '');
    return Number.isFinite(exp) && exp > Date.now() ? u : null;
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
  const fresh = readFreshUser();
  if (fresh) return { user: fresh }; // 竞态下已被续期（如客户端刚好在刷新）
  let spawnedPid = null;
  if (!appIsRunning()) {
    const exe = APP_EXE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!exe) return { error: `未找到 Trae CN（${APP_EXE_CANDIDATES.join('；')}），可用环境变量 TRAECN_EXE 指定` };
    try {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
      child.unref();
      spawnedPid = child.pid;
    } catch (e) { return { error: `启动 Trae CN 失败：${e.message}` }; }
  }
  const deadline = Date.now() + RENEW_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RENEW_POLL_MS);
    const u = readFreshUser();
    if (u) {
      if (spawnedPid && !KEEP_APP) await closePidTree(spawnedPid); // 只关自己拉起的进程树
      runStart = Date.now();
      return { user: u, launched: !!spawnedPid };
    }
  }
  return { error: `等待 ${RENEW_WAIT_MS / 60000} 分钟未见续期，可能需要重新登录（客户端窗口已保留）`, launched: !!spawnedPid };
}

// ---------- HTTP ----------

class NetworkError extends Error {}
class ApiError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

function budgetLeft() { return RUN_BUDGET_MS - (Date.now() - runStart); }

function buildHeaders(user) {
  const h = { 'Content-Type': 'application/json', 'Authorization': `Cloud-IDE-JWT ${user.token}` };
  if (user._deviceId) h['x-device-id'] = user._deviceId;
  if (user.userId) h['x-user-id'] = String(user.userId);
  h['X-User-Region'] = user.userRegion?.region || 'CN';
  return h;
}

async function postJson(url, user, body, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(timeout, Math.max(1, budgetLeft())));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(user),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = undefined; }
    if (res.status !== 200) throw new ApiError(res.status, data ?? text.slice(0, 200));
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new NetworkError(e.name === 'AbortError' ? `请求超时（${url}）` : `网络错误：${e.message}`);
  } finally { clearTimeout(timer); }
}

async function postJsonRetry(url, user, body, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(RETRY_DELAYS[Math.min(i - 1, RETRY_DELAYS.length - 1)]);
    try { return await postJson(url, user, body); }
    catch (e) {
      if (e instanceof ApiError) throw e; // 业务/HTTP 状态错误不重试
      lastErr = e;
      if (budgetLeft() < 3_000) break;
    }
  }
  throw lastErr;
}

// ---------- 业务 ----------

async function fetchStatus(user) {
  return postJsonRetry(user.host + STATUS_PATH, user, { req_source: REQ_SOURCE_DEFAULT }, STATUS_RETRIES);
}

async function claimCredits(user) {
  return postJsonRetry(user.host + CLAIM_PATH, user, { req_source: REQ_SOURCE_DEFAULT }, CLAIM_RETRIES);
}

function validateStatus(d) {
  if (!d || typeof d.enable !== 'boolean' || typeof d.checked_in !== 'boolean') {
    throw new Error(`签到状态返回格式异常：${JSON.stringify(d).slice(0, 200)}`);
  }
  return d;
}

const fmtExpiry = (iso) => (iso || '').replace('T', ' ').slice(0, 16) || '未知时间';

async function cmdStatus(user) {
  const d = validateStatus(await fetchStatus(user));
  return {
    result: 'OK',
    report: `签到功能${d.enable ? '已开启' : '未开启'}，今日${d.checked_in ? '已签到' : '未签到'}，今日积分 ${d.credits ?? '？'}（额外 ${d.extra_credits ?? '？'}）`,
    detail: { enable: d.enable, checked_in: d.checked_in, credits: d.credits, extra_credits: d.extra_credits },
    exit: 0,
  };
}

async function cmdClaim(user) {
  const before = validateStatus(await fetchStatus(user));
  if (!before.enable) return { result: 'INACTIVE', report: '签到活动未开启，无需领取', exit: 0 };
  if (before.checked_in) return { result: 'ALREADY', report: `今日已签过（今日积分 ${before.credits ?? '？'}），无需重复领取`, exit: 0 };
  return doClaim(user);
}

async function doClaim(user) {
  let claim;
  try {
    claim = await claimCredits(user);
  } catch (e) {
    if (e instanceof NetworkError) throw e; // 网络问题向上抛，由顶层报告
    // HTTP/业务错误（如今日重复领取服务端返回 9004）——用状态复核定性
    const after = await fetchStatus(user).catch(() => undefined);
    if (after && after.checked_in) {
      return { result: 'SUCCESS', report: `签到成功（服务端确认已签，今日积分 ${after.credits ?? '？'}）`, detail: { claim_code: claim?.code ?? e.status }, exit: 0 };
    }
    const msg = e instanceof ApiError ? `HTTP ${e.status} ${(typeof e.body === 'object' ? JSON.stringify(e.body) : e.body)}` : e.message;
    return { result: 'CLAIM_REJECTED', report: `领取请求被服务端拒绝：${msg}`, needs_attention: true, exit: 1 };
  }
  // 9074 = 服务端繁忙/限流（官方文案"当前参与用户太多，请稍后再试"），30 秒后重试一次
  if (claim?.code === 9074) {
    await sleep(30_000);
    claim = await claimCredits(user).catch(() => claim);
  }
  if (claim?.code === 9074) {
    return { result: 'SERVER_BUSY', report: '领取未成功（9074）：多为设备号未被服务端认可（偶发限流），等待下一次自动运行重试', detail: { claim_code: 9074 }, exit: 0 };
  }
  // claim 正常返回后，再查一次状态拿积分口径（成功响应字段未在文档中，保守复核）
  const after = await fetchStatus(user).catch(() => undefined);
  const credits = claim?.credits ?? after?.credits;
  if (after && after.checked_in !== true && claim?.code !== 0) {
    return { result: 'CLAIM_REJECTED', report: `领取未生效：${JSON.stringify(claim).slice(0, 200)}`, needs_attention: true, exit: 1 };
  }
  return { result: 'SUCCESS', report: `签到成功，今日积分 +${credits ?? 100}`, detail: { claim_code: claim?.code }, exit: 0 };
}

async function cmdAuto(user) {
  const d = validateStatus(await fetchStatus(user));
  if (!d.enable) return { result: 'INACTIVE', report: '签到活动未开启', exit: 0 };
  if (d.checked_in) return { result: 'ALREADY', report: `今日已签过（今日积分 ${d.credits ?? '？'}）`, detail: { credits: d.credits }, exit: 0 };
  return doClaim(user);
}

function cmdDoctor(user) {
  const checks = [];
  const push = (name, ok, note) => checks.push({ name, ok, note: note || '' });
  push('Node >= 18', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
  push('凭据文件存在', fs.existsSync(STORAGE_FILE), STORAGE_FILE);
  push('登录会话可解密', !!user, user ? `键 ${user._key}，用户 ${user.userId}` : '');
  if (user) {
    push('账号 scope', user.account?.scope === 'marscode', `scope=${user.account?.scope}（签到仅支持 marscode 账号）`);
    const exp = Date.parse(user.expiredAt || '');
    push('token 未过期', Number.isFinite(exp) && exp > Date.now(), `过期时间 ${fmtExpiry(user.expiredAt)} UTC`);
    push('API host', /^https?:\/\//.test(user.host), user.host);
    push('设备号(icube-dc)', !!user._deviceId, user._deviceId || 'storage.json 中未找到 iCubeAuthInfo://icube-dc:<id>，领取会返回 9074');
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
  try { fs.appendFileSync(LOG_FILE, `[${localStamp()}] ${line}\n`, 'utf-8'); }
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
  console.log(`用法: node checkin.mjs [auto|silent|status|claim|doctor|help]

  auto     默认。查状态，未签则领取（幂等，重复运行不会多领）
  silent   同 auto，但结果追加写入 ${LOG_FILE} 而非 stdout（配合计划任务）
  status   只查签到状态（只读）
  claim    领取签到积分（幂等）
  doctor   离线自检凭据与运行环境，不联网

环境变量: TRAECN_STORAGE_FILE / TRAECN_CHECKIN_LOG / TRAECN_REQ_SOURCE / TRAECN_EXE / TRAECN_KEEP_APP`);
  process.exit(0);
}

if (!['auto', 'silent', 'status', 'claim', 'doctor'].includes(mode)) {
  finish({ result: 'ERROR', report: `未知模式：${mode}（见 help）`, exit: 1 });
}

let user = null;
try {
  user = loadUserInfo();
} catch (e) {
  if (e instanceof CredentialError) finish({ result: e.code, report: e.detail, needs_attention: true, exit: 1 });
  finish({ result: 'ERROR', report: `脚本运行异常（${e.message}）`, needs_attention: true, exit: 1 });
}

// token 过期：auto/silent 模式下先尝试自动续期（启动 Trae CN → 等待回写 → 关闭 → 继续）
if (mode !== 'doctor') {
  const exp = Date.parse(user.expiredAt || '');
  if (Number.isFinite(exp) && exp <= Date.now()) {
    if (mode !== 'auto' && mode !== 'silent') {
      finish({
        result: 'AUTH_EXPIRED',
        report: `登录 token 已过期（${fmtExpiry(user.expiredAt)} UTC）。运行 auto 模式可自动启动 Trae CN 续期，或手动打开一次 Trae CN`,
        needs_attention: true, exit: 1,
      });
    }
    const r = await renewViaApp();
    if (!r.user) {
      finish({
        result: 'AUTH_EXPIRED',
        report: `token 已失效，自动续期未成功：${r.error}。请打开 Trae CN 检查登录状态`,
        needs_attention: true, exit: 1,
      });
    }
    user = r.user;
    renewNote = r.launched
      ? '（token 曾失效：已自动启动 Trae CN 完成续期并关闭）'
      : '（token 已由正在运行的 Trae CN 续期）';
  }
  if (user.account?.scope && user.account.scope !== 'marscode') {
    finish({ result: 'UNSUPPORTED_SCOPE', report: `当前账号 scope 为 ${user.account.scope}，官方签到仅对 marscode（CN 个人版）账号开放`, needs_attention: true, exit: 1 });
  }
}

try {
  switch (mode) {
    case 'status': finish(await cmdStatus(user));
    case 'claim': finish(await cmdClaim(user));
    case 'doctor': finish(cmdDoctor(user));
    default: finish(await cmdAuto(user)); // auto / silent
  }
} catch (e) {
  const isNet = e instanceof NetworkError;
  finish({
    result: isNet ? 'NETWORK' : 'ERROR',
    report: isNet ? `网络不可达：${e.message}，等待下一次运行重试` : `脚本运行异常（${e.message}）`,
    needs_attention: !isNet,
    exit: 1,
  });
}
