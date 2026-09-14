'use strict';
// 规则保存提交锁定与断线重连体验的回归测试：用 DOM/WebSocket 桩加载真实 client.js，
// 验证"锁定只能由服务器答复或断线解除"，以及断线/重连/恢复/失败各阶段的横幅与操作锁定。
const test = require('node:test');
const assert = require('node:assert');

// ---------- DOM / 环境桩 ----------

function makeEl(id) {
  const el = {
    id, children: [], _cls: new Set(id === 'rules-editor' ? ['hidden'] : []),
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {}, _onclick: null,
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      toggle: (c, force) => { (force ?? !el._cls.has(c)) ? el._cls.add(c) : el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    },
    set onclick(fn) { el._onclick = fn; },
    get onclick() { return el._onclick; },
    addEventListener() {}, showModal() {}, close() {},
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    querySelectorAll: (sel) => {
      if (sel === '[data-conn]') return (el._connBtns || []);
      return [];
    },
    focus() {},
    get offsetWidth() { return 0; },
  };
  return el;
}

const els = new Map();
const $id = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const checkedRelations = [{ dataset: { rel: 'synonym' } }];

// 横幅按钮：桩不解析 innerHTML，手动给每个横幅容器挂三类按钮
function connBtn(containerId, action) {
  return Object.assign(makeEl(`${containerId}-${action}`), { dataset: { conn: action } });
}
for (const cid of ['conn-banner-lobby', 'conn-banner-game', 'conn-banner-end']) {
  const c = makeEl(cid);
  c._connBtns = [connBtn(cid, 'home'), connBtn(cid, 'reenter'), connBtn(cid, 'cancel')];
  els.set(cid, c);
}

global.document = {
  getElementById: $id,
  querySelectorAll: (sel) => {
    if (sel === '[data-rel]:checked') return checkedRelations;
    if (sel === '.conn-banner [data-conn]') {
      return ['conn-banner-lobby', 'conn-banner-game', 'conn-banner-end']
        .flatMap(cid => $id(cid)._connBtns);
    }
    return []; // .screen / [data-close] / #rules-editor … 等
  },
  createElement: () => makeEl('div'),
};
const storage = {};
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
};
global.location = { protocol: 'http:', host: 'test', reload() {} };

