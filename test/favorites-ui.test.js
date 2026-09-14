'use strict';
// 个人收藏本界面接线回归：用可按选择器查询子元素的 DOM 桩加载真实 client.js，
// 模拟"回放收藏连接 → 打开收藏本 → 搜索/筛选/笔记/删除 → 复习标记"的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: { display: '' }, dataset: {}, onclick: null, open: false,
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (el._listeners[ev] || []).forEach(fn => fn(arg || { target: el })); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    get offsetWidth() { return 0; },
    closest() { return el; },
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
const $id = (id) => {
  if (!els.has(id)) {
    const el = makeEl(id);
    // 关系筛选下拉在 HTML 里初始有一个「全部关系」选项；浏览器会从 innerHTML 同步出 options
    if (id === 'fav-relation-filter') {
      el._initialOptions = true;
      Object.defineProperty(el, 'options', {
        get() {
          const vals = [...el.innerHTML.matchAll(/value="([^"]*)"/g)].map(m => ({ value: m[1] }));
          return el._initialOptions && vals.length === 0 ? [{ value: '' }] : vals;
        },
      });
    }
    els.set(id, el);
  }
  return els.get(id);
};

// ---------- 测试数据（在加载 client.js 前声明，供查询桩读取） ----------

const ENDED_STATE = {
  code: 'FAVE', phase: 'ended', hostId: 'p1', you: 'p1', spectating: false,
  ruleSet: { allowedRelations: ['scene', 'synonym'] },
  players: [
    { id: 'p1', name: '甲', color: '#e0533d', connected: true, tokensLeft: 3 },
    { id: 'p2', name: '乙', color: '#2e86de', connected: true, tokensLeft: 3 },
  ],
  spectators: [], startWords: ['火'], turn: null, pendingChallenge: null,
  winner: 'p1', scores: [],
  relationTypes: [
    { id: 'scene', name: '场景共现', example: '' },
    { id: 'synonym', name: '同义/近义', example: '' },
  ],
  nodes: [],
};
const FIRE = { id: 'start0', word: '火', ownerId: null, parentId: null,
  relation: null, reason: '起始词', reinforced: true };
const GOUHUO = { id: 'w1', word: '篝火', ownerId: 'p2', parentId: 'start0',
  relation: 'scene', reason: '篝火晚会上点起火', reinforced: false };
const KUAILE = { id: 'w2', word: '快乐', ownerId: 'p1', parentId: 'w1',
  relation: 'synonym', reason: '围炉夜话很快乐', reinforced: false };
const REPLAY_FRAMES = [
  { label: '开局', nodes: [FIRE], turn: null },
  { label: '接出「篝火」', nodes: [FIRE, GOUHUO], turn: null },
  { label: '接出「快乐」', nodes: [FIRE, GOUHUO, KUAILE], turn: null },
];
// 与 client.js 内部回放游标保持同步：最后一帧
let replayIdxGlobal = REPLAY_FRAMES.length - 1;

// ---------- 回放棋盘的动态节点 ----------

const replayNodes = new Map();
function replayNode(nodeId) {
  if (replayNodes.has(nodeId)) return replayNodes.get(nodeId);
  const nodeEl = makeEl();
  nodeEl.dataset.id = nodeId;
  const favBtn = makeEl();
  favBtn._cls.add('fav-btn');
  favBtn.click = () => favBtn.onclick({ stopPropagation() {}, target: favBtn });
  // client 通过 closest('.node') 取回所属节点
  favBtn.closest = () => nodeEl;
  nodeEl.querySelector = (sel) => sel === '.fav-btn' ? favBtn : null;
  nodeEl._favBtn = favBtn;
  replayNodes.set(nodeId, nodeEl);
  return nodeEl;
}

// ---------- 收藏列表动态项 ----------

