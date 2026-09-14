'use strict';
// 赛季排行榜 / 个人页界面接线回归：用 DOM/WebSocket 桩加载真实 client.js，
// 模拟"打开排行榜 → 切换排序 → 点玩家行进个人页 → 打开我的战绩"的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, open: false, _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    get offsetWidth() { return 0; },
  };
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
    contains: (c) => el._cls.has(c),
  };
  el.querySelectorAll = () => [];
  el.querySelector = () => null;
  return el;
}

const els = new Map();
const $id = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

// 排行榜动态行：client 渲染后给每行绑 onclick；按 pid 缓存同一元素，
// 否则桩的 querySelectorAll 每次都返回新元素，绑定的 onclick 会丢。
const rowEls = new Map();
function rankRowEl(pid) {
  if (!rowEls.has(pid)) {
    const el = makeEl();
    el.dataset.pid = pid;
    rowEls.set(pid, el);
  }
  return rowEls.get(pid);
}
let rankPids = [];

const SCREENS = ['screen-home', 'screen-lobby', 'screen-game', 'screen-end',
  'screen-practice', 'screen-practice-game', 'screen-fav', 'screen-review',
  'screen-rank', 'screen-profile'];
global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => sel === '.screen' ? SCREENS.map($id) : [],
  createElement: () => makeEl('div'),
};
// 真实 HTML 里只有首页默认可见，其余 section 带 hidden
SCREENS.slice(1).forEach(id => $id(id).classList.add('hidden'));
const mem = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };

const sentMsgs = [];
let clientWs = null;
global.WebSocket = class {
  constructor() { this.readyState = 1; clientWs = this; }
  send(s) { sentMsgs.push(JSON.parse(s)); }
};
global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');
global.WTFav = require('../public/favorites.js');
// 无 WebCrypto 环境：client 应回退到 Math.random 生成密钥；测试结束后恢复，
// 避免影响同一 node --test 进程里后续加载的其他客户端测试。
// Node 的 globalThis.crypto 在原型上，delete 不生效，直接覆盖为 undefined 模拟缺失。
const savedCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });

require('../public/client.js');

const recv = (msg) => clientWs.onmessage({ data: JSON.stringify(msg) });
const lastSent = (type) => sentMsgs.filter(m => m.type === type).at(-1);

// 排行榜容器：按当前响应里出现的 pid 暴露动态行
$id('rank-list').querySelectorAll = (sel) =>
  sel === '.rank-row' ? rankPids.map(pid => rankRowEl(pid)) : [];

const setRows = (pids) => { rankPids = pids; };

test.after(() => { globalThis.crypto = savedCrypto; });

test('从首页直接进我的战绩再返回排行榜：无缓存时补拉，不卡在加载中', () => {
  // 全新客户端尚未拉取过排行榜（rankRows=null）
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, 0);

  // 首页直接打开"我的战绩"（不经过排行榜），再点"返回排行榜"
  $id('btn-my-profile').onclick();
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  recv({ type: 'profile', profile: null });
  $id('btn-profile-back-rank').onclick();

  // 关键回归：返回时必须主动发起排行榜请求，否则 rankRows 一直为 null、永远显示加载中
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, 1);
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.match($id('rank-list').innerHTML, /加载中/);

  // 请求返回后正常渲染、退出加载态
  setRows(['pidA']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 1, wins: 1, ties: 0, losses: 0,
      totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 }] });
  assert.doesNotMatch($id('rank-list').innerHTML, /加载中/);
  assert.match($id('rank-list').innerHTML, /甲/);
});

test('从排行榜点行进个人页再返回：已有缓存直接展示，不重复请求', () => {
  // 上一测已加载排行榜；点某行进个人页
  setRows(['pidA']);
  $id('rank-list').querySelectorAll('.rank-row')[0].onclick();
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  recv({ type: 'profile', profile: {
    pid: 'pidA', name: '甲', rank: 1, games: 1, wins: 1, ties: 0, losses: 0,
    totalScore: 10, avgScore: 10, bestChain: 3, winRate: 1, lastAt: 5 } });

  const before = sentMsgs.filter(m => m.type === 'leaderboard').length;
  $id('btn-profile-back-rank').onclick();
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.strictEqual(sentMsgs.filter(m => m.type === 'leaderboard').length, before,
    '已有排行榜数据时返回不应重复请求');
  assert.doesNotMatch($id('rank-list').innerHTML, /加载中/);
  assert.match($id('rank-list').innerHTML, /甲/);
});