// 可手动控制打开/关闭与消息的 WebSocket 桩
const sockets = [];
const sentMsgs = [];
let wsCtorSeq = 0;
global.WebSocket = class {
  constructor(url) {
    this.url = url; this.readyState = 0; this.seq = ++wsCtorSeq;
    sockets.push(this);
  }
  send(s) {
    if (this.readyState === 1) sentMsgs.push(JSON.parse(s));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
};

global.WTTips = require('../public/tips.js');
global.WTRules = require('../public/rules.js');
global.__WT_TEST = true;
require('../public/client.js'); // IIFE，加载即完成事件绑定并 connect()
const WT = globalThis.__WTClient;

const latestWs = () => sockets.at(-1);
const recv = (ws, msg) => ws.onmessage({ data: JSON.stringify(msg) });
const openWs = (ws) => { ws.readyState = 1; ws.onopen(); };
const setRulesSent = () => sentMsgs.filter(m => m.type === 'setRules');

const LOBBY = {
  code: 'TEST', phase: 'lobby', hostId: 'me', you: 'me',
  ruleSet: { allowedRelations: ['synonym'], allowProperNouns: false, minReasonLen: 4,
    turnSeconds: 90, apPerTurn: 3, rounds: 4, startWordCount: 3, challengeTokens: 3 },
  players: [{ id: 'me', name: '甲', color: '#000', connected: true, tokensLeft: 3 }],
  spectators: [], startWords: [], nodes: [], turn: null, pendingChallenge: null,
  winner: null, scores: null,
  relationTypes: [{ id: 'synonym', name: '同义/近义', example: '快乐 → 开心' }],
};

// 假定时器工具：捕获 setTimeout 以便 advance 快进；restore 时把残留定时器用真实
// 定时器重新挂上，否则恢复全局 setTimeout 后这些回调永远不会执行（例如断线重连退避
// 被留在假队列里，客户端会永远停在"等待重连"，并让测试进程无法正常退出）。
function fakeTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { const t = { fn, ms, id: timers.length + 1 }; timers.push(t); return t.id; };
  global.clearTimeout = (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const advance = (ms) => {
    const due = timers.filter(t => t.ms <= ms);
    for (const t of due) timers.splice(timers.indexOf(t), 1);
    for (const t of due) t.fn();
  };
  const restore = () => {
    // 先恢复全局再重挂，顺序不能反——否则新定时器又会被假 setTimeout 捕获
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    for (const t of timers.splice(0)) realSetTimeout(t.fn, t.ms);
  };
  return { advance, restore };
}

// 假 setInterval：仅记录不执行；restore 时恢复全局。测试结束必须 restore，
// 否则客户端 updateTimer 用假 setInterval 挂出的 interval 会让进程无法退出。
function fakeIntervals() {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const intervals = [];
  let seq = 0;
  global.setInterval = (fn, ms) => { const id = ++seq; intervals.push({ id }); return id; };
  global.clearInterval = (id) => { const i = intervals.findIndex(x => x.id === id); if (i >= 0) intervals.splice(i, 1); };
  const restore = () => {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  };
  return { list: intervals, restore };
}

test('保存锁定只能由服务器答复或断线解除，超时不得误解除', () => {
  // 假定时器：记录而非执行，用于模拟"时间流逝但服务器未答复"
  const ft = fakeTimers();
  const advance = ft.advance;

  try {
    const ws = latestWs();
    openWs(ws);
    recv(ws, { type: 'joined', token: 'tok', roomCode: 'TEST', playerId: 'me' });
    recv(ws, { type: 'state', state: LOBBY });

    // 打开编辑器并保存：请求发出，按钮锁定
    $id('btn-edit-rules').onclick();
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), false);
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 1, '保存应发送一次请求');
    assert.strictEqual($id('btn-save-rules').disabled, true, '保存后按钮应锁定');

    // 关键回归：时间流逝（超过旧的 3 秒兜底）但服务器未答复 → 锁定必须保持
    advance(5000);
    assert.strictEqual($id('btn-save-rules').disabled, true, '未获答复时超时不得解除锁定');
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 1, '锁定期间重复点击不得发送重复请求');

    // 服务器确认 → 解除锁定并关闭编辑器
    recv(ws, { type: 'rulesSaved' });
    assert.strictEqual($id('btn-save-rules').disabled, false, 'rulesSaved 应解除锁定');
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), true);

    // 再次保存 → 服务器拒绝 → 解除锁定、编辑器保持打开、错误就地显示
    $id('btn-edit-rules').onclick();
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 2);
    assert.strictEqual($id('btn-save-rules').disabled, true);
    recv(ws, { type: 'error', message: '只有房主可以修改规则', context: 'setRules' });
    assert.strictEqual($id('btn-save-rules').disabled, false, '服务器拒绝应解除锁定');
    assert.strictEqual($id('rules-editor').classList.contains('hidden'), false, '失败后编辑器保持打开');
    assert.strictEqual($id('err-rules-general').textContent, '只有房主可以修改规则');

    // 再次保存 → 连接断开 → 在途保存锁解除；但断线重连锁定生效，按钮仍禁用
    $id('btn-save-rules').onclick();
    assert.strictEqual(setRulesSent().length, 3);
    assert.strictEqual($id('btn-save-rules').disabled, true);
    ws.close();
    assert.strictEqual($id('conn-banner-lobby').classList.contains('hidden'), false,
      '断线后大厅应显示重连横幅');
    assert.match($id('conn-banner-lobby').innerHTML, /正在自动重连/);
    assert.strictEqual($id('btn-save-rules').disabled, true, '断线重连期间保存按钮应锁定');
    assert.strictEqual($id('btn-start').disabled, true, '断线重连期间开始游戏应锁定');

    // 断线期间写操作不再发往旧连接（防止重复提交），只提示
    const playsBefore = sentMsgs.filter(m => m.type === 'play').length;
    $id('btn-start').onclick();
    assert.strictEqual(sentMsgs.filter(m => m.type === 'startGame').length, 0,
      '断线期间开始游戏不得发送');
    assert.strictEqual(playsBefore, sentMsgs.filter(m => m.type === 'play').length);

    // 1.5s 退避后自动发起新连接
    advance(2000);
    const ws2 = latestWs();
    assert.notStrictEqual(ws2, ws);
    openWs(ws2);
    assert.match($id('conn-banner-lobby').innerHTML, /正在恢复房间/);
    assert.ok(sentMsgs.some(m => m.type === 'reconnect' && m.token === 'tok'),
      '重连应携带本地 token');
    recv(ws2, { type: 'joined', token: 'tok', roomCode: 'TEST', playerId: 'me' });
    assert.ok(sentMsgs.some(m => m.type === 'syncState'), '恢复身份后应显式同步房间状态');
    recv(ws2, { type: 'state', state: LOBBY });
    assert.match($id('conn-banner-lobby').innerHTML, /已恢复连接/);
    assert.strictEqual($id('btn-start').disabled, false, '恢复后操作解锁');
  } finally {
    ft.restore();
  }
});