const favItems = new Map();
function favItem(key) {
  if (favItems.has(key)) return favItems.get(key);
  const li = makeEl();
  li.dataset.key = key;
  const note = makeEl(); note.value = '';
  const saveBtn = makeEl(); const delBtn = makeEl();
  li.querySelector = (sel) => {
    if (sel === '.fav-note') return note;
    if (sel === '.fav-save-note') return saveBtn;
    if (sel === '.fav-del') return delBtn;
    return null;
  };
  li._note = note; li._save = saveBtn; li._del = delBtn;
  favItems.set(key, li);
  return li;
}
function visibleFavorites() {
  const all = JSON.parse(mem.wt_favorites || '[]');
  const kw = $id('fav-search').value.trim().toLowerCase();
  const rel = $id('fav-relation-filter').value;
  return all.filter(e =>
    (!rel || e.relation === rel) &&
    (!kw || e.front.toLowerCase().includes(kw) || e.back.toLowerCase().includes(kw)));
}

// ---------- 环境桩 ----------

global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => sel === '.screen'
    ? ['screen-home', 'screen-lobby', 'screen-game', 'screen-end',
      'screen-practice', 'screen-practice-game', 'screen-fav', 'screen-review'].map($id)
    : [],
  createElement: () => makeEl(),
};
const mem = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };
global.confirm = () => true;

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

// 回放棋盘：按当前帧与已收藏情况暴露 .node / .fav-btn
$id('replay-board').querySelectorAll = (sel) => {
  const frame = REPLAY_FRAMES[replayIdxGlobal];
  if (sel === '.node') return frame.nodes.map(n => replayNode(n.id));
  if (sel === '.fav-btn') {
    const saved = new Set(JSON.parse(mem.wt_favorites || '[]').map(f => f.key));
    return frame.nodes
      .filter(n => n.parentId && n.ownerId && !saved.has(WTFav.connectionKey(n, ENDED_STATE.code)))
      .map(n => replayNode(n.id)._favBtn);
  }
  return []; // .challengeable 等
};
// 收藏列表：按搜索/筛选暴露 .fav-item
$id('fav-list').querySelectorAll = (sel) =>
  sel === '.fav-item' ? visibleFavorites().map(e => favItem(e.key)) : [];

require('../public/client.js');

const recv = (msg) => clientWs.onmessage({ data: JSON.stringify(msg) });

