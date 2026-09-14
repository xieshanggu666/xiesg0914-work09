'use strict';
/* 词语领地客户端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get token() { return localStorage.getItem('wt_token'); },
    set token(v) { v ? localStorage.setItem('wt_token', v) : localStorage.removeItem('wt_token'); },
    get name() { return localStorage.getItem('wt_name') || ''; },
    set name(v) { localStorage.setItem('wt_name', v); },
    // 赛季身份密钥：本浏览器随机生成的 32 字节十六进制（64 位），只存在本机、永不上榜。
    // 公开的玩家标识 pid 由服务端从它派生（pid = sha256(pidSecret)）。建房/加入时提交密钥，
    // 别人即使在排行榜上看到你的 pid，也反推不出密钥、无法冒用你的身份污染战绩。
    get pidSecret() {
      let v = localStorage.getItem('wt_pid_secret');
      if (!v || !/^[a-f0-9]{64}$/.test(v)) {
        const bytes = new Uint8Array(32);
        (globalThis.crypto || {}).getRandomValues
          ? globalThis.crypto.getRandomValues(bytes)
          : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
        v = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('wt_pid_secret', v);
      }
      return v;
    },
    get seenTips() { return JSON.parse(localStorage.getItem('wt_tips') || '[]'); },
    addSeenTip(k) {
      const a = store.seenTips; if (!a.includes(k)) { a.push(k); localStorage.setItem('wt_tips', JSON.stringify(a)); }
    },
    // 历史与战绩：本机参与过的房间 token（用于换取战绩摘要与重返房间），上限 30 条
    get history() { return JSON.parse(localStorage.getItem('wt_history') || '[]'); },
    set history(v) { localStorage.setItem('wt_history', JSON.stringify(v)); },
    addHistory(token, roomCode) {
      const a = store.history.filter(e => e.roomCode !== roomCode);
      a.unshift({ token, roomCode });
      store.history = a.slice(0, 30);
    },
    // 战术练习通关进度（纯本地）：{ [scenarioId]: { at: 时间戳 } }
    get practice() { return JSON.parse(localStorage.getItem('wt_practice') || '{}'); },
    set practice(v) { localStorage.setItem('wt_practice', JSON.stringify(v)); },
    markPracticeDone(id) {
      const v = store.practice;
      v[id] = { at: Date.now() };
      store.practice = v;
    },
    // 个人收藏本（纯本地，不经过服务器）：收藏条目数组，见 favorites.js
    get favorites() { return JSON.parse(localStorage.getItem('wt_favorites') || '[]'); },
    set favorites(v) { localStorage.setItem('wt_favorites', JSON.stringify(v)); },
    // 我的词包（纯本地）：{id,name,theme,words[],updatedAt}[]，见 packs.js。
    // 房主在大厅选用后词包内容才作为快照发给服务器，本机列表始终只存在这里。
    get packs() { return JSON.parse(localStorage.getItem('wt_packs') || '[]'); },
    set packs(v) { localStorage.setItem('wt_packs', JSON.stringify(v)); },
  };

  let ws = null, state = null, prevState = null;
  let selectedParent = null;   // 接词时选中的父节点
  let reinforceMode = false;
  let challengeNodeId = null;
  let replayFrames = null, replayIdx = 0;
  let timerInterval = null;
  // 收藏本：当前筛选条件与复习会话
  let favKeyword = '', favRelation = '';
  let reviewSession = null;

  // ---------- 连接状态 ----------
  // offline：尚未连上（首页）；online：已连接；
  // reconnecting：连接中断、退避重连中；recovering：socket 已通、等待房间状态同步；
  // recovered：同步完成（横幅短暂展示后隐去）；failed：token 恢复被服务器拒绝。
  let connStatus = 'offline';
  let reconnectAttempts = 0;
  let reconnectTimer = null;   // 断线重连退避定时器（null 表示当前没有待执行的重连）
  let recoverHideTimer = null;
  let currentSeq = 0;          // 当前连接代号：旧 socket 的延迟关闭事件不得影响新连接
  // expectRecovery：本次断线发生在房间内，重连后要走"恢复 + 同步 + 提示"流程
  // （首次进页面/刷新后的首次连接不算，不能在正常进房时闪一条"已恢复"）
  let expectRecovery = false;
  let awaitingSync = false;
  let stopRetry = false;        // 恢复被明确拒绝后停止自动重连
  let suppressAutoReconnect = false; // 用户主动回首页：下一次连接不再凭 token 自动恢复
  let connFailMessage = '';     // 恢复失败原因，断线重渲染横幅时沿用
  let rulesSavePending = false;

  // 会产生写操作/重复提交的消息：socket 不可用时一律不发并提示，
  // 作为按钮禁用之外的兜底，防止断线期间从弹窗提交陈旧操作。
  const WRITE_TYPES = new Set([
    'createRoom', 'joinRoom', 'spectate', 'setRules', 'setWordPack', 'startGame',
    'play', 'reinforce', 'endTurn', 'challenge', 'resolve',
  ]);

  function connect() {
    const seq = ++currentSeq;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}`);
    ws = sock;
    let closed = false;
    sock.onopen = () => {
      if (seq !== currentSeq) return; // 已被更新的连接取代
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (store.token && expectRecovery) {
        // 连接已通，但断线期间可能错过广播：先恢复身份，再显式同步一次房间状态
        awaitingSync = true;
        setConnStatus('recovering');
        send({ type: 'reconnect', token: store.token });
      } else {
        awaitingSync = false;
        setConnStatus('online');
        // 有 token 且是刷新后的首次连接：自动恢复身份；
        // 用户主动"暂不等候回首页"（suppressAutoReconnect）时只保留 token 供历史重返，不自动进房
        if (store.token && !suppressAutoReconnect) send({ type: 'reconnect', token: store.token });
        suppressAutoReconnect = false;
      }
      requestHistory();
    };
    sock.onmessage = (e) => { if (seq === currentSeq) handle(JSON.parse(e.data)); };
    sock.onerror = () => { try { sock.close(); } catch { /* 关闭流程统一由 onclose 处理 */ } };
    sock.onclose = () => {
      if (closed) return; // onerror 手动 close 与浏览器原生 close 事件可能都到达，只处理一次
      closed = true;
      if (seq !== currentSeq) return; // 旧 socket 的延迟关闭，忽略
      ws = null;
      awaitingSync = false;
      rulesSavePending = false;
      // 恢复已被服务器明确拒绝：保持失败横幅与去向入口，不再自动重连
      if (stopRetry) { renderConnBanners(connFailMessage); return; }
      // 先切换连接状态（横幅/操作锁定据此渲染），再解除在途保存请求的提交锁
      if (state) {
        // 处于大厅/对局/结算：展示重连进度并锁定操作，1.5s 后自动重连
        expectRecovery = true;
        reconnectAttempts += 1;
        setConnStatus('reconnecting');
        render(); // 状态变化不会自动推送，按断线状态重渲染以锁定本页操作
        clearInterval(timerInterval); // 计时条停止空跑，恢复后由状态同步重启
      } else {
        setConnStatus('offline');
      }
      $('btn-save-rules').disabled = roomOffline();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (stopRetry) return;
        // 重连期间用户已离开房间：退避中一旦回到首页且没有待恢复身份，就停止循环
        if (!state && !store.token) return;
        connect();
      }, 1500);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; }
    if (WRITE_TYPES.has(msg.type)) toast('正在重连，操作已暂时锁定，恢复后会自动刷新房间状态');
    return false;
  }

  // 房间内操作是否应锁定：断线重连中、状态同步中、恢复失败后都禁止写操作，
  // 避免在旧局面上重复提交（恢复成功的瞬间状态已刷新，不锁定）。
  const roomOffline = () => !!state &&
    (connStatus === 'reconnecting' || connStatus === 'recovering' || connStatus === 'failed');

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        store.token = msg.token;
        // 观战是临时只读身份，不进历史；玩家 token 按房间码去重保存
        if (!msg.spectator) store.addHistory(msg.token, msg.roomCode);
        // 重连身份确认后，显式拉取一次最新房间状态作为"恢复完成"信号
        // （不能只靠 reconnect 触发的广播，那两者时序耦合）
        if (awaitingSync) {
          // 断线期间可能错过回合变更：清掉基于旧局面的本地选择，恢复后以服务器状态为准
          selectedParent = null;
          reinforceMode = false;
          challengeNodeId = null;
          send({ type: 'syncState' });
        }
        break;
      case 'state':
        prevState = state;
        state = msg.state;
        // 重连后的第一份房间状态（广播或显式同步）即恢复完成：
        // 断线期间错过的变更已包含在这份状态里，重新渲染并解除操作锁定。
        if (awaitingSync) {
          awaitingSync = false;
          expectRecovery = false;
          reconnectAttempts = 0;
          setConnStatus('recovered');
          toast('连接已恢复，房间状态已刷新');
        }
        onStateChange(prevState, state);
        render();
        break;
      case 'error':
        // 重连被服务器明确拒绝（会话失效/房间不存在/观战会话过期）：
        // 不再自动重连，展示失败横幅与去向入口
        if (msg.context === 'reconnect') { onReconnectFailed(msg.message); break; }
        // 规则保存失败：编辑器保持打开，错误就地展示
        if (msg.context === 'setRules') onRulesSaveError(msg.message);
        else toast(msg.message);
        if (msg.message.includes('会话已失效') || msg.message.includes('房间已不存在')) {
          store.token = null;
          showScreen('home');
        }
        break;
      case 'rulesSaved':
        onRulesSaved();
        break;
      case 'replay':
        replayFrames = msg.frames; replayIdx = 0;
        openReplay();
        break;
      case 'history':
        onHistory(msg.entries);
        break;
      case 'leaderboard':
        onLeaderboard(msg);
        break;
      case 'profile':
        onProfile(msg.profile);
        break;
    }
  }

  // 身份恢复失败：停止自动重连循环，横幅给出"返回首页 / 重新输入房间码"。
  // 保留当前页面与最后已知局面作为背景，不清空 state，直到用户选择去向。
  function onReconnectFailed(message) {
    awaitingSync = false;
    stopRetry = true;
    connFailMessage = message;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConnStatus('failed', message);
    store.token = null;
    if (state) render(); // 立即按 failed 状态锁定本页操作
  }

  // 作废当前连接：递增代号让其后续 open/message/close 全部失效，并尝试物理关闭。
  // 用于用户主动离开房间（暂不等候/恢复失败后回首页），避免在途消息再改状态。
  function invalidateCurrentSocket() {
    currentSeq += 1;
    const old = ws;
    ws = null;
    if (old) { try { old.onclose = null; old.close(); } catch { /* 已关闭 */ } }
  }

  const goHomeFromFailure = () => {
    stopRetry = false;
    connFailMessage = '';
    expectRecovery = false;
    state = null; prevState = null;
    // 离开失败房间：清掉待恢复身份，避免新连接 onopen 又凭 token 把用户拉回原房间
    store.token = null;
    invalidateCurrentSocket();
    $('inp-code').value = '';
    showScreen('home');
    setConnStatus('offline');
    connect(); // 干净的新连接供首页创建/加入使用
  };

  // 重新输入房间码：回到首页并预填原房间码，加入/观战按钮沿用原有流程
  const reenterRoom = () => {
    const code = state ? state.code : '';
    goHomeFromFailure();
    $('inp-code').value = code;
    $('inp-code').focus();
  };

  // 重连中主动放弃等候回首页：与"恢复失败"不同，本地 token 仍然有效，保留它——
  // 用户可从历史与战绩列表重新进入；作废在途连接，避免迟到的状态推送把用户拉回房间。
  const cancelWaitForRoom = () => {
    expectRecovery = false;
    awaitingSync = false;
    suppressAutoReconnect = true; // 保留 token 但下一次连接不自动进房
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    state = null; prevState = null;
    invalidateCurrentSocket();
    $('inp-code').value = '';
    showScreen('home');
    setConnStatus('offline');
    connect(); // 干净的新连接（无待恢复房间），供首页创建/加入使用
  };

  // ---------- 历史与战绩 ----------

  let historyEntries = [];
  let historyQueryTokens = []; // 最近一次历史查询覆盖的 token，决定清理失效记录的范围

  function requestHistory() {
    const tokens = store.history.map(e => e.token);
    if (!tokens.length) { historyEntries = []; renderHistory(); return; }
    historyQueryTokens = tokens;
    send({ type: 'history', tokens });
  }

  function onHistory(entries) {
    // 只清理"本次查询过、但服务器已不认得"的 token（房间已删/数据已清）。
    // 不能按"未出现在结果中"全量清理：查询发出后，其他标签页可能又加入了新房间，
    // 那些记录不在本次查询的覆盖范围里，全量清理会把它们误删掉。
    const valid = new Set(entries.map(e => e.token));
    const queried = new Set(historyQueryTokens);
    store.history = store.history.filter(e => !queried.has(e.token) || valid.has(e.token));
    // 发现有本次查询未覆盖的新记录：补一次查询，把它们也带进列表
    if (store.history.some(e => !queried.has(e.token))) { requestHistory(); return; }
    historyEntries = entries;
    renderHistory();
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHistory() {
    const card = $('history-card');
    if (!historyEntries.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const ended = historyEntries.filter(e => e.phase === 'ended');
    const wins = ended.filter(e => e.winner && e.winner === e.youId).length;
    $('history-stats').textContent = ended.length
      ? `已结束 ${ended.length} 场 · 胜 ${wins} 场 · 胜率 ${Math.round(wins / ended.length * 100)}%`
      : '还没有已结束的对局';
    $('history-list').innerHTML = historyEntries.map((e, i) => {
      let badge, result;
      if (e.phase === 'lobby') { badge = '<span class="badge">大厅中</span>'; result = '等待开局'; }
      else if (e.phase === 'playing') { badge = '<span class="badge">对局中</span>'; result = '正在进行'; }
      else if (!e.winner) { badge = '<span class="badge">平局</span>'; result = `你 ${e.yourTotal} 分`; }
      else if (e.winner === e.youId) { badge = '<span class="badge win">胜利</span>'; result = `你 ${e.yourTotal} 分 · 第 1 名`; }
      else { badge = '<span class="badge lose">落败</span>'; result = `${esc(e.winnerName)} 获胜 · 你 ${e.yourTotal} 分（第 ${e.yourRank} 名）`; }
      const others = e.players.filter(n => n !== e.youName).map(esc).join('、') || '—';
      return `<li>
        <div>
          <div><span class="h-code">${e.code}</span>${badge}</div>
          <div class="h-sub">${fmtDate(e.endedAt || e.createdAt)} · 与 ${others} 对局 · ${result}</div>
        </div>
        <button class="link" data-hidx="${i}">${e.phase === 'ended' ? '回看' : '进入'}</button>
      </li>`;
    }).join('');
    $('history-list').querySelectorAll('[data-hidx]').forEach(btn => {
      btn.onclick = () => {
        const entry = historyEntries[Number(btn.dataset.hidx)];
        if (!entry) return;
        // 凭该房间的玩家 token 重返：进行中回到对局，已结束回到结算（可回放）
        store.token = entry.token;
        send({ type: 'reconnect', token: entry.token });
      };
    });
  }

  // ---------- 赛季排行榜与个人页 ----------
  // 服务端从所有已结束对局汇总公开战绩：排行榜按总分/胜场/胜率排序，
  // 个人页展示场次、胜场、平局、平均得分、最高连锁与总分榜名次。

  let rankSort = 'total';   // total | wins | rate
  let rankRows = null;      // null=尚未拉取/加载中；[]=空赛季
  let rankStartedAt = null;
  let profileData = null;   // null=尚未拉取；false=该玩家暂无已结束对局

  // 只读请求：socket 不可用时不发送并提示（不能写按钮禁用兜底，因为这是首页入口）
  function askLeaderboard() {
    rankRows = null;
    if (!send({ type: 'leaderboard', sort: rankSort })) {
      toast('正在连接服务器，排行榜稍后再试');
    }
    renderRank();
  }

  // cred：点排行榜行时传 { pid }（公开标识）；"我的战绩"传 { pidSecret }（本人密钥）
  function askProfile(cred) {
    profileData = null;
    showScreen('profile');
    if (!send({ type: 'profile', ...cred })) {
      toast('正在连接服务器，战绩稍后再试');
    }
    renderProfile();
  }

  function onLeaderboard(msg) {
    rankSort = ['total', 'wins', 'rate'].includes(msg.sort) ? msg.sort : 'total';
    rankRows = Array.isArray(msg.rows) ? msg.rows : [];
    rankStartedAt = msg.startedAt || null;
    renderRank();
  }

  function onProfile(profile) {
    profileData = profile || false;
    renderProfile();
  }

  const pct = (r) => `${Math.round(r * 100)}%`;

  function openRank() {
    showScreen('rank');
    askLeaderboard();
  }

  // 从个人页返回排行榜：可能是从首页直接进"我的战绩"（排行榜从未拉取，rankRows 为 null），
  // 此时只 renderRank 会永远停在"加载中"。无数据就补一次拉取；已有数据直接展示，不闪加载。
  function backToRank() {
    showScreen('rank');
    if (rankRows === null) askLeaderboard();
    else renderRank();
  }

  function renderRank() {
    if ($('screen-rank').classList.contains('hidden')) return;
    // 当前选中的排序维度高亮；服务端按该维度返回名次
    for (const [key, id] of [['total', 'btn-sort-total'], ['wins', 'btn-sort-wins'], ['rate', 'btn-sort-rate']]) {
      $(id).classList.toggle('primary', key === rankSort);
    }
    $('rank-season').textContent = rankStartedAt ? `本赛季自 ${fmtDate(rankStartedAt)} 起` : '';
    const list = $('rank-list');
    if (rankRows === null) { list.innerHTML = '<p class="hint">排行榜加载中…</p>'; return; }
    if (!rankRows.length) { list.innerHTML = '<p class="hint">还没有人完成对局，打完一局就上榜。</p>'; return; }
    list.innerHTML = `<table>
      <tr><th>名次</th><th>玩家</th><th>总分</th><th>胜场</th><th>胜率</th><th>场次</th></tr>
      ${rankRows.map(r => `<tr class="rank-row" data-pid="${esc(r.pid)}" title="查看个人战绩">
        <td>${r.rank === 1 ? '🏆 ' : ''}${r.rank}</td>
        <td>${esc(r.name)}</td>
        <td><b>${r.totalScore}</b></td>
        <td>${r.wins}</td>
        <td>${pct(r.winRate)}</td>
        <td>${r.games}</td>
      </tr>`).join('')}</table>`;
    list.querySelectorAll('.rank-row').forEach(tr => {
      tr.onclick = () => askProfile({ pid: tr.dataset.pid });
    });
  }

  function renderProfile() {
    if ($('screen-profile').classList.contains('hidden')) return;
    const box = $('profile-body');
    if (profileData === null) { box.innerHTML = '<p class="hint">战绩加载中…</p>'; return; }
    if (!profileData) {
      box.innerHTML = '<p class="hint">这名玩家还没有已结束的对局。</p>';
      return;
    }
    const p = profileData;
    const rankText = p.rank ? `总分榜第 ${p.rank} 名` : '暂无排名';
    box.innerHTML = `
      <h3>${esc(p.name)} <span class="hint">（${rankText}）</span></h3>
      <div class="stat-grid">
        <div class="stat"><div class="stat-v">${p.games}</div><div class="stat-k">场次</div></div>
        <div class="stat win"><div class="stat-v">${p.wins}</div><div class="stat-k">胜场</div></div>
        <div class="stat"><div class="stat-v">${p.ties}</div><div class="stat-k">平局</div></div>
        <div class="stat"><div class="stat-v">${p.losses}</div><div class="stat-k">负场</div></div>
        <div class="stat"><div class="stat-v">${pct(p.winRate)}</div><div class="stat-k">胜率</div></div>
        <div class="stat"><div class="stat-v">${p.totalScore}</div><div class="stat-k">总得分</div></div>
        <div class="stat"><div class="stat-v">${p.avgScore}</div><div class="stat-k">平均得分</div></div>
        <div class="stat"><div class="stat-v">${p.bestChain}</div><div class="stat-k">最高连锁</div></div>
      </div>
      <p class="hint">最近对局：${p.lastAt ? fmtDate(p.lastAt) : '—'}</p>`;
  }

  // ---------- 状态变化 → 提示 / 教学 ----------

  function onStateChange(prev, cur) {
    // 观战者只读：不发任何行动引导，只在进入时提示一次
    if (cur.spectating) {
      if (!prev || !prev.spectating) {
        toast(cur.phase === 'playing'
          ? '正在观战：玩家、词链、回合和质疑状态会实时同步'
          : cur.phase === 'ended' ? '对局已结束，可以查看结算与回放' : '正在观战大厅，等待房主开始游戏');
      }
      return;
    }
    if (!prev || prev.phase !== cur.phase) {
      if (cur.phase === 'playing') tip('goal', '【目标】用行动点把新词接到场上，连成你的领地。词链越长得分越高；未加固的连接可能被对手质疑拆除。');
    }
    // 大厅里规则被修改：高亮规则卡片，非房主玩家额外弹提示，确保及时看到
    if (prev && cur.phase === 'lobby' && !WTRules.sameRuleSet(prev.ruleSet, cur.ruleSet)) {
      flashRulesCard();
      if (cur.you !== cur.hostId) toast('房主更新了本局规则');
    }
    // 大厅里词包选择变化：非房主玩家弹提示，主题与候选词已在词包卡片中展示
    if (prev && cur.phase === 'lobby' &&
        JSON.stringify(prev.wordPack || null) !== JSON.stringify(cur.wordPack || null)) {
      if (cur.you !== cur.hostId) {
        toast(cur.wordPack ? `房主选择了主题词包「${cur.wordPack.name}」` : '房主改回了默认词池');
      }
    }
    if (cur.phase === 'playing' && cur.turn) {
      if (!prev || !prev.turn || prev.turn.turnNumber !== cur.turn.turnNumber) {
        if (cur.turn.playerId === cur.you) {
          tip('yourturn', '【轮到你了】点击场上任意一个词作为连接点，再点「接词」。也可以点「加固」保护自己的关键连接。');
        }
      }
      // 有对手新接了词（起始词等中立词不算）
      if (prev) {
        const newOpp = WTTips.findNewOpponentWords(prev.nodes, cur.nodes, cur.you);
        if (newOpp.length) {
          tip('challenge', `【可以质疑】对手接出了「${newOpp[0].word}」。如果你认为关系不成立，点击词上的「质疑」标记，由裁定者按规则判定。`);
        }
      }
    }
    // 质疑出现
    if (cur.pendingChallenge && (!prev || !prev.pendingChallenge)) {
      const ch = cur.pendingChallenge;
      if (ch.adjudicatorId === cur.you) {
        tip('judge', '【请你裁定】对照本局规则，判断这条连接是否成立。裁定结果立即生效，计时已暂停。');
        openJudge();
      } else {
        const who = playerName(cur, ch.challengerId);
        toast(`${who} 发起了质疑，等待裁定…`);
      }
    }
    if (!cur.pendingChallenge && prev && prev.pendingChallenge) closeDialog('dlg-judge');
    if (cur.phase === 'ended' && (!prev || prev.phase !== 'ended')) {
      tip('score', '【结算】每个词得 1+深度 分，加固 +1，最长链另有奖励。点「回放本局」可以复盘整局。');
    }
  }

  // 教学提示：排队展示，关闭时才记为已读
  const tipQueue = WTTips.createTipQueue({
    isSeen: (key) => store.seenTips.includes(key),
    markSeen: (key) => store.addSeenTip(key),
    show: (text) => { $('tip-text').textContent = text; $('tip-box').classList.remove('hidden'); },
    hide: () => $('tip-box').classList.add('hidden'),
  });
  const tip = (key, text) => tipQueue.push(key, text);
  $('tip-ok').onclick = () => tipQueue.dismiss();

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toast-wrap').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- 渲染 ----------

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(`screen-${name}`).classList.remove('hidden');
    renderConnBanners();
  }

  // ---------- 连接状态横幅（大厅/对局/结算统一） ----------

  const CONN_BANNERS = [
    { id: 'conn-banner-lobby', phase: 'lobby' },
    { id: 'conn-banner-game', phase: 'playing' },
    { id: 'conn-banner-end', phase: 'ended' },
  ];

  function setConnStatus(next, failMessage) {
    connStatus = next;
    if (recoverHideTimer) { clearTimeout(recoverHideTimer); recoverHideTimer = null; }
    if (next === 'recovered') {
      // 成功提示短暂展示后收起，避免一直占用页面
      recoverHideTimer = setTimeout(() => {
        recoverHideTimer = null;
        if (connStatus === 'recovered') { connStatus = 'online'; renderConnBanners(); }
      }, 2500);
    }
    renderConnBanners(failMessage);
    updateHomeConnState();
  }

  function connBannerHtml(status, failMessage) {
    const attempt = reconnectAttempts > 0 ? `（第 ${reconnectAttempts} 次）` : '';
    if (status === 'reconnecting') {
      return `<span class="conn-text"><span class="conn-dot"></span>连接已断开，正在自动重连${attempt}…操作已暂时锁定</span>
        <span class="conn-actions"><button class="link" data-conn="cancel">暂不等候，回首页</button></span>`;
    }
    if (status === 'recovering') {
      return `<span class="conn-text"><span class="conn-dot"></span>已连上服务器，正在恢复房间并同步最新状态…</span>
        <span class="conn-actions"><button class="link" data-conn="cancel">暂不等候，回首页</button></span>`;
    }
    if (status === 'recovered') {
      return `<span class="conn-text"><span class="conn-dot"></span>已恢复连接，房间状态已刷新</span>`;
    }
    if (status === 'failed') {
      const msg = failMessage || '会话已失效，无法恢复房间';
      return `<span class="conn-text"><span class="conn-dot"></span>恢复失败：${esc(msg)}</span>
        <span class="conn-actions">
          <button data-conn="reenter">重新输入房间码</button>
          <button class="primary" data-conn="home">返回首页</button>
        </span>`;
    }
    return '';
  }

  function renderConnBanners(failMessage) {
    for (const b of CONN_BANNERS) {
      const el = $(b.id);
      const show = !!state && state.phase === b.phase &&
        ['reconnecting', 'recovering', 'recovered', 'failed'].includes(connStatus);
      if (!show) { el.classList.add('hidden'); continue; }
      el.classList.remove('hidden');
      el.className = `conn-banner ${connStatus}`;
      el.innerHTML = connBannerHtml(connStatus, failMessage);
    }
    // 横幅按钮事件每次重渲染后重新绑定
    document.querySelectorAll('.conn-banner [data-conn]').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.conn;
        if (act === 'home') goHomeFromFailure();
        else if (act === 'cancel') cancelWaitForRoom();
        else reenterRoom();
      };
    });
  }

  // 首页：未连接时禁用建/加/观战，避免请求在断线时丢失后无反馈。
  // 只在离线时写 home-error，连接恢复时清空；不覆盖用户自己的房间码校验错误。
  function updateHomeConnState() {
    const online = (ws && ws.readyState === 1) &&
      !(connStatus === 'reconnecting' || connStatus === 'recovering');
    for (const id of ['btn-create', 'btn-join', 'btn-spectate']) $(id).disabled = !online;
    if (online) {
      if ($('home-error').textContent === '正在连接服务器…') $('home-error').textContent = '';
    } else if (!state) {
      $('home-error').textContent = '正在连接服务器…';
    }
  }

  const isSpectating = () => !!(state && state.spectating);

  function playerName(s, id) {
    if (!id) return '中立';
    const p = s.players.find(p => p.id === id);
    return p ? p.name : '?';
  }
  function playerColor(s, id) {
    const p = s.players.find(p => p.id === id);
    return p ? p.color : '#999';
  }

  function render() {
    if (!state) return;
    // 阶段切换（如断线同步后发现对局已结束）：本地选词不跨阶段保留
    if (prevState && prevState.phase !== state.phase) {
      selectedParent = null;
      reinforceMode = false;
    }
    if (state.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
    else if (state.phase === 'playing') { renderGame(); showScreen('game'); }
    else if (state.phase === 'ended') { renderEnd(); showScreen('end'); }
  }

  function renderLobby() {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;
    $('lobby-players').innerHTML = state.players.map(p =>
      `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}
       ${p.id === state.hostId ? '（房主）' : ''}
       ${p.id === state.you ? '（你）' : ''}
       ${p.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    const specs = state.spectators || [];
    $('lobby-spectators').innerHTML = specs.map(s =>
      `<li class="spectator">👁 ${esc(s.name)}${s.id === state.you ? '（你·观战）' : '（观战）'}
       ${s.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    $('rules-summary').innerHTML = rulesSummary(state.ruleSet);
    const isHost = state.you === state.hostId;
    $('btn-edit-rules').classList.toggle('hidden', !isHost);
    $('btn-start').classList.toggle('hidden', !isHost);
    renderPackCard(isHost);
    // 断线重连中：开始游戏/保存规则等会产生写操作的入口一律锁定，恢复后随状态刷新解锁
    $('btn-start').disabled = roomOffline();
    $('btn-save-rules').disabled = rulesSavePending || roomOffline();
    $('btn-exit-spectate').classList.toggle('hidden', !state.spectating);
    $('lobby-wait').textContent = isHost
      ? (state.players.length < 2 ? '至少需要 2 名玩家才能开始' : '人齐了就点开始吧')
      : (state.spectating ? '你正在观战，对局开始后会自动收到局面' : '等待房主开始…');
  }

  function rulesSummary(r) {
    const names = r.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return t ? t.name : id;
    }).join('、');
    return `<ul>
      <li>允许的关系：${names}</li>
      <li>专有名词：${r.allowProperNouns ? '允许' : '不允许'}</li>
      <li>解释至少 ${r.minReasonLen} 字 · 每回合 ${r.turnSeconds} 秒 · ${r.apPerTurn} 行动点</li>
      <li>每人 ${r.rounds} 回合 · ${r.challengeTokens} 次质疑机会</li>
      <li>计分：词 = 1+深度 分，加固 +1，最长链 ×2 奖励</li>
    </ul>`;
  }

  // ---------- 大厅：主题词包 ----------
  // 所有人都能在大厅看到当前选用的词包（主题与候选词）；只有房主能换选。
  // 房主的下拉选项来自本机词包（localStorage），选中后词包内容作为快照发给服务器。

  let packSelectSig = ''; // 下拉选项签名：本机词包或当前选中变化时才重建，避免打字/刷新时闪烁

  function renderPackCard(isHost) {
    const wp = state.wordPack || null;
    $('pack-host-row').classList.toggle('hidden', !isHost);
    if (isHost) {
      // 当前生效的词包可能已在本机被删除（房间里的快照仍在生效）：
      // 为它补一个"当前选择"选项并如实选中，不能误显示成默认词池
      const missing = !!(wp && !store.packs.some(p => p.id === wp.id));
      const sig = JSON.stringify([store.packs.map(p => [p.id, p.name, p.words.length]), wp && wp.id, missing]);
      if (sig !== packSelectSig) {
        packSelectSig = sig;
        $('pack-select').innerHTML = '<option value="">默认词池</option>' +
          store.packs.map(p =>
            `<option value="${p.id}">${esc(p.name)}（${p.words.length} 词）</option>`).join('') +
          (missing
            ? `<option value="${wp.id}">${esc(wp.name)}（本机已删除，仍是本局选择）</option>`
            : '');
      }
      $('pack-select').value = wp ? wp.id : '';
      $('pack-select').disabled = roomOffline();
    }
    $('pack-info').innerHTML = wp
      ? `<div class="pack-theme-line">主题词包：<b>${esc(wp.name)}</b>${wp.theme ? ` · ${esc(wp.theme)}` : ''}</div>
         <div class="pack-words">${wp.words.map(w => `<span class="pack-chip">${esc(w)}</span>`).join('')}</div>
         <p class="hint">开局将从以上 ${wp.words.length} 个候选词中不重复抽取
           ${Math.min(state.ruleSet.startWordCount, wp.words.length)} 个起始词。</p>`
      : `<p class="hint">未选用主题词包，开局将从默认词池抽取起始词。
           ${isHost ? '可先在首页「我的词包」创建词包，再回到这里选择。' : '房主可以在大厅选用主题词包。'}</p>`;
  }

  $('pack-select').onchange = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    const id = $('pack-select').value;
    if (!id) { send({ type: 'setWordPack', pack: null }); return; }
    const p = WTPacks.find(store.packs, id);
    if (!p) return toast('这个词包已不在本机，请重新选择');
    send({ type: 'setWordPack', pack: { id: p.id, name: p.name, theme: p.theme, words: p.words } });
  };

  function renderGame() {
    const t = state.turn;
    const spectator = !!state.spectating;
    const active = !spectator && t && t.playerId === state.you;
    $('turn-info').innerHTML = t
      ? `第 ${t.turnNumber} 回合 · 轮到 <b style="color:${playerColor(state, t.playerId)}">${esc(playerName(state, t.playerId))}</b>${active ? '（你）' : ''}`
      : '';
    $('ap-info').textContent = spectator
      ? '观战中 · 只读'
      : active
        ? `你的行动点：${t.apLeft} / ${state.ruleSet.apPerTurn}`
        : `你的质疑机会：${(state.players.find(p => p.id === state.you) || {}).tokensLeft ?? 0}`;

    $('spectator-banner').classList.toggle('hidden', !spectator);

    $('scoreboard').innerHTML = state.players.map(p => {
      const words = state.nodes.filter(n => n.ownerId === p.id).length;
      return `<span class="score-chip ${t && t.playerId === p.id ? 'active' : ''}">
        <span class="dot" style="background:${p.color}"></span>${esc(p.name)} · ${words} 词
        ${p.connected ? '' : '<span class="offline">离线</span>'}</span>`;
    }).join('') + ((state.spectators || []).length
      ? `<span class="score-chip spec">👁 ${state.spectators.length} 人观战</span>` : '');

    // 待裁定横幅：常显入口，防止弹窗被关掉后整局卡住（观战者不显示裁定入口）
    const ch = state.pendingChallenge;
    if (ch) {
      const iAmJudge = !spectator && ch.adjudicatorId === state.you;
      const node = state.nodes.find(n => n.id === ch.nodeId);
      $('challenge-banner-text').textContent = iAmJudge
        ? `有质疑等待你裁定${node ? `（目标：${node.word}）` : ''}，裁定前对局暂停`
        : spectator
          ? `${playerName(state, ch.challengerId)} 发起了质疑，等待 ${playerName(state, ch.adjudicatorId)} 裁定…`
          : `等待 ${playerName(state, ch.adjudicatorId)} 裁定质疑…`;
      $('btn-goto-judge').classList.toggle('hidden', !iAmJudge);
      $('challenge-banner').classList.remove('hidden');
      // 裁定者每次状态刷新都确保弹窗开着
      if (iAmJudge) openJudge();
    } else {
      $('challenge-banner').classList.add('hidden');
    }

    renderBoard($('board'), state.nodes, {
      selectable: active,
      showChallenge: !active && !spectator && state.phase === 'playing',
    });

    // 观战者：隐藏全部行动按钮，词链不可选
    $('action-row').classList.toggle('hidden', spectator);
    // 断线重连/恢复中：行动按钮禁用，防止在旧局面上重复提交。
    // 注意 recovered 横幅展示期间操作已可用（此时状态就是刚同步的最新状态）。
    const offline = roomOffline();
    $('btn-play').disabled = !active || !selectedParent || (t && t.apLeft < 1) || !!state.pendingChallenge || offline;
    $('btn-reinforce').disabled = !active || (t && t.apLeft < 1) || !!state.pendingChallenge || offline;
    $('btn-reinforce').textContent = reinforceMode ? '取消加固' : '加固';
    $('btn-endturn').disabled = !active || !!state.pendingChallenge || offline;
    $('btn-replay').classList.add('hidden');

    updateTimer();
  }

  function renderBoard(container, nodes, opts = {}) {
    // 按树形缩进展示
    const children = new Map();
    for (const n of nodes) {
      const key = n.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    }
    const html = [];
    const walk = (parentId, depth) => {
      for (const n of children.get(parentId) || []) {
        html.push(nodeHtml(n, depth, opts));
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    // 兜底：父节点缺失的孤儿（理论上不会出现）
    for (const n of nodes) {
      if (n.parentId && !nodes.some(p => p.id === n.parentId) && !html.some(h => h.includes(n.id))) {
        html.push(nodeHtml(n, 0, opts));
      }
    }
    container.innerHTML = html.join('');
    container.querySelectorAll('.node').forEach(el => {
      el.onclick = (e) => {
        if (e.target.classList.contains('challengeable')) return;
        if (e.target.classList.contains('fav-btn')) return; // 收藏按钮自行处理，不触发选词
        onNodeClick(el.dataset.id);
      };
    });
    container.querySelectorAll('.challengeable').forEach(el => {
      el.onclick = () => { challengeNodeId = el.closest('.node').dataset.id; openChallengeConfirm(); };
    });
    container.querySelectorAll('.fav-btn').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        if (opts.onCollect) opts.onCollect(el.closest('.node').dataset.id);
      };
    });
  }

  function nodeHtml(n, depth, opts) {
    const color = n.ownerId ? playerColor(state, n.ownerId) : '#999';
    const rel = n.relation ? (state.relationTypes.find(r => r.id === n.relation) || {}).name : '';
    const mine = n.ownerId === state.you;
    const canChallenge = opts.showChallenge && n.ownerId && !mine && !n.reinforced &&
      !state.pendingChallenge && (state.players.find(p => p.id === state.you) || {}).tokensLeft > 0;
    const badges = [];
    if (n.reinforced && n.parentId) badges.push('<span class="badge shield">已加固</span>');
    if (n.survivedAsRoot) badges.push('<span class="badge shield">幸存根</span>');
    if (canChallenge) badges.push('<span class="badge challengeable">质疑</span>');
    // 回放里可收藏的连接（有父词、是玩家接出的词）：显示收藏 / 已收藏
    if (opts.collectable && n.parentId && n.ownerId) {
      const saved = store.favorites.some(f => f.key === WTFav.connectionKey(n, state.code));
      badges.push(saved
        ? '<span class="badge fav-saved">已收藏</span>'
        : '<span class="badge fav-btn" title="收藏这条连接">收藏</span>');
    }
    return `<div class="node ${n.ownerId ? '' : 'start'} ${selectedParent === n.id ? 'selected' : ''}"
      data-id="${n.id}" style="margin-left:${depth * 22}px; border-left-color:${color}">
      <span class="word">${esc(n.word)}</span>
      <div class="meta">${n.ownerId ? `${esc(playerName(state, n.ownerId))} · ${rel || ''} · ${esc(n.reason || '')}` : '起始词'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`;
  }

  function onNodeClick(nodeId) {
    if (isSpectating()) return;
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    const t = state.turn;
    if (!t || t.playerId !== state.you) return;
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (reinforceMode) {
      if (node.ownerId !== state.you) return toast('只能加固自己的词');
      if (!node.parentId) return toast('起始词无需加固');
      if (node.reinforced) return toast('已经加固过了');
      send({ type: 'reinforce', nodeId });
      reinforceMode = false;
      return;
    }
    selectedParent = selectedParent === nodeId ? null : nodeId;
    render();
  }

  // ---------- 计时 ----------

  function updateTimer() {
    clearInterval(timerInterval);
    const tick = () => {
      if (!state || !state.turn) return;
      // 断线期间不倒数：显示连接状态，避免计时条空跑；恢复后状态同步会带回正确 deadline
      if (connStatus === 'reconnecting' || connStatus === 'recovering' || connStatus === 'failed') {
        $('timer-text').textContent = '连接中断…';
        return;
      }
      const t = state.turn;
      let remain;
      if (t.deadline) remain = Math.max(0, t.deadline - Date.now());
      else if (t.pausedRemaining != null) remain = t.pausedRemaining;
      else return;
      const total = state.ruleSet.turnSeconds * 1000;
      const pct = Math.min(100, remain / total * 100);
      $('timer-bar').style.width = pct + '%';
      $('timer-bar').classList.toggle('low', remain < 15000);
      $('timer-text').textContent = t.deadline ? `${Math.ceil(remain / 1000)}s` : '裁定中…';
    };
    tick();
    timerInterval = setInterval(tick, 500);
  }

  // ---------- 结算 ----------

  function renderEnd() {
    const scores = state.scores || [];
    const meWin = state.winner === state.you;
    $('btn-exit-spectate3').classList.toggle('hidden', !state.spectating);
    // 断线重连中：回放请求会丢失，先锁定按钮；恢复后状态同步会重新渲染
    $('btn-replay2').disabled = roomOffline();
    $('end-title').textContent = state.spectating
      ? '对局结束（观战中）'
      : state.winner
        ? `🏆 ${playerName(state, state.winner)} 获胜！${meWin ? '（是你）' : ''}` : '平局！';
    $('end-scores').innerHTML = `<table>
      <tr><th>玩家</th><th>词数</th><th>最长链</th><th>总分</th></tr>
      ${scores.map(s => `<tr>
        <td><span class="dot" style="background:${s.color}"></span> ${esc(s.name)}${s.playerId === state.you ? '（你）' : ''}</td>
        <td>${s.words}</td><td>${s.longestChain}</td><td><b>${s.total}</b></td>
      </tr>`).join('')}</table>`;
  }

  // ---------- 弹窗 ----------

  function openDialog(id) { $(id).showModal(); }
  function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
  document.querySelectorAll('[data-close]').forEach(b =>
    b.onclick = () => b.closest('dialog').close());

  $('btn-play').onclick = () => {
    const parent = state.nodes.find(n => n.id === selectedParent);
    if (!parent) return toast('先点击选择一个要连接的词');
    $('play-parent').textContent = parent.word;
    $('play-word').value = '';
    $('play-reason').value = '';
    $('play-relation').innerHTML = state.ruleSet.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return `<option value="${id}">${t.name}（${t.example}）</option>`;
    }).join('');
    $('play-minlen').textContent = `解释至少 ${state.ruleSet.minReasonLen} 字` +
      (state.ruleSet.allowProperNouns ? '；允许专有名词' : '；不允许专有名词');
    openDialog('dlg-play');
  };

  $('play-submit').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'play', word: $('play-word').value, parentId: selectedParent,
      relation: $('play-relation').value, reason: $('play-reason').value });
    closeDialog('dlg-play');
    selectedParent = null;
  };

  $('btn-reinforce').onclick = () => {
    reinforceMode = !reinforceMode;
    if (reinforceMode) toast('点击你的一条未加固连接进行加固');
    render();
  };

  $('btn-endturn').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'endTurn' });
  };

  function openChallengeConfirm() {
    const n = state.nodes.find(x => x.id === challengeNodeId);
    if (!n) return;
    $('challenge-target').innerHTML =
      `目标：<b>${esc(n.word)}</b>（${esc(playerName(state, n.ownerId))}：${esc(n.reason)}）`;
    openDialog('dlg-challenge');
  }
  $('challenge-submit').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'challenge', nodeId: challengeNodeId });
    closeDialog('dlg-challenge');
  };

  function openJudge() {
    const ch = state && state.pendingChallenge;
    if (!ch) return;
    const node = state.nodes.find(n => n.id === ch.nodeId);
    if (!node) return;
    const rel = (state.relationTypes.find(r => r.id === node.relation) || {}).name || '';
    const parent = state.nodes.find(n => n.id === node.parentId);
    $('judge-detail').innerHTML =
      `<p><b>${esc(playerName(state, ch.challengerId))}</b> 质疑了
       <b>${esc(playerName(state, node.ownerId))}</b> 的连接：</p>
       <p style="margin:8px 0">「${parent ? esc(parent.word) : '?'}」—<b>${rel}</b>→「${esc(node.word)}」</p>
       <p>解释：${esc(node.reason)}</p>`;
    $('judge-rules').innerHTML = rulesSummary(state.ruleSet);
    if (!$('dlg-judge').open) openDialog('dlg-judge');
  }
  // 裁定未作出前不允许关闭弹窗（Esc / 取消），避免整局卡死
  $('dlg-judge').addEventListener('cancel', (e) => e.preventDefault());
  $('btn-goto-judge').onclick = () => openJudge();
  // 断线期间裁定同样会丢失：不发送、不关闭弹窗，恢复后可直接重试
  $('judge-uphold').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'resolve', verdict: 'uphold' }); closeDialog('dlg-judge');
  };
  $('judge-reject').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'resolve', verdict: 'reject' }); closeDialog('dlg-judge');
  };

  $('btn-rules-view').onclick = () => {
    $('rules-view').innerHTML = rulesSummary(state.ruleSet);
    openDialog('dlg-rules');
  };

  // ---------- 回放 ----------

  function openReplay() {
    renderReplayFrame();
    openDialog('dlg-replay');
  }
  function renderReplayFrame() {
    const f = replayFrames[replayIdx];
    $('replay-label').textContent = f.label;
    $('replay-pos').textContent = `${replayIdx + 1} / ${replayFrames.length}`;
    renderBoard($('replay-board'), f.nodes, {
      collectable: true,
      onCollect: (nodeId) => collectFromReplay(f.nodes, nodeId),
    });
  }

  // 从回放某一帧收藏一条连接：保存前词、后词、关系、原解释与来源房间
  function collectFromReplay(nodes, nodeId) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node || !node.parentId) return;
    const parent = nodes.find(n => n.id === node.parentId);
    if (!parent) return;
    const entry = WTFav.makeEntry(node, parent, {
      roomCode: state.code, relationTypes: state.relationTypes,
    });
    if (!entry) return;
    const { entries, added } = WTFav.add(store.favorites, entry);
    if (!added) return toast('这条连接已经收藏过了');
    store.favorites = entries;
    toast(`已收藏「${entry.front} → ${entry.back}」`);
    renderReplayFrame(); // 刷新"已收藏"标记
  }
  $('replay-prev').onclick = () => { if (replayIdx > 0) { replayIdx--; renderReplayFrame(); } };
  $('replay-next').onclick = () => { if (replayIdx < replayFrames.length - 1) { replayIdx++; renderReplayFrame(); } };
  $('btn-replay').onclick = () => send({ type: 'replay' });
  $('btn-replay2').onclick = () => send({ type: 'replay' });

  // ---------- 首页 / 大厅事件 ----------

  $('inp-name').value = store.name;
  $('btn-create').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    store.name = name;
    send({ type: 'createRoom', name, pidSecret: store.pidSecret });
  };
  $('btn-join').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    store.name = name;
    send({ type: 'joinRoom', name, pidSecret: store.pidSecret, roomCode: code });
  };
  $('btn-spectate').onclick = () => {
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    // 观战身份是临时的、只读的；昵称可选，不写入本地
    send({ type: 'spectate', name: $('inp-name').value.trim() || '观战者', roomCode: code });
  };
  // 退出观战：丢弃临时观战 token，回到首页（不影响房间内对局）
  const exitSpectate = () => { store.token = null; location.reload(); };
  $('btn-exit-spectate').onclick = exitSpectate;
  $('btn-exit-spectate2').onclick = exitSpectate;
  $('btn-exit-spectate3').onclick = exitSpectate;

  // ---------- 规则编辑器 ----------
  // 打开时完整回填当前规则；保存前就地校验；等服务器确认（rulesSaved）后再关闭，
  // 失败时编辑器保持打开、错误就地显示，已填内容不丢失。

  function flashRulesCard() {
    const card = $('rules-card');
    card.classList.remove('flash');
    void card.offsetWidth; // 重新触发动画
    card.classList.add('flash');
  }

  function clearRuleErrors() {
    document.querySelectorAll('#rules-editor .field-error').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('#rules-editor input').forEach(el => el.classList.remove('invalid'));
  }

  function showRuleError(errId, inputId, msg) {
    $(errId).textContent = msg;
    if (inputId) $(inputId).classList.add('invalid');
  }

  // 用当前生效的规则完整回填编辑器，并清掉上次遗留的错误提示
  function fillRulesEditor() {
    const r = state.ruleSet;
    $('rules-relations').innerHTML = state.relationTypes.map(t =>
      `<label><input type="checkbox" data-rel="${t.id}" ${r.allowedRelations.includes(t.id) ? 'checked' : ''}>
       ${t.name}（${t.example}）</label>`).join('');
    $('rule-proper').checked = r.allowProperNouns;
    for (const f of WTRules.NUMBER_FIELDS) $(f.id).value = r[f.key];
    clearRuleErrors();
  }

  // 收集输入并校验；通过则返回可提交的 ruleSet，否则就地标出错误并返回 null
  function validateRulesEditor() {
    clearRuleErrors();
    const input = {
      allowedRelations: [...document.querySelectorAll('[data-rel]:checked')].map(x => x.dataset.rel),
    };
    for (const f of WTRules.NUMBER_FIELDS) input[f.key] = $(f.id).value;
    const { errors, ruleSet } = WTRules.validateRuleSet(input);
    for (const [key, msg] of Object.entries(errors)) {
      if (key === 'allowedRelations') showRuleError('err-rule-relations', null, msg);
      else {
        const f = WTRules.NUMBER_FIELDS.find(x => x.key === key);
        showRuleError(`err-${f.id}`, f.id, msg);
      }
    }
    if (Object.keys(errors).length > 0) return null;
    ruleSet.allowProperNouns = $('rule-proper').checked;
    return ruleSet;
  }

  // 提交锁定只能由两种确定结果解除：服务器答复（rulesSaved / 带 setRules 上下文的 error），
  // 或连接断开（onclose，此次请求不会再有答复）。不能用定时器自动解除——
  // 网络延迟超过定时时长而服务器尚未确认时，锁会被误解除，导致重复提交。
  function setRulesSavePending(pending) {
    rulesSavePending = pending;
    $('btn-save-rules').disabled = pending || roomOffline();
  }

  function onRulesSaved() {
    setRulesSavePending(false);
    $('rules-editor').classList.add('hidden');
    toast('规则已保存');
  }

  function onRulesSaveError(message) {
    setRulesSavePending(false);
    if ($('rules-editor').classList.contains('hidden')) $('rules-editor').classList.remove('hidden');
    showRuleError('err-rules-general', null, message);
  }

  $('btn-edit-rules').onclick = () => {
    const editor = $('rules-editor');
    if (editor.classList.contains('hidden')) {
      fillRulesEditor();
      editor.classList.remove('hidden');
    } else {
      editor.classList.add('hidden');
    }
  };
  $('btn-cancel-rules').onclick = () => $('rules-editor').classList.add('hidden');
  $('btn-save-rules').onclick = () => {
    if ($('btn-save-rules').disabled) return;
    const ruleSet = validateRulesEditor();
    if (!ruleSet) return; // 校验未通过：错误已就地标出，不发送
    setRulesSavePending(true);
    send({ type: 'setRules', ruleSet });
  };
  $('btn-start').onclick = () => {
    if (roomOffline()) return toast('正在重连，操作暂时不可用');
    send({ type: 'startGame' });
  };
  $('btn-home').onclick = () => { store.token = null; location.reload(); };

  // ---------- 赛季排行榜 / 个人页 ----------

  $('btn-rank-home').onclick = openRank;
  $('btn-my-profile').onclick = () => askProfile({ pidSecret: store.pidSecret });
  $('btn-sort-total').onclick = () => { rankSort = 'total'; askLeaderboard(); };
  $('btn-sort-wins').onclick = () => { rankSort = 'wins'; askLeaderboard(); };
  $('btn-sort-rate').onclick = () => { rankSort = 'rate'; askLeaderboard(); };
  $('btn-rank-back').onclick = () => showScreen('home');
  $('btn-rank-my').onclick = () => askProfile({ pidSecret: store.pidSecret });
  $('btn-profile-back-rank').onclick = backToRank;
  $('btn-profile-back-home').onclick = () => showScreen('home');
  // 结算后可直接进排行榜（连接与房间状态保留，返回首页/重连不受影响）
  $('btn-end-rank').onclick = openRank;

  // ---------- 战术练习（单机，纯前端；进度存本浏览器） ----------

  let prSession = null, prReinforceMode = false;

  function renderPracticeList() {
    const done = store.practice;
    $('practice-list').innerHTML = WTPractice.SCENARIOS.map((s, i) => {
      const isDone = !!done[s.id];
      return `<li>
        <div>
          <div class="pl-title">${esc(s.title)} ${isDone ? '<span class="badge done">已通关</span>' : ''}</div>
          <div class="pl-sub">${esc(s.subtitle)}</div>
        </div>
        <button class="link" data-sid="${i}">${isDone ? '再练一次' : '开始'}</button>
      </li>`;
    }).join('');
    $('practice-list').querySelectorAll('[data-sid]').forEach(btn => {
      btn.onclick = () => openScenario(WTPractice.SCENARIOS[Number(btn.dataset.sid)].id);
    });
  }

  function openScenario(id) {
    prSession = WTPractice.startSession(id);
    prReinforceMode = false;
    const s = prSession.scenario;
    $('pr-title').textContent = s.title;
    $('pr-subtitle').textContent = s.subtitle;
    $('pr-goal').textContent = s.goal;
    $('pr-ops').innerHTML = s.ops.map(o => `<li>${esc(o)}</li>`).join('');
    showScreen('practice-game');
    renderPracticeGame();
  }

  function renderPracticeGame() {
    if (!prSession) return;
    const sc = prSession.scenario;

    // 双方当前分数（提交后即结算分数）
    const youTotal = prSession.result
      ? prSession.result.scores.you.after
      : WTPractice.scoreBreakdown(prSession.nodes, WTPractice.YOU).total;
    const oppTotal = prSession.result
      ? prSession.result.scores.opp.after
      : WTPractice.scoreBreakdown(prSession.nodes, WTPractice.OPP).total;
    $('pr-scoreboard').innerHTML = WTPractice.PLAYERS.map(p => {
      const total = p.id === WTPractice.YOU ? youTotal : oppTotal;
      return `<span class="score-chip active"><span class="dot" style="background:${p.color}"></span>${esc(p.name)} · ${total} 分</span>`;
    }).join('');

    // 行动点（级联关没有行动点概念，隐藏整行）
    $('pr-ap').textContent = sc.mode === 'cascade'
      ? ''
      : `你的行动点：${prSession.apLeft} / ${sc.ap}`;

    // 操作提示
    let hint = '';
    if (!prSession.finished) {
      if (sc.mode === 'extend') {
        if (prSession.apLeft > 0) hint = '点下方「接词」选择候选词，接完后「提交答案」结算';
        else hint = '行动点已用完，点「提交答案」查看结算（也可重置重来）';
      } else if (sc.mode === 'protect') {
        if (prReinforceMode) hint = '点击你的一条未加固连接进行加固（再点「加固」取消选择）';
        else if (prSession.apLeft > 0) hint = '点「加固」选择一条连接，提交后对手会质疑让你失分最多的目标';
        else hint = '已用掉加固机会，点「提交答案」看对手如何质疑（也可重置重来）';
      } else if (sc.mode === 'cascade') {
        const n = prSession.nodes.find(x => x.id === prSession.pendingChallengeId);
        hint = n ? `已选中要质疑的「${n.word}」，点「提交答案」拆除（再点该词取消）` : '点击对手的一条未加固连接作为质疑目标';
      }
    }
    $('pr-hint').textContent = hint;

    renderPracticeBoard();

    // 按钮可用性
    $('btn-pr-play').style.display = sc.mode === 'extend' ? '' : 'none';
    $('btn-pr-reinforce').style.display = sc.mode === 'protect' ? '' : 'none';
    $('btn-pr-play').disabled = prSession.finished || prSession.apLeft < 1;
    $('btn-pr-reinforce').disabled = prSession.finished || prSession.apLeft < 1;
    $('btn-pr-reinforce').textContent = prReinforceMode ? '取消加固' : '加固';
    $('btn-pr-submit').disabled = prSession.finished ||
      (sc.mode === 'cascade' && !prSession.pendingChallengeId);

    renderPracticeResult();
  }

  function renderPracticeBoard() {
    const sc = prSession.scenario;
    const colorOf = (ownerId) => {
      if (!ownerId) return '#999';
      const p = WTPractice.PLAYERS.find(x => x.id === ownerId);
      return p ? p.color : '#999';
    };
    // 按树形缩进展示（与正式对局同一套结构）
    const children = new Map();
    for (const n of prSession.nodes) {
      const key = n.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    }
    const html = [];
    const walk = (parentId, depth) => {
      for (const n of children.get(parentId) || []) {
        html.push(prNodeHtml(n, depth, colorOf));
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    $('pr-board').innerHTML = html.join('');
    $('pr-board').querySelectorAll('.node').forEach(el => {
      el.onclick = () => prNodeClick(el.dataset.id);
    });
  }

  function prNodeHtml(n, depth, colorOf) {
    const badges = [];
    if (n.reinforced && n.parentId) badges.push('<span class="badge shield">已加固</span>');
    if (n.survivedAsRoot) badges.push('<span class="badge shield">幸存根</span>');
    const classes = ['node'];
    if (!n.ownerId) classes.push('start');
    if (prSession.pendingChallengeId === n.id) classes.push('pending');
    if (prSession.scenario.mode === 'protect' && prReinforceMode &&
        n.ownerId === WTPractice.YOU && n.parentId && !n.reinforced &&
        prSession.apLeft > 0 && !prSession.finished) classes.push('reinforced-target');
    const ownerName = n.ownerId === WTPractice.YOU ? '你' : '对手';
    const meta = n.ownerId
      ? `${ownerName} · ${WTPractice.relationName(n.relation)} · ${esc(n.reason || '')}`
      : '起始词';
    return `<div class="${classes.join(' ')}" data-id="${n.id}"
      style="margin-left:${depth * 22}px; border-left-color:${colorOf(n.ownerId)}">
      <span class="word">${esc(n.word)}</span>
      <div class="meta">${meta}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`;
  }

  function prNodeClick(nodeId) {
    if (!prSession || prSession.finished) return;
    const sc = prSession.scenario;
    if (sc.mode === 'protect') {
      if (!prReinforceMode) return;
      const err = WTPractice.reinforce(prSession, nodeId);
      if (err) return toast(err);
      prReinforceMode = false;
      renderPracticeGame();
    } else if (sc.mode === 'cascade') {
      const err = WTPractice.selectChallenge(prSession, nodeId);
      if (err) return toast(err);
      renderPracticeGame();
    }
  }

  function renderPracticeResult() {
    const box = $('pr-result');
    const r = prSession.result;
    if (!r) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const deltaHtml = (s) => {
      const d = s.after - s.before;
      const cls = d < 0 ? 'delta-down' : d > 0 ? 'delta-up' : '';
      const txt = d === 0 ? '不变' : `${d > 0 ? '+' : ''}${d}`;
      return `<span><span class="dot" style="background:${s.name === '你' ? WTPractice.PLAYERS[0].color : WTPractice.PLAYERS[1].color}"></span>
        ${esc(s.name)}：${s.before} → ${s.after} 分 <span class="${cls}">(${txt})</span></span>`;
    };
    box.className = `card result ${r.passed ? 'pass' : 'fail'}`;
    box.classList.remove('hidden');
    box.innerHTML = `<h3>${r.passed ? '✅ 通关！' : '还没达成最优，再想想'}</h3>
      <div class="pr-scores">${deltaHtml(r.scores.you)}${deltaHtml(r.scores.opp)}</div>
      <ol class="pr-lines">${r.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ol>`;
  }

  $('btn-practice').onclick = () => { renderPracticeList(); showScreen('practice'); };
  $('btn-practice-back').onclick = () => showScreen('home');
  $('btn-practice-exit').onclick = () => {
    prSession = null;
    renderPracticeList();
    showScreen('practice');
  };

  $('btn-pr-play').onclick = () => {
    if (!prSession || prSession.finished) return;
    const sc = prSession.scenario;
    $('pr-pick-list').innerHTML = sc.palette.map(m => {
      const used = prSession.nodes.some(n => n.id === m.id);
      const unlocked = prSession.nodes.some(n => n.id === m.parent);
      const locked = used || !unlocked;
      return `<li class="${locked ? 'locked' : ''}" data-move="${m.id}">
        <span class="pk-word">「${esc(m.word)}」</span> 接到「${esc(WTPractice.parentWord(sc, m.parent))}」后面
        <div class="pk-meta">${WTPractice.relationName(m.relation)} · ${esc(m.reason)}${used ? ' · 已在场上' : unlocked ? '' : ' · 前置词还没接上'}</div>
      </li>`;
    }).join('');
    $('pr-pick-list').querySelectorAll('[data-move]').forEach(li => {
      li.onclick = () => {
        if (li.classList.contains('locked')) return;
        const err = WTPractice.playWord(prSession, li.dataset.move);
        if (err) { toast(err); return; }
        closeDialog('dlg-practice-pick');
        renderPracticeGame();
      };
    });
    openDialog('dlg-practice-pick');
  };

  $('btn-pr-reinforce').onclick = () => {
    if (!prSession || prSession.finished) return;
    prReinforceMode = !prReinforceMode;
    if (prReinforceMode) toast('点击你的一条未加固连接进行加固');
    renderPracticeGame();
  };

  $('btn-pr-submit').onclick = () => {
    if (!prSession || prSession.finished) return;
    prReinforceMode = false;
    const r = WTPractice.submit(prSession);
    if (typeof r === 'string') { toast(r); return; }
    if (r.passed) {
      store.markPracticeDone(prSession.scenario.id);
      toast('通关！进度已保存在本浏览器');
    }
    renderPracticeGame();
  };

  $('btn-pr-reset').onclick = () => {
    if (!prSession) return;
    WTPractice.resetSession(prSession);
    prReinforceMode = false;
    renderPracticeGame();
  };

  // ---------- 个人收藏本（纯本地，不经过服务器） ----------

  function renderFavStats() {
    const s = WTFav.stats(store.favorites);
    $('fav-stats').innerHTML =
      `<span>共 ${s.total} 条</span>
       <span class="fav-known">已记住 ${s.known}</span>
       <span class="fav-need">还要复习 ${s.needReview}</span>
       <span class="fav-fresh">未复习 ${s.fresh}</span>`;
  }

  // 重建关系筛选下拉；只在可选项真正变化时重写，避免搜索打字时下拉被重建
  function renderFavFilterOptions() {
    const sel = $('fav-relation-filter');
    const rels = WTFav.usedRelations(store.favorites);
    const wantIds = ['', ...rels.map(r => r.id)];
    const haveIds = [...sel.options].map(o => o.value);
    const same = wantIds.length === haveIds.length && wantIds.every((id, i) => id === haveIds[i]);
    if (same) return;
    sel.innerHTML = '<option value="">全部关系</option>' +
      rels.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
    sel.value = rels.some(r => r.id === favRelation) ? favRelation : '';
    favRelation = sel.value;
  }

  function renderFavList() {
    renderFavFilterOptions();
    renderFavStats();
    const list = WTFav.filter(store.favorites, { keyword: favKeyword, relation: favRelation });
    const ul = $('fav-list');
    $('fav-empty').classList.toggle('hidden', store.favorites.length > 0);
    if (!list.length) {
      ul.innerHTML = store.favorites.length
        ? '<li class="fav-none">没有符合条件的收藏</li>' : '';
      return;
    }
    const statusBadge = (e) =>
      e.status === 'known' ? '<span class="badge fav-known-b">记住了</span>'
      : e.status === 'needReview' ? '<span class="badge fav-need-b">还要复习</span>'
      : '<span class="badge">未复习</span>';
    ul.innerHTML = list.map(e => `
      <li class="fav-item" data-key="${esc(e.key)}">
        <div class="fav-pair">
          <b>${esc(e.front)}</b>
          <span class="fav-arrow">—<span class="badge shield">${esc(e.relationName)}</span>→</span>
          <b>${esc(e.back)}</b>
          ${statusBadge(e)}
        </div>
        <div class="fav-reason">${esc(e.reason)}</div>
        <div class="fav-meta">来源房间 <span class="h-code">${esc(e.roomCode || '—')}</span>
          · 收藏于 ${fmtDate(e.savedAt)}</div>
        <textarea class="fav-note" rows="2" placeholder="补充你的笔记…">${esc(e.note)}</textarea>
        <div class="row fav-ops">
          <button class="link fav-save-note">保存笔记</button>
          <button class="link fav-del danger-link">删除收藏</button>
        </div>
      </li>`).join('');
    ul.querySelectorAll('.fav-item').forEach(li => {
      const key = li.dataset.key;
      li.querySelector('.fav-save-note').onclick = () => {
        const note = li.querySelector('.fav-note').value;
        store.favorites = WTFav.updateNote(store.favorites, key, note);
        toast('笔记已保存');
      };
      li.querySelector('.fav-del').onclick = () => {
        if (!confirm('删除这条收藏？相关复习记录会一并移除。')) return;
        store.favorites = WTFav.remove(store.favorites, key);
        renderFavList();
      };
    });
  }

  function openFav() {
    favKeyword = $('fav-search').value = '';
    renderFavList();
    showScreen('fav');
  }

  $('btn-fav-home').onclick = openFav;
  $('btn-fav-back').onclick = () => showScreen('home');
  $('fav-search').addEventListener('input', (e) => {
    favKeyword = e.target.value;
    renderFavList();
  });
  $('fav-relation-filter').onchange = (e) => {
    favRelation = e.target.value;
    renderFavList();
  };
  $('btn-fav-review').onclick = startReviewFlow;

  // ---------- 复习模式 ----------

  function startReviewFlow() {
    // 进入复习时以当前筛选结果为复习范围（默认全部）
    const pool = WTFav.filter(store.favorites, { keyword: favKeyword, relation: favRelation });
    reviewSession = WTFav.startReview(pool);
    if (!reviewSession) return toast('暂无可复习的收藏');
    showScreen('review');
    renderReview();
  }

  function renderReview() {
    const s = reviewSession;
    if (!s) return;
    const p = WTFav.progress(s);
    $('review-progress').textContent = `第 ${Math.min(p.done + 1, p.total)} / ${p.total} 张`;
    const finishedBox = $('review-finished');
    const cardBox = $('review-card-box');
    if (s.finished) {
      finishedBox.classList.remove('hidden');
      cardBox.classList.add('hidden');
      $('review-summary').textContent =
        `本轮共复习 ${p.total} 张，其中 ${p.needReview} 张标记为「还要复习」，下一轮会优先出现。`;
      return;
    }
    finishedBox.classList.add('hidden');
    cardBox.classList.remove('hidden');
    const e = WTFav.current(s);
    $('review-front-word').textContent = e.front;
    $('review-relation').textContent = e.relationName;
    $('review-back-word').textContent = e.back;
    $('review-reason').textContent = e.reason;
    $('review-source').textContent = `来源房间 ${e.roomCode || '—'}`;
    $('review-note-box').innerHTML = e.note
      ? `<div class="hint">我的笔记</div><p class="fav-note-view">${esc(e.note)}</p>` : '';
    $('review-back').classList.toggle('hidden', !s.revealed);
    $('btn-reveal').classList.toggle('hidden', s.revealed);
    $('btn-known').classList.toggle('hidden', !s.revealed);
    $('btn-need-review').classList.toggle('hidden', !s.revealed);
  }

  $('btn-review-exit').onclick = () => { reviewSession = null; renderFavList(); showScreen('fav'); };
  $('btn-review-to-fav').onclick = () => { reviewSession = null; renderFavList(); showScreen('fav'); };
  $('btn-review-again').onclick = startReviewFlow;
  $('btn-reveal').onclick = () => { reviewSession = WTFav.reveal(reviewSession); renderReview(); };
  $('btn-known').onclick = () => applyReviewMark('known');
  $('btn-need-review').onclick = () => applyReviewMark('needReview');

  // 标记当前卡片，并把结果写回完整收藏（按 key 匹配，不丢未参与本轮的条目）
  function applyReviewMark(verdict) {
    if (!reviewSession) return;
    const { session, entries } = WTFav.mark(reviewSession, store.favorites, verdict);
    reviewSession = session;
    store.favorites = entries;
    renderReview();
  }

  // ---------- 我的词包（纯本地管理；大厅选用时才把内容发给服务器） ----------

  let editingPackId = null; // null=编辑器关闭；''=新建；否则为正在编辑的词包 id

  function openPacks() {
    closePackEditor();
    renderPacks();
    showScreen('packs');
  }

  function renderPacks() {
    const packs = store.packs;
    $('pack-empty').classList.toggle('hidden', packs.length > 0);
    $('pack-list').innerHTML = packs.map(p => `
      <li>
        <div>
          <div class="pl-title">${esc(p.name)} <span class="badge shield">${p.words.length} 词</span></div>
          <div class="pl-sub">${p.theme ? esc(p.theme) : '（无主题说明）'}</div>
          <div class="pl-sub">候选词：${p.words.slice(0, 8).map(esc).join('、')}${p.words.length > 8 ? ' …' : ''}</div>
        </div>
        <div class="row">
          <button class="link" data-pack-edit="${p.id}">编辑</button>
          <button class="link danger-link" data-pack-del="${p.id}">删除</button>
        </div>
      </li>`).join('');
    $('pack-list').querySelectorAll('[data-pack-edit]').forEach(btn => {
      btn.onclick = () => openPackEditor(btn.dataset.packEdit);
    });
    $('pack-list').querySelectorAll('[data-pack-del]').forEach(btn => {
      btn.onclick = () => {
        const p = WTPacks.find(store.packs, btn.dataset.packDel);
        if (!p) return;
        if (!confirm(`删除词包「${p.name}」？已选用它的房间不受影响（房间里是快照）。`)) return;
        store.packs = WTPacks.remove(store.packs, p.id);
        if (editingPackId === p.id) closePackEditor();
        renderPacks();
        toast('词包已删除');
      };
    });
  }

  function clearPackErrors() {
    for (const id of ['err-pack-name', 'err-pack-theme', 'err-pack-words', 'err-pack-general']) {
      $(id).textContent = '';
    }
    for (const id of ['pack-name', 'pack-theme', 'pack-words']) $(id).classList.remove('invalid');
  }

  // id 为 '' 时新建；否则编辑对应词包并回填
  function openPackEditor(id) {
    const p = id ? WTPacks.find(store.packs, id) : null;
    editingPackId = id || '';
    $('pack-editor-title').textContent = p ? '编辑词包' : '新建词包';
    $('pack-name').value = p ? p.name : '';
    $('pack-theme').value = p ? p.theme : '';
    $('pack-words').value = p ? p.words.join('\n') : '';
    clearPackErrors();
    $('pack-editor').classList.remove('hidden');
  }

  function closePackEditor() {
    editingPackId = null;
    $('pack-editor').classList.add('hidden');
  }

  $('btn-packs-home').onclick = openPacks;
  $('btn-packs-back').onclick = () => showScreen('home');
  $('btn-pack-new').onclick = () => {
    if ($('pack-editor').classList.contains('hidden')) openPackEditor('');
    else closePackEditor();
  };
  $('btn-pack-cancel').onclick = closePackEditor;
  $('btn-pack-save').onclick = () => {
    clearPackErrors();
    const { errors, pack } = WTPacks.validatePack({
      name: $('pack-name').value,
      theme: $('pack-theme').value,
      wordsText: $('pack-words').value,
    });
    for (const [key, msg] of Object.entries(errors)) {
      $(`err-pack-${key}`).textContent = msg;
      $(`pack-${key}`).classList.add('invalid');
    }
    if (Object.keys(errors).length > 0) return;
    const wasEditing = !!editingPackId;
    const { packs, error } = WTPacks.upsert(store.packs, {
      ...pack, id: editingPackId || WTPacks.makeId(), updatedAt: Date.now(),
    });
    if (error) { $('err-pack-general').textContent = error; return; }
    store.packs = packs;
    closePackEditor();
    renderPacks();
    toast(wasEditing ? '词包已保存' : '词包已创建，可在大厅选用');
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 初始：首页按钮先置为"连接中"，onopen 后可用
  updateHomeConnState();
  connect();

  // 测试钩子：仅供 test/client.test.js 的 DOM/WS 桩驱动内部状态，生产环境无消费者
  if (typeof globalThis !== 'undefined' && globalThis.__WT_TEST) {
    globalThis.__WTClient = {
      get connStatus() { return connStatus; },
      get state() { return state; },
      get reconnectAttempts() { return reconnectAttempts; },
      get stopRetry() { return stopRetry; },
      get ws() { return ws; },
      connect, goHomeFromFailure, reenterRoom,
    };
  }
})();