test('多标签页：历史响应只清理本次查询过的失效 token，不误删新记录', () => {
  // 换成真正可用的 localStorage（另一标签页的写入体现为同一存储）
  const mem = {};
  global.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
  const readHistory = () => JSON.parse(mem.wt_history || '[]');
  mem.wt_history = JSON.stringify([
    { token: 'tokA', roomCode: 'AAAA' },
    { token: 'tokB', roomCode: 'BBBB' },
  ]);

  // 复现"刷新页面后重连"：模拟一次新连接打开（此时是上一个测试恢复后的在线 socket）
  const ws = latestWs();
  const historyReqs = () => sentMsgs.filter(m => m.type === 'history');
  const before = historyReqs().length;
  // 直接驱动一次 onopen（等价于刷新后的连接建立）
  ws.onopen();
  assert.strictEqual(historyReqs().length, before + 1);
  assert.deepStrictEqual(historyReqs().at(-1).tokens, ['tokA', 'tokB']);

  // 查询在途期间，另一个标签页开了新房并写入 tokC
  mem.wt_history = JSON.stringify([...readHistory(), { token: 'tokC', roomCode: 'CCCC' }]);

  const entry = (token, code) => ({ token, code, phase: 'ended', createdAt: 1, endedAt: 2,
    youId: 'me', youName: '甲', players: ['甲', '乙'], winner: 'me', winnerName: '甲',
    yourRank: 1, yourTotal: 8 });
  // 服务器响应只覆盖 tokA/tokB（tokC 不在本次查询里）
  recv(ws, { type: 'history', entries: [entry('tokA', 'AAAA'), entry('tokB', 'BBBB')] });

  // 关键回归：tokC 未被本次查询覆盖，不得被误删
  assert.ok(readHistory().some(e => e.token === 'tokC'), '其他标签页新增的记录不得被清理');
  // 发现未覆盖的新记录后应补发一次查询，把它也带进列表
  assert.strictEqual(historyReqs().length, before + 2, '发现新记录应补发查询');
  assert.ok(historyReqs().at(-1).tokens.includes('tokC'));

  // 第二次响应：tokC 有效；tokB 已被服务器删除 → 只清 tokB
  recv(ws, { type: 'history', entries: [entry('tokA', 'AAAA'), entry('tokC', 'CCCC')] });
  const tokens = readHistory().map(e => e.token);
  assert.ok(tokens.includes('tokA') && tokens.includes('tokC'), '有效记录保留');
  assert.ok(!tokens.includes('tokB'), '查询过且服务器不认得的记录才被清理');
});

// ---------- 断线重连体验（对局页 / 失败入口 / 首页） ----------

const GAME_STATE = {
  code: 'PLAY', phase: 'playing', hostId: 'me', you: 'me', spectating: false,
  ruleSet: { allowedRelations: ['synonym'], allowProperNouns: false, minReasonLen: 4,
    turnSeconds: 90, apPerTurn: 3, rounds: 4, startWordCount: 3, challengeTokens: 3 },
  players: [
    { id: 'me', name: '甲', color: '#e0533d', connected: true, tokensLeft: 3 },
    { id: 'p2', name: '乙', color: '#2e86de', connected: true, tokensLeft: 3 },
  ],
  spectators: [], startWords: ['火'],
  nodes: [{ id: 'start0', word: '火', ownerId: null, parentId: null,
    relation: null, reason: '起始词', reinforced: true }],
  turn: { playerId: 'me', turnNumber: 1, apLeft: 3,
    deadline: Date.now() + 90000, pausedRemaining: null },
  pendingChallenge: null, winner: null, scores: null,
  relationTypes: [{ id: 'synonym', name: '同义/近义', example: '快乐 → 开心' }],
};