test('回放收藏 → 收藏本搜索/筛选/笔记/删除 → 复习标记 全流程', () => {
  // 推送已结束局面与回放帧（client 收到 replay 会把游标置 0，再同步到最后一帧）
  recv({ type: 'state', state: ENDED_STATE });
  recv({ type: 'replay', frames: REPLAY_FRAMES });
  assert.strictEqual($id('dlg-replay').open, true, '收到回放应打开回放弹窗');

  // 用「下一步」走到最后一帧（同步 client 内部游标与本测试的查询桩）
  replayIdxGlobal = 1; $id('replay-next').onclick();
  replayIdxGlobal = 2; $id('replay-next').onclick();

  // 最后一帧有两条可收藏连接（篝火、快乐），起始词不可收藏
  assert.strictEqual($id('replay-board').querySelectorAll('.fav-btn').length, 2);

  // 收藏「火 —场景共现→ 篝火」
  replayNode('w1')._favBtn.click();
  let stored = JSON.parse(mem.wt_favorites || '[]');
  assert.strictEqual(stored.length, 1);
  assert.deepStrictEqual(
    { front: stored[0].front, back: stored[0].back, relation: stored[0].relation,
      reason: stored[0].reason, room: stored[0].roomCode },
    { front: '火', back: '篝火', relation: 'scene',
      reason: '篝火晚会上点起火', room: 'FAVE' });

  // 已收藏的节点渲染成"已收藏"，可点收藏按钮只剩「快乐」
  assert.strictEqual($id('replay-board').querySelectorAll('.fav-btn').length, 1);
  // 旧按钮已不在 DOM，但同键收藏由 WTFav.add 去重兜底：再点不应产生第二条
  replayNode('w1')._favBtn.click();
  assert.strictEqual(JSON.parse(mem.wt_favorites).length, 1);

  // 收藏第二条
  replayNode('w2')._favBtn.click();
  assert.strictEqual(JSON.parse(mem.wt_favorites).length, 2);

  // 打开收藏本：两条都在
  $id('btn-fav-home').onclick();
  assert.strictEqual($id('fav-list').querySelectorAll('.fav-item').length, 2);
  assert.ok($id('fav-stats').innerHTML.includes('共 2 条'));

  // 按词语搜索：只搜「快乐」
  $id('fav-search').value = '快乐';
  $id('fav-search').dispatch('input');
  assert.strictEqual($id('fav-list').querySelectorAll('.fav-item').length, 1);
  $id('fav-search').value = '';
  $id('fav-search').dispatch('input');

  // 按关系筛选：只看同义/近义
  $id('fav-relation-filter').value = 'synonym';
  $id('fav-relation-filter').onchange({ target: $id('fav-relation-filter') });
  let visible = $id('fav-list').querySelectorAll('.fav-item');
  assert.strictEqual(visible.length, 1);
  assert.strictEqual(visible[0].dataset.key, WTFav.connectionKey(KUAILE, 'FAVE'));
  $id('fav-relation-filter').value = '';
  $id('fav-relation-filter').onchange({ target: $id('fav-relation-filter') });

  // 给「篝火」补笔记并保存
  const gouKey = WTFav.connectionKey(GOUHUO, 'FAVE');
  const gouLi = favItem(gouKey);
  gouLi._note.value = '露营时常见';
  gouLi._save.onclick();
  assert.strictEqual(JSON.parse(mem.wt_favorites).find(e => e.key === gouKey).note, '露营时常见');

  // 删除「快乐」
  const kuaiKey = WTFav.connectionKey(KUAILE, 'FAVE');
  favItem(kuaiKey)._del.onclick();
  assert.strictEqual(JSON.parse(mem.wt_favorites).length, 1);
  assert.strictEqual(JSON.parse(mem.wt_favorites)[0].key, gouKey);

  // 开始复习：只剩一张（篝火）。先只显示前词与关系，后词/解释被遮住
  $id('btn-fav-review').onclick();
  assert.strictEqual($id('review-front-word').textContent, '火');
  assert.strictEqual($id('review-relation').textContent, '场景共现');
  assert.strictEqual($id('review-back').classList.contains('hidden'), true);
  assert.strictEqual($id('btn-reveal').classList.contains('hidden'), false);
  assert.strictEqual($id('btn-known').classList.contains('hidden'), true);

  // 揭示：后词、原解释、来源房间与笔记出现
  $id('btn-reveal').onclick();
  assert.strictEqual($id('review-back').classList.contains('hidden'), false);
  assert.strictEqual($id('review-back-word').textContent, '篝火');
  assert.strictEqual($id('review-reason').textContent, '篝火晚会上点起火');
  assert.ok($id('review-source').textContent.includes('FAVE'));
  assert.ok($id('review-note-box').innerHTML.includes('露营时常见'));
  assert.strictEqual($id('btn-known').classList.contains('hidden'), false);

  // 标记「还要复习」→ 本轮完成（只有一张），状态写回本地
  $id('btn-need-review').onclick();
  assert.strictEqual($id('review-finished').classList.contains('hidden'), false);
  const saved = JSON.parse(mem.wt_favorites)[0];
  assert.strictEqual(saved.status, 'needReview');
  assert.strictEqual(saved.reviewedCount, 1);
  assert.ok($id('review-summary').textContent.includes('还要复习'));

  // 再来一轮：needReview 的卡片优先（这里仍是它），揭示后标记「记住了」
  $id('btn-review-again').onclick();
  assert.strictEqual($id('review-front-word').textContent, '火');
  $id('btn-reveal').onclick();
  $id('btn-known').onclick();
  assert.strictEqual(JSON.parse(mem.wt_favorites)[0].status, 'known');
});

test('空收藏本点复习给出提示，且不进入复习屏', () => {
  delete mem.wt_favorites;
  $id('btn-fav-home').onclick();
  assert.strictEqual($id('fav-empty').classList.contains('hidden'), false);
  $id('btn-fav-review').onclick(); // 无条目：toast，不抛错、不切屏
  assert.strictEqual($id('screen-fav').classList.contains('hidden'), false, '停留在收藏本');
  assert.strictEqual($id('screen-review').classList.contains('hidden'), true, '不进入复习屏');
});