test('排行榜：打开即请求，切换三种排序，点玩家行进其个人页', () => {
  // 打开排行榜：切到 rank 屏并发出默认按总分的请求
  $id('btn-rank-home').onclick();
  assert.strictEqual($id('screen-rank').classList.contains('hidden'), false);
  assert.strictEqual(lastSent('leaderboard').sort, 'total');
  assert.match($id('rank-list').innerHTML, /加载中/);

  // 服务端返回两名玩家：渲染表格，第一名高亮主排序按钮
  setRows(['pidA', 'pidB']);
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
    { rank: 2, pid: 'pidB', name: '乙', games: 2, wins: 0, ties: 0, losses: 2,
      totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 },
  ] });
  assert.match($id('rank-list').innerHTML, /甲/);
  assert.match($id('rank-list').innerHTML, /100%/);
  assert.ok($id('btn-sort-total').classList.contains('primary'));

  // 切到按胜场：发请求，响应后高亮对应按钮
  $id('btn-sort-wins').onclick();
  assert.strictEqual(lastSent('leaderboard').sort, 'wins');
  recv({ type: 'leaderboard', sort: 'wins', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
  ] });
  assert.ok($id('btn-sort-wins').classList.contains('primary'));
  assert.ok(!$id('btn-sort-total').classList.contains('primary'));

  // 切到按胜率
  $id('btn-sort-rate').onclick();
  assert.strictEqual(lastSent('leaderboard').sort, 'rate');

  // 点某玩家行：请求该 pid 的个人页
  setRows(['pidB']);
  recv({ type: 'leaderboard', sort: 'rate', startedAt: 1000, rows: [
    { rank: 1, pid: 'pidA', name: '甲', games: 2, wins: 2, ties: 0, losses: 0,
      totalScore: 20, avgScore: 10, bestChain: 4, winRate: 1, lastAt: 5 },
    { rank: 2, pid: 'pidB', name: '乙', games: 2, wins: 0, ties: 0, losses: 2,
      totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 },
  ] });
  $id('rank-list').querySelectorAll('.rank-row').find(r => r.dataset.pid === 'pidB').onclick();
  assert.strictEqual(lastSent('profile').pid, 'pidB');
  assert.strictEqual(lastSent('profile').pidSecret, undefined);
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);
  assert.match($id('profile-body').innerHTML, /加载中/);

  recv({ type: 'profile', profile: {
    pid: 'pidB', name: '乙', rank: 2, games: 2, wins: 0, ties: 0, losses: 2,
    totalScore: 6, avgScore: 3, bestChain: 2, winRate: 0, lastAt: 5 } });
  const html = $id('profile-body').innerHTML;
  assert.match(html, /乙/);
  assert.match(html, /最高连锁/);
  assert.match(html, />2</); // bestChain 值
  assert.match(html, /平均得分/);
});

test('个人页：我的战绩凭本机密钥查询；无记录玩家显示空态', () => {
  // 从首页打开"我的战绩"（首次访问时才惰性生成本机密钥）
  $id('btn-profile-back-home').onclick();
  assert.strictEqual($id('screen-home').classList.contains('hidden'), false);
  $id('btn-my-profile').onclick();
  const mySecret = mem.wt_pid_secret;
  assert.ok(/^[a-f0-9]{64}$/.test(mySecret), '无 crypto 时应回退生成 64 位十六进制密钥');
  // 只把密钥发给服务器，公开 pid 由服务端派生
  assert.strictEqual(lastSent('profile').pidSecret, mySecret);
  assert.strictEqual(lastSent('profile').pid, undefined);
  assert.strictEqual($id('screen-profile').classList.contains('hidden'), false);

  // 服务器表示本机玩家还没有已结束对局
  recv({ type: 'profile', profile: null });
  assert.match($id('profile-body').innerHTML, /还没有已结束的对局/);
});

test('空赛季排行榜显示空态；返回排行榜按钮不重新请求', () => {
  $id('btn-rank-home').onclick();
  recv({ type: 'leaderboard', sort: 'total', startedAt: 1000, rows: [] });
  assert.match($id('rank-list').innerHTML, /还没有人完成对局/);
});