test('对局中断线：行动按钮锁定且写操作不发出，恢复后重新渲染最新状态', () => {
  const fi = fakeIntervals();
  const intervals = fi.list;
  const ft = fakeTimers();
  const { advance } = ft;
  try {
    // 先回到对局中的在线状态
    const ws = latestWs();
    if (ws.readyState !== 1) openWs(ws);
    recv(ws, { type: 'joined', token: 'gTok', roomCode: 'PLAY', playerId: 'me' });
    recv(ws, { type: 'state', state: GAME_STATE });
    // 轮到自己：结束回合/加固可用（接词需先选词，另由业务规则控制）
    assert.strictEqual($id('btn-endturn').disabled, false, '在线且轮到自己：结束回合可用');
    assert.strictEqual($id('btn-reinforce').disabled, false, '在线且轮到自己：加固可用');

    // 断线：三个行动按钮全部锁定，对局页横幅出现，计时器停止空跑
    ws.close();
    assert.match($id('conn-banner-game').innerHTML, /正在自动重连/);
    assert.strictEqual($id('btn-play').disabled, true, '断线期间接词锁定');
    assert.strictEqual($id('btn-reinforce').disabled, true, '断线期间加固锁定');
    assert.strictEqual($id('btn-endturn').disabled, true, '断线期间结束回合锁定');
    assert.strictEqual(intervals.length, 0, '断线后计时 interval 应被清理');

    // 即使绕过按钮直接触发提交，消息也不得发往旧连接
    const endTurnCount = sentMsgs.filter(m => m.type === 'endTurn').length;
    $id('btn-endturn').onclick();
    assert.strictEqual(sentMsgs.filter(m => m.type === 'endTurn').length, endTurnCount,
      '断线期间结束回合不得发送');

    // 退避到期：自动新建连接并进入"恢复中"，此时按钮仍锁定
    advance(2000);
    const ws2 = latestWs();
    assert.notStrictEqual(ws2, ws, '应已自动新建连接');
    openWs(ws2);
    assert.match($id('conn-banner-game').innerHTML, /正在恢复房间/);
    assert.ok(sentMsgs.some(m => m.type === 'reconnect' && m.token === 'gTok'));
    assert.strictEqual($id('btn-play').disabled, true, '恢复同步完成前按钮保持锁定');
    assert.strictEqual($id('btn-endturn').disabled, true, '恢复同步完成前结束回合锁定');

    // 断线期间局面有变化（行动点只剩 1）：joined 后显式同步，state 回来即恢复完成
    recv(ws2, { type: 'joined', token: 'gTok', roomCode: 'PLAY', playerId: 'me' });
    assert.ok(sentMsgs.some(m => m.type === 'syncState'), '应显式拉取最新房间状态');
    const fresh = JSON.parse(JSON.stringify(GAME_STATE));
    fresh.turn.apLeft = 1;
    recv(ws2, { type: 'state', state: fresh });
    assert.match($id('conn-banner-game').innerHTML, /已恢复连接/);
    assert.strictEqual(WT.connStatus, 'recovered');
    assert.strictEqual($id('btn-endturn').disabled, false, '恢复后结束回合解锁');
    assert.strictEqual($id('btn-reinforce').disabled, false, '恢复后加固解锁');

    // 恢复横幅 2.5s 后自动收起
    advance(3000);
    assert.strictEqual($id('conn-banner-game').classList.contains('hidden'), true,
      '恢复横幅展示后自动收起');
  } finally {
    fi.restore();
    ft.restore();
  }
});

test('恢复失败（会话失效）：停止自动重连，提供返回首页与重新输入房间码入口', () => {
  const fi = fakeIntervals();
  const ft = fakeTimers();
  const { advance } = ft;
  // 处于对局中 → 断线 → 自动重连
  const ws = latestWs();
  if (ws.readyState !== 1) openWs(ws);
  recv(ws, { type: 'state', state: GAME_STATE });
  ws.close();
  advance(2000);
  const ws2 = latestWs();
  openWs(ws2);

  // 服务器明确拒绝恢复
  recv(ws2, { type: 'error', context: 'reconnect', message: '会话已失效，请重新加入' });
  assert.strictEqual(WT.connStatus, 'failed');
  assert.strictEqual(WT.stopRetry, true, '失败后停止自动重连');
  assert.match($id('conn-banner-game').innerHTML, /恢复失败：会话已失效/);
  assert.match($id('conn-banner-game').innerHTML, /重新输入房间码/);
  assert.match($id('conn-banner-game').innerHTML, /返回首页/);
  assert.strictEqual($id('btn-play').disabled, true, '失败后行动仍锁定');
  assert.strictEqual(global.localStorage.getItem('wt_token'), null, '失效 token 应清除');

  // 退避定时器即使残留也不得再自动重连（用户必须主动选择去向）
  const socketCount = sockets.length;
  advance(5000);
  assert.strictEqual(sockets.length, socketCount, '失败后不得自动新建连接');

  // 失败后底层 socket 再断开：失败横幅必须保留，不得退回"重连中"或安排重试
  ws2.close();
  assert.strictEqual(WT.connStatus, 'failed', 'socket 再断开不得覆盖失败状态');
  assert.match($id('conn-banner-game').innerHTML, /恢复失败：会话已失效/);
  const socketsBeforeWait = sockets.length;
  advance(5000);
  assert.strictEqual(sockets.length, socketsBeforeWait, '失败后 socket 断开也不得自动重连');

  // 点"重新输入房间码"：回首页且预填原房间码（会主动新建一个干净连接）
  const reenterBtn = $id('conn-banner-game')._connBtns.find(b => b.dataset.conn === 'reenter');
  reenterBtn.onclick();
  assert.strictEqual($id('inp-code').value, 'PLAY', '应预填原房间码');
  assert.strictEqual(WT.state, null, '已离开房间上下文');
  openWs(latestWs()); // 让新连接就绪，停在在线首页

  // 失败横幅的"返回首页"：清空房间码，并作废旧连接后新建干净连接
  const nSockets = sockets.length;
  const homeBtn = $id('conn-banner-lobby')._connBtns.find(b => b.dataset.conn === 'home');
  homeBtn.onclick();
  assert.strictEqual($id('inp-code').value, '', '返回首页应清空房间码');
  assert.strictEqual(sockets.length, nSockets + 1, '返回首页应新建干净连接');
  openWs(latestWs());

  // 排空假时钟内的全部定时器（toast/横幅收起），再恢复真实定时器
  advance(60000);
  fi.restore();
  ft.restore();
});

