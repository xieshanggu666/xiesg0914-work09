'use strict';
// 我的词包界面接线回归：用 DOM/WebSocket 桩加载真实 client.js，
// 模拟「新建词包（含校验失败）→ 列表展示 → 编辑 → 大厅选用 → 删除」的完整点击流。
const test = require('node:test');
const assert = require('node:assert');

// ---------- DOM / 环境桩 ----------

function makeEl(id) {
  const el = {
    id: id || '', children: [], _cls: new Set(),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, onclick: null, open: false,
    _listeners: {},
    addEventListener(ev, fn) { (el._listeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { (el._listeners[ev] || []).forEach(fn => fn(arg || { target: el })); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    focus() {},
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
// 词包列表的操作按钮：桩不解析 DOM，从 innerHTML 中按 data-pack-edit/del 提取 id 并缓存按钮，
// 让 client 绑定的 onclick 与测试点击的是同一个对象
const packBtns = new Map();
function packListQuery(sel) {
  const m = sel.match(/^\[data-pack-(edit|del)\]$/);
  if (!m) return [];
  const attr = m[1];
  const ids = [...$('pack-list').innerHTML.matchAll(new RegExp(`data-pack-${attr}="([^"]+)"`, 'g'))]
    .map(x => x[1]);
  return ids.map(pid => {
    const key = `${attr}:${pid}`;
    if (!packBtns.has(key)) {
      const btn = makeEl();
      btn.dataset[attr === 'edit' ? 'packEdit' : 'packDel'] = pid;
      packBtns.set(key, btn);
    }
    return packBtns.get(key);
  });
}

const $id = (id) => {
  if (!els.has(id)) {
    const el = makeEl(id);
    if (id === 'pack-list') el.querySelectorAll = packListQuery;
    els.set(id, el);
  }
  return els.get(id);
};
const $ = $id;

global.document = {
  getElementById: $id,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
};
const storage = {};
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };
global.confirm = () => true;

const sockets = [];
const sentMsgs = [];
global.WebSocket = class {
  constructor() { this.readyState = 0; sockets.push(this); }
  send(s) { if (this.readyState === 1) sentMsgs.push(JSON.parse(s)); }
  close() {}
};

global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.WTPractice = require('../public/practice.js');
global.WTFav = require('../public/favorites.js');
global.WTPacks = require('../public/packs.js');

require('../public/client.js');

const ws = sockets.at(-1);
ws.readyState = 1;
ws.onopen();

const LOBBY = {
  code: 'PKUI', phase: 'lobby', hostId: 'me', you: 'me', spectating: false,
  ruleSet: { allowedRelations: ['synonym'], allowProperNouns: false, minReasonLen: 4,
    turnSeconds: 90, apPerTurn: 3, rounds: 4, startWordCount: 3, challengeTokens: 3 },
  players: [{ id: 'me', name: '甲', color: '#e0533d', connected: true, tokensLeft: 3 }],
  spectators: [], wordPack: null, startWords: [], nodes: [], turn: null,
  pendingChallenge: null, winner: null,
  relationTypes: [{ id: 'synonym', name: '同义/近义', example: '快乐 → 开心' }],
};
const recvState = (patch = {}) =>
  ws.onmessage({ data: JSON.stringify({ type: 'state', state: { ...LOBBY, ...patch } }) });

const storedPacks = () => JSON.parse(storage.wt_packs || '[]');

test('词包管理：校验失败就地标错，成功后入列表并可编辑、删除', () => {
  $('btn-packs-home').onclick();
  assert.ok(!$('screen-packs')._cls.has('hidden'), '进入词包页');
  assert.ok(!$('pack-empty')._cls.has('hidden'), '空列表提示可见');

  // 新建：候选词不足 → 就地报错，不保存
  $('btn-pack-new').onclick();
  assert.ok(!$('pack-editor')._cls.has('hidden'));
  $('pack-name').value = '海洋奇缘';
  $('pack-theme').value = '一切都与大海有关';
  $('pack-words').value = '海浪\n贝壳';
  $('btn-pack-save').onclick();
  assert.match($('err-pack-words').textContent, /至少需要 3/);
  assert.strictEqual(storedPacks().length, 0, '校验失败不写入');
  assert.ok(!$('pack-editor')._cls.has('hidden'), '编辑器保持打开');

  // 修正后保存：写入本机、编辑器关闭、列表展示
  $('pack-words').value = '海浪\n贝壳\n灯塔\n海鸥';
  $('btn-pack-save').onclick();
  assert.strictEqual($('err-pack-words').textContent, '');
  const packs = storedPacks();
  assert.strictEqual(packs.length, 1);
  assert.deepStrictEqual(packs[0].words, ['海浪', '贝壳', '灯塔', '海鸥']);
  assert.strictEqual(packs[0].name, '海洋奇缘');
  assert.ok($('pack-editor')._cls.has('hidden'), '保存成功后编辑器关闭');
  assert.ok($('pack-list').innerHTML.includes('海洋奇缘'));
  assert.ok($('pack-empty')._cls.has('hidden'));

  // 编辑：回填并保存修改
  const pid = packs[0].id;
  const editBtn = $('pack-list').querySelectorAll('[data-pack-edit]')[0];
  assert.strictEqual(editBtn.dataset.packEdit, pid);
  editBtn.onclick();
  assert.strictEqual($('pack-name').value, '海洋奇缘');
  assert.strictEqual($('pack-words').value, '海浪\n贝壳\n灯塔\n海鸥');
  $('pack-theme').value = '改成新主题';
  $('btn-pack-save').onclick();
  assert.strictEqual(storedPacks()[0].theme, '改成新主题');
  assert.strictEqual(storedPacks().length, 1, '编辑不产生新词包');

  // 删除
  $('pack-list').querySelectorAll('[data-pack-del]')[0].onclick();
  assert.strictEqual(storedPacks().length, 0);
});

test('大厅：房主下拉选用词包发给服务器，词包信息全员可见', () => {
  // 先在本机建一个词包
  $('btn-packs-home').onclick();
  $('btn-pack-new').onclick();
  $('pack-name').value = '海洋奇缘';
  $('pack-theme').value = '一切都与大海有关';
  $('pack-words').value = '海浪\n贝壳\n灯塔\n海鸥';
  $('btn-pack-save').onclick();
  const pack = storedPacks()[0];

  // 进入大厅（自己是房主）：下拉包含默认词池与本机词包，未选用时展示默认提示
  recvState();
  assert.ok($('pack-select').innerHTML.includes('默认词池'));
  assert.ok($('pack-select').innerHTML.includes(`value="${pack.id}"`));
  assert.ok($('pack-info').innerHTML.includes('未选用主题词包'));
  assert.ok(!$('pack-host-row')._cls.has('hidden'), '房主可见选择行');

  // 选用词包 → 词包内容作为快照发给服务器
  $('pack-select').value = pack.id;
  $('pack-select').onchange();
  const setMsg = sentMsgs.find(m => m.type === 'setWordPack');
  assert.ok(setMsg, '应发送 setWordPack');
  assert.strictEqual(setMsg.pack.name, '海洋奇缘');
  assert.deepStrictEqual(setMsg.pack.words, ['海浪', '贝壳', '灯塔', '海鸥']);

  // 服务器广播词包快照：所有人看到主题与候选词，下拉同步到当前选中
  recvState({ wordPack: { id: pack.id, name: pack.name, theme: pack.theme, words: pack.words } });
  assert.ok($('pack-info').innerHTML.includes('一切都与大海有关'));
  assert.ok($('pack-info').innerHTML.includes('海浪'));
  assert.ok($('pack-info').innerHTML.includes('不重复抽取'));
  assert.strictEqual($('pack-select').value, pack.id);

  // 改回默认词池
  $('pack-select').value = '';
  $('pack-select').onchange();
  const clears = sentMsgs.filter(m => m.type === 'setWordPack');
  assert.strictEqual(clears.at(-1).pack, null);

  // 非房主视角：看不到选择行，仍能看到词包信息
  recvState({ you: 'other', wordPack: { id: pack.id, name: pack.name, theme: pack.theme, words: pack.words } });
  assert.ok($('pack-host-row')._cls.has('hidden'), '非房主不显示选择行');
  assert.ok($('pack-info').innerHTML.includes('海洋奇缘'));
});