test('重连中暂不等候回首页：保留 token，迟到状态不再拉回房间', () => {
  const fi = fakeIntervals();
  const ft = fakeTimers();
  const { advance } = ft;
  try {
    // 进入对局并断线
    const ws = latestWs();
    if (ws.readyState !== 1) openWs(ws);
    storage.wt_token = 'keepTok';
    recv(ws, { type: 'joined', token: 'keepTok', roomCode: 'PLAY', playerId: 'me' });
    recv(ws, { type: 'state', state: GAME_STATE });
    ws.close();
    assert.strictEqual(WT.connStatus, 'reconnecting');
    const connectingSocket = latestWs(); // 退避后自动创建、尚未打开的新连接

    // 点"暂不等候，回首页"
    const cancelBtn = $id('conn-banner-game')._connBtns.find(b => b.dataset.conn === 'cancel');
    cancelBtn.onclick();
    assert.strictEqual(WT.state, null, '已离开房间上下文');
    assert.strictEqual(storage.wt_token, 'keepTok', '有效 token 保留，可从历史重返');
    const freshSocket = latestWs();
    assert.notStrictEqual(freshSocket, connectingSocket, '应已作废在途连接并新建');
    const reconnectsBefore = sentMsgs.filter(m => m.type === 'reconnect').length;
    openWs(freshSocket);
    assert.strictEqual(sentMsgs.filter(m => m.type === 'reconnect').length, reconnectsBefore,
      '新连接不应主动重连已放弃的房间');

    // 在途旧连接迟到的 joined/state 不得再影响当前会话
    recv(connectingSocket, { type: 'joined', token: 'keepTok', roomCode: 'PLAY', playerId: 'me' });
    recv(connectingSocket, { type: 'state', state: GAME_STATE });
    assert.strictEqual(WT.state, null, '旧连接的迟到状态不得把用户拉回房间');
    assert.ok(sentMsgs.some(m => m.type === 'history'), '新连接照常请求历史');

    // 断线重连横幅应已消失
    assert.strictEqual($id('conn-banner-game').classList.contains('hidden'), true);
  } finally {
    advance(60000);
    fi.restore();
    ft.restore();
  }
});

test('首页在未连接时禁用创建/加入/观战，连上后自动可用', () => {
  // 初始加载时（无连接）三个入口禁用
  // （构造一个尚未打开的新连接来观察）
  const before = {
    create: $id('btn-create').disabled, join: $id('btn-join').disabled,
    spectate: $id('btn-spectate').disabled,
  };
  // 上个测试结束时已主动 connect 回首页：新 socket 尚未 open，入口应禁用
  const ws = latestWs();
  if (ws.readyState !== 1) {
    assert.strictEqual($id('btn-create').disabled, true, '未连接时创建房间禁用');
    assert.strictEqual($id('btn-join').disabled, true, '未连接时加入禁用');
    assert.strictEqual($id('btn-spectate').disabled, true, '未连接时观战禁用');
    openWs(ws);
    assert.strictEqual($id('btn-create').disabled, false, '连上后创建房间可用');
    assert.strictEqual($id('btn-join').disabled, false);
    assert.strictEqual($id('btn-spectate').disabled, false);
  } else {
    assert.strictEqual(before.create, false);
  }
});
