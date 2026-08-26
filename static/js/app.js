/* ============================================================
 * AI出题读书法 - 前端主逻辑
 * 架构：纯前端 + 本地存储（IndexedDB）+ DeepSeek API 直连
 * 数据流：粘贴书摘 → AI出题 → 逐题刷 → 结果存本地 → 离线可刷
 * ============================================================ */
"use strict";

/* ---------------- 工具函数 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------- 本地存储（IndexedDB） ----------------
 * 数据全部存在浏览器本地，离线可读。
 * 库：quiz_app
 * 表：settings  {key, value}          设置（API Key/出题数量/顺序）
 *      sets      {id, title, source, questions[], createdAt, updatedAt}
 *      records   {id, setId, qIndex, answer, correct, supplement, ts}  每题记录
 * -------------------------------------------------------- */
const DB_NAME = "quiz_app";
const DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("sets")) db.createObjectStore("sets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("records")) {
        const st = db.createObjectStore("records", { keyPath: "id" });
        st.createIndex("setId", "setId", { unique: false });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function txStore(store, mode = "readonly") {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

async function dbGet(store, key) {
  const s = await txStore(store);
  return new Promise((res) => { const r = s.get(key); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });
}
async function dbPut(store, val) {
  const s = await txStore(store, "readwrite");
  return new Promise((res, rej) => { const r = s.put(val); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}
async function dbAll(store) {
  const s = await txStore(store);
  return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function dbDelete(store, key) {
  const s = await txStore(store, "readwrite");
  return new Promise((res, rej) => { const r = s.delete(key); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}
async function dbClear(store) {
  const s = await txStore(store, "readwrite");
  return new Promise((res, rej) => { const r = s.clear(); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); });
}

/* ---------------- 设置读写 ---------------- */
const DEFAULT_SETTINGS = { apiKey: "", count: 10, order: "sequence", difficulty: "auto", types: "choice" };

async function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  const all = await dbAll("settings");
  for (const item of all) s[item.key] = item.value;
  return s;
}
async function saveSetting(key, value) {
  await dbPut("settings", { key, value });
}
async function loadPrompt() {
  /* 出题规则：优先从本地(IndexedDB)读（可改可存档可回滚），没有则用内置默认。
   * 纯前端架构：不依赖服务器，部署到静态托管(GitHub Pages)也能用。 */
  const stored = await dbGet("settings", "prompt");
  if (stored && stored.value && stored.value.trim()) return stored.value.trim();
  const builtin = `你是"AI出题读书法"的出题引擎。请阅读用户提供的书摘文本，生成一套选择题。

出题规则（必须全部遵守）：
1. 严禁考查事实细节：不许出"XX年""人名""地名""具体数字"这类题。
2. 必须出应用场景题：题干是一个真实生活/工作场景，让用户选择该场景下该怎么做。
3. 错误选项必须是常见误区：普通人第一反应可能选错的真实做法，或书中明确反对的观点。
4. 解析说明"为什么"：正确项为什么对（对应书中哪条原则），错误项为什么错。
5. 难度分层：40%简单（直接对应原文）、30%中等（需推理）、30%困难（需综合多点）。
6. 每题4个选项（A/B/C/D），只有一个正确答案。

只输出一个 JSON 数组，不要输出任何其他文字。格式：
[
  {"question":"题干","options":["A","B","C","D"],"answer":"B","explanation":"解析","difficulty":"简单"}
]`;
  return builtin;
}

/* ---------------- 视图切换 ---------------- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  window.scrollTo(0, 0);
}

/* ---------------- 状态 ---------------- */
const state = {
  settings: null,
  currentSet: null,      // 当前刷的题集
  quizOrder: [],         // 刷题顺序（数组，元素是 {qIndex, q}）
  quizPos: 0,
  selected: null,        // 当前选的选项字母
  answered: false,
  supplement: "",
  wrongIndexes: new Set(), // 本套错题索引
};

/* ---------------- 首页：上传 txt 文件 ---------------- */
async function onUploadTxt(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const nameEl = $("#upload-name");
  if (file.size > 5 * 1024 * 1024) {
    nameEl.textContent = "⚠️ 文件太大（超过 5MB），请先拆分";
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    let text = "";
    // 优先按 UTF-8 解，失败则按 GBK 解（国内 txt 常见编码）
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch (e) {
      text = new TextDecoder("gbk").decode(buf);
    }
    if (!text.trim()) {
      nameEl.textContent = "⚠️ 文件是空的";
      return;
    }
    $("#input-text").value = text.trim();
    nameEl.textContent = `✅ 已读入「${file.name}」(${(text.length / 1000).toFixed(0)} 千字)，可以生成题目了`;
    setStatus("gen-status", "", "");
    $("#gen-status").innerHTML = "";
  } catch (err) {
    nameEl.textContent = "⚠️ 读取失败：" + err.message;
  } finally {
    e.target.value = "";  // 允许重复选同一文件
  }
}

/* ---------------- 首页：生成题目 ---------------- */
async function onGenerate() {
  const text = $("#input-text").value.trim();
  if (text.length < 20) {
    setStatus("gen-status", "请先粘贴一段书摘（至少 20 个字）", "error");
    return;
  }
  const settings = state.settings;
  if (!settings.apiKey) {
    setStatus("gen-status", "还没有设置 API Key —— 点下方 ⚙️ 设置，填入你的 DeepSeek Key", "error");
    return;
  }
  $("#btn-generate").disabled = true;
  setStatus("gen-status", `<span class="loading-spinner"></span>AI 正在出题，大约需要 10-30 秒……`, "loading");
  try {
    const prompt = await loadPrompt();
    const questions = await callAI(settings.apiKey, prompt, text, settings.count, settings.difficulty, settings.types);
    if (!questions || !questions.length) throw new Error("AI 返回了空结果");
    const setObj = {
      id: uid(),
      title: makeTitle(text),
      source: text,
      questions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbPut("sets", setObj);
    $("#input-text").value = "";
    setStatus("gen-status", `<span class="ok">✅ 出好了 ${questions.length} 道题，开始刷吧！</span>`, "ok");
    renderLastSet();
    showView("quiz");
    startQuiz(setObj, "sequence");
  } catch (e) {
    setStatus("gen-status", `<span class="error">出题失败：${esc(e.message)}<br>检查：① API Key 是否正确 ② 网络是否通 ③ 文本是否太短</span>`, "error");
  } finally {
    $("#btn-generate").disabled = false;
  }
}

function makeTitle(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

/* ---------------- 调用 DeepSeek API ---------------- */
async function callAI(apiKey, prompt, text, count, difficulty, types) {
  const diffText = {
    auto: "难度由你根据文本内容判断，总体保持适中（先易后难）",
    easy: "整体偏简单：大部分题直接对应原文观点，少部分需简单推理",
    mixed: "难度适中：40%简单、30%中等、30%困难，先易后难",
    hard: "整体偏难：大部分题需要综合多个点推理，少部分直接对应原文",
  }[difficulty] || "难度由你根据文本内容判断，总体保持适中（先易后难）";
  const typeText = types === "choice-judge"
    ? "题型：大部分为单选题（4选1），可以穿插少量判断题（对/错）"
    : "题型：全部为单选题（4个选项 A/B/C/D，只有一个正确答案）";
  const body = {
    model: "deepseek-chat",
    temperature: 0.7,
    max_tokens: 4000,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `请根据以下文本出 ${count} 道题。\n${diffText}\n${typeText}\n\n文本内容：\n${text.slice(0, 8000)}` },
    ],
  };
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = `API 错误 ${resp.status}`;
    try {
      const err = await resp.json();
      msg = err?.error?.message || msg;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseQuestions(content);
}

/* AI 点评：针对"我的选择 + 我的感想"给反馈（判断理解对不对、哪里偏了） */
async function callAIFeedback(q, myAnswer, correct, supplement) {
  const settings = state.settings;
  if (!settings || !settings.apiKey) return Promise.reject(new Error("no key"));
  const options = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n");
  const userMsg = `题目：${q.question}\n选项：\n${options}\n正确答案：${q.answer}\n我的选择：${myAnswer}（${correct ? "答对" : "答错"}）\n我的想法/疑问：${supplement || "（未填写）"}\n\n请针对我的作答给一段简短点评（150字以内，中文）：我理解得对不对？哪里偏了？该怎么修正理解？不要复述解析。`;
  const body = {
    model: "deepseek-chat",
    temperature: 0.6,
    max_tokens: 400,
    messages: [
      { role: "system", content: "你是一位耐心的学习陪练，针对用户的选择和思考给针对性反馈，帮他把书里的方法真正用起来。语气鼓励、具体、不啰嗦。" },
      { role: "user", content: userMsg },
    ],
  };
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

/* 容错解析：AI 可能返回带 ```json 标记或前后多余文字 */
function parseQuestions(content) {  let text = content.trim();
  // 去掉 ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 找第一个 [ 到最后一个 ]
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error("AI 返回的不是题目列表");
  return arr
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2 && q.answer)
    .map((q) => {
      const options = q.options.slice(0, 4).map((o) => String(o).replace(/^[A-D][.、\s]+/, "").trim());
      // 答案规范化：A-D 字母，或判断题的 对/错/正确/错误/√/×/true/false
      let ansRaw = String(q.answer).trim().toUpperCase();
      // 只剥离"字母+标点"前缀（如 "B." / "B、"），保留纯字母答案本身
      ansRaw = ansRaw.replace(/^([A-D])[.、\s)]+$/, "$1");
      const judgeMap = { "对": "A", "正确": "A", "√": "A", "TRUE": "A", "是": "A", "错": "B", "错误": "B", "×": "B", "FALSE": "B", "否": "B", "X": "B" };
      let ans = judgeMap[ansRaw] || (ansRaw.match(/[A-D]/) || [""])[0];
      // 若答案不是 A-D 或不在选项集内，则丢弃该题
      if (!ans || ans >= String.fromCharCode(65 + options.length)) return null;
      return {
        question: String(q.question).trim(),
        options,
        answer: ans,
        explanation: String(q.explanation || "").trim(),
        difficulty: String(q.difficulty || "").trim(),
      };
    })
    .filter(Boolean);
}

/* ---------------- 刷题 ---------------- */
function startQuiz(setObj, orderType) {
  state.currentSet = setObj;
  state.quizPos = 0;
  state.selected = null;
  state.answered = false;
  state.supplement = "";
  state.wrongIndexes = new Set();

  // 按顺序规则构造刷题序列
  const idxs = [];
  if (orderType === "random") {
    for (let i = 0; i < setObj.questions.length; i++) idxs.push(i);
    shuffle(idxs);
  } else if (orderType === "wrong-first") {
    const wrongs = getWrongIndexes(setObj.id);
    const normals = [];
    for (let i = 0; i < setObj.questions.length; i++) {
      if (!wrongs.includes(i)) normals.push(i);
    }
    idxs.push(...wrongs, ...normals);
  } else {
    for (let i = 0; i < setObj.questions.length; i++) idxs.push(i);
  }
  state.quizOrder = idxs.map((i) => ({ qIndex: i, q: setObj.questions[i] }));
  renderQuiz();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function getWrongIndexes(setId) {
  /* 从本地记录里找这套题答错的索引 */
  const cached = wrongCache.get(setId);
  return cached ? [...cached] : [];
}
const wrongCache = new Map();

function renderQuiz() {
  const order = state.quizOrder;
  const total = order.length;
  if (state.quizPos >= total) { renderDone(); return; }

  const item = order[state.quizPos];
  const q = item.q;
  $("#quiz-progress").textContent = `第 ${state.quizPos + 1}/${total} 题`;
  updateScore();
  $("#quiz-question").textContent = q.question;
  $("#quiz-done").style.display = "none";
  $("#btn-submit").style.display = "block";
  $("#btn-next").style.display = "none";
  $("#quiz-feedback").style.display = "none";
  $("#feedback-ai").style.display = "none";
  $("#feedback-ai").innerHTML = "";
  $("#supplement-text").value = "";
  state.selected = null;
  state.answered = false;

  const box = $("#quiz-options");
  box.innerHTML = "";
  q.options.forEach((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    const btn = document.createElement("button");
    btn.className = "option-btn";
    btn.innerHTML = `<span class="opt-letter">${letter}</span><span>${esc(opt)}</span>`;
    btn.onclick = () => {
      if (state.answered) return;
      state.selected = letter;
      $$(".option-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
    box.appendChild(btn);
  });
}

function updateScore() {
  /* 统计这套题里 对/错 计数（基于本地记录，每题取最新一条） */
  const set = state.currentSet;
  const { correct, wrong } = calcSetStats(set.id, set.questions.length);
  $("#quiz-score").textContent = `对 ${correct} · 错 ${wrong}`;
}
const scoreCache = new Map();

/* 统计辅助：一套题的最新作答统计（每题取最新一条记录，返回 {correct, wrong, answered}） */
function calcSetStats(setId, questionCount) {
  const map = scoreCache.get(setId) || new Map();
  let correct = 0, wrong = 0;
  for (const r of map.values()) {
    if (r.correct) correct++; else wrong++;
  }
  const answered = correct + wrong;
  return { correct, wrong, answered, total: questionCount || map.size };
}

async function onSubmit() {
  if (state.answered) return;
  if (!state.selected) {
    setStatus("quiz-feedback", "先点一个选项再提交～", "error");
    return;
  }
  state.answered = true;
  const item = state.quizOrder[state.quizPos];
  const q = item.q;
  const correct = state.selected === q.answer;
  if (!correct) state.wrongIndexes.add(item.qIndex);

  // 界面反馈
  const feedback = $("#quiz-feedback");
  const verdict = $("#feedback-verdict");
  verdict.textContent = correct ? "✅ 答对了！" : `❌ 答错了，正确答案是 ${q.answer}`;
  verdict.className = "verdict " + (correct ? "correct" : "wrong");
  $("#feedback-explanation").textContent = q.explanation || "（这题没有解析）";
  feedback.style.display = "block";

  // 选项着色
  $$(".option-btn").forEach((b) => {
    b.classList.add("disabled");
    const letter = b.querySelector(".opt-letter").textContent;
    if (letter === q.answer) b.classList.add("correct");
    else if (letter === state.selected) b.classList.add("wrong");
  });

  // 存记录（实时保存，每答一题存一次）
  const supplement = $("#supplement-text").value.trim();
  const mySetId = state.currentSet.id;
  const myQIndex = item.qIndex;
  const rec = {
    id: uid(),
    setId: state.currentSet.id,
    qIndex: myQIndex,
    answer: state.selected,
    correct,
    supplement,
    ts: Date.now(),
  };
  await saveRecord(rec);

  // 更新计数（saveRecord 已更新缓存）
  updateScore();

  $("#btn-submit").style.display = "none";
  $("#btn-next").style.display = "block";

  // AI 点评：写了感想 或 答错时，针对"我的选择+我的想法"给针对性反馈
  if (supplement || !correct) {
    // 占位提示（loading 态），失败时显示离线提示
    const box = $("#feedback-ai");
    if (box) {
      box.innerHTML = `<div class="ai-feedback"><div class="ai-fb-title">🤖 AI 点评</div><div class="ai-fb-body">生成中…</div></div>`;
      box.style.display = "block";
    }
    callAIFeedback(q, state.selected, correct, supplement)
      .then(async (comment) => {
        // 防串题：若用户已切到别的题集/题号，不写入
        const cur = state.currentSet;
        if (!cur || cur.id !== mySetId || state.quizOrder[state.quizPos]?.qIndex !== myQIndex) return;
        const box2 = $("#feedback-ai");
        if (box2) {
          box2.innerHTML = `<div class="ai-feedback"><div class="ai-fb-title">🤖 AI 点评</div><div class="ai-fb-body">${esc(comment)}</div></div>`;
          box2.style.display = "block";
        }
        // 点评入库（records 加 aiComment），明细里可回看
        try {
          const all = await dbAll("records");
          const target = all.find((r) => r.setId === mySetId && r.qIndex === myQIndex && !r.aiComment);
          if (target) {
            target.aiComment = comment;
            await dbPut("records", target);
            scoreCache.delete(state.currentSet.id);
            wrongCache.delete(state.currentSet.id);
            await loadSetCache(state.currentSet.id);
          }
        } catch (e) { /* 入库失败不打断 */ }
      })
      .catch(() => {
        const box3 = $("#feedback-ai");
        if (box3) {
          box3.innerHTML = `<div class="ai-feedback"><div class="ai-fb-title">🤖 AI 点评</div><div class="ai-fb-body" style="color:#888">⚠️ 当前无法获取 AI 点评（可能离线或未设置 Key），答案和解析已保存。</div></div>`;
          box3.style.display = "block";
        }
      });
  }
}

async function saveRecord(rec) {
  // 先删掉该题的历史记录，保证每题只有最新一条（避免同题多记录导致统计错乱）
  try {
    const all = await dbAll("records");
    for (const r of all) {
      if (r.setId === rec.setId && r.qIndex === rec.qIndex && r.id !== rec.id) {
        await dbDelete("records", r.id);
      }
    }
  } catch (e) { /* 删除失败不阻塞保存 */ }
  await dbPut("records", rec);
  // 更新内存缓存：记录按 题号→最新一条 维护
  const map = scoreCache.get(rec.setId) || new Map();
  map.set(rec.qIndex, rec);
  scoreCache.set(rec.setId, map);
  // 错题集合：答对移除，答错加入（保证"只刷错题"只含当前未掌握题）
  const w = wrongCache.get(rec.setId) || new Set();
  if (rec.correct) w.delete(rec.qIndex);
  else w.add(rec.qIndex);
  wrongCache.set(rec.setId, w);
}

async function onNext() {
  state.quizPos++;
  renderQuiz();
}

function renderDone() {
  $("#quiz-progress").textContent = "完成！";
  const { correct, wrong, answered } = calcSetStats(state.currentSet.id, state.currentSet.questions.length);
  $("#done-stats").textContent = `已刷 ${answered}/${state.currentSet.questions.length} 题 · 对 ${correct} · 错 ${wrong}`;
  $("#quiz-feedback").style.display = "none";
  $("#btn-submit").style.display = "none";
  $("#btn-next").style.display = "none";
  $("#quiz-done").style.display = "block";
}

/* ---------------- 数据页 ---------------- */
async function renderDataPage() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");

  // 每套题的最新作答统计（每题取最新一条记录）
  let totalAnswered = 0, totalCorrect = 0, totalWrong = 0;
  const perSet = {};   // setId -> {correct, wrong, answered}
  for (const s of sets) {
    const latest = new Map();
    for (const r of records) if (r.setId === s.id) latest.set(r.qIndex, r);
    let c = 0, w = 0;
    for (const r of latest.values()) { if (r.correct) c++; else w++; }
    perSet[s.id] = { correct: c, wrong: w, answered: c + w };
    totalAnswered += c + w; totalCorrect += c; totalWrong += w;
  }
  const totalQ = sets.reduce((n, s) => n + s.questions.length, 0);

  $("#data-stats").innerHTML = `
    <div class="stat-chip"><div class="num">${sets.length}</div><div class="label">题集</div></div>
    <div class="stat-chip"><div class="num">${totalQ}</div><div class="label">总题数</div></div>
    <div class="stat-chip"><div class="num">${totalAnswered}</div><div class="label">已答题</div></div>
    <div class="stat-chip"><div class="num">${totalWrong}</div><div class="label">当前错题</div></div>
  `;

  // 题集列表（倒序）
  const list = $("#set-list");
  list.innerHTML = "";
  [...sets].sort((a, b) => b.createdAt - a.createdAt).forEach((s) => {
    const st = perSet[s.id] || { correct: 0, wrong: 0, answered: 0 };
    const item = document.createElement("div");
    item.className = "set-item";
    item.innerHTML = `
      <div class="set-title">${esc(s.title)}</div>
      <div class="set-meta">${s.questions.length} 题 · 已答 ${st.answered} · 错 ${st.wrong} · ${new Date(s.createdAt).toLocaleDateString("zh-CN")}</div>
      <div class="set-actions">
        <button class="btn-secondary" data-act="practice" data-id="${s.id}">▶️ 刷题</button>
        <button class="btn-secondary" data-act="wrong" data-id="${s.id}">错题</button>
        <button class="btn-secondary" data-act="detail" data-id="${s.id}">📋 答题明细</button>
        <button class="btn-secondary" data-act="delete" data-id="${s.id}">🗑 删除</button>
      </div>
    `;
    item.querySelector('[data-act="detail"]').onclick = async () => {
      await showSetDetail(s, records.filter((r) => r.setId === s.id));
    };
    item.querySelector('[data-act="practice"]').onclick = async () => {
      await loadSetCache(s.id);
      showView("quiz");
      startQuiz(s, state.settings.order);
    };
    item.querySelector('[data-act="wrong"]').onclick = async () => {
      await loadSetCache(s.id);
      showView("quiz");
      startQuiz(s, "wrong-first");
    };
    item.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`确定删除这套题？\n「${s.title}」\n（答题记录也会一起删）`)) return;
      await dbDelete("sets", s.id);
      // 删对应记录
      const recs2 = await dbAll("records");
      for (const r of recs2) if (r.setId === s.id) await dbDelete("records", r.id);
      scoreCache.delete(s.id); wrongCache.delete(s.id);
      renderDataPage();
    };
    list.appendChild(item);
  });
}

/* 答题明细：展示这套题每道题的作答记录（对错/选择/感想/时间/AI点评） */
async function showSetDetail(set, recs) {
  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  // 每题取最新一条记录
  const latest = new Map();
  for (const r of recs) latest.set(r.qIndex, r);
  const rows = set.questions.map((q, i) => {
    const r = latest.get(i);
    const time = r ? new Date(r.ts).toLocaleString("zh-CN") : "";
    const verdict = r ? (r.correct ? '<span class="dv-ok">✅ 对</span>' : '<span class="dv-no">❌ 错</span>') : '<span class="dv-na">未答</span>';
    const optText = (r && q.options && r.answer) ? (q.options[r.answer.charCodeAt(0) - 65] || "") : "";
    const myAns = r ? `<span class="dv-ans">我的选择：${r.answer}${optText ? " · " + esc(optText) : ""}</span>` : "";
    const sup = r && r.supplement ? `<div class="dv-sup">💬 ${esc(r.supplement)}</div>` : "";
    const ai = r && r.aiComment ? `<div class="dv-ai">🤖 ${esc(r.aiComment)}</div>` : "";
    return `<div class="dv-item">
      <div class="dv-head">${verdict} <span class="dv-q">${i + 1}. ${esc(q.question)}</span> ${myAns} <span class="dv-time">${time}</span></div>
      ${sup}
      ${ai}
      ${r ? `<div class="dv-exp"><span class="dv-correct">正确答案：${esc(q.answer)}</span> — ${esc(q.explanation || "")}</div>` : ""}
    </div>`;
  }).join("");
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-title">📋 答题明细 — ${esc(set.title)}</div>
      <div class="detail-body">${rows || '<p class="hint">这套题还没有答题记录</p>'}</div>
      <button class="btn-primary btn-big" id="detail-close">关闭</button>
    </div>
  `;
  overlay.querySelector("#detail-close").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}

async function loadSetCache(setId) {
  const recs = await dbAll("records");
  const mine = recs.filter((r) => r.setId === setId);
  // 每题取最新一条
  const map = new Map();
  for (const r of mine) map.set(r.qIndex, r);
  scoreCache.set(setId, map);
  // 错题集：最新一条是答错的
  const w = new Set();
  for (const r of map.values()) if (!r.correct) w.add(r.qIndex);
  wrongCache.set(setId, w);
}

/* ---------------- 导出/导入 ---------------- */
async function onExport() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  const settings = await loadSettings();
  const data = {
    app: "AI出题读书法",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { count: settings.count, order: settings.order },
    sets,
    records,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `AI出题读书法_备份_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

async function onImport(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.app !== "AI出题读书法") throw new Error("不是本应用的备份文件");
    // 导入题集（保留原有，id 冲突则覆盖）
    for (const s of data.sets || []) await dbPut("sets", s);
    for (const r of data.records || []) await dbPut("records", r);
    if (data.settings) {
      if (data.settings.count) await saveSetting("count", data.settings.count);
      if (data.settings.order) await saveSetting("order", data.settings.order);
    }
    alert(`导入成功：${(data.sets || []).length} 套题，${(data.records || []).length} 条记录`);
    renderDataPage();
  } catch (e) {
    alert("导入失败：" + e.message);
  }
}

/* ---------------- 设置页 ---------------- */
async function renderSettings() {
  $("#set-apikey").value = state.settings.apiKey || "";
  $("#count-value").textContent = state.settings.count;
  $$("#seg-order .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.order === state.settings.order));
  $$("#seg-difficulty .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.difficulty === state.settings.difficulty));
  $$("#seg-types .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.types === state.settings.types));
}

/* ---------------- 出题规则页（纯本地存储） ----------------
 * 数据模型（IndexedDB settings 表）：
 *   prompt         当前规则文本
 *   prompt_history [{file, time, content}]  历史版本数组（新→旧）
 * 纯前端实现：不依赖服务器，部署到静态托管(GitHub Pages)也能保存/回滚。
 * -------------------------------------------------------- */
async function renderPromptPage() {
  const content = await loadPrompt();
  $("#prompt-text").value = content;
  await renderPromptHistory();
}

async function renderPromptHistory() {
  const box = $("#prompt-history");
  box.innerHTML = "";
  const hist = await loadPromptHistory();
  if (!hist.length) { box.innerHTML = `<p class="hint">暂无历史版本</p>`; return; }
  for (const item of hist) {
    const div = document.createElement("div");
    div.className = "hist-item";
    div.innerHTML = `
      <span>${esc(item.file)} <span class="hist-time">${esc(item.time)}</span></span>
      <span>
        <button data-file="${esc(item.file)}">查看</button>
        <button data-file="${esc(item.file)}" data-restore="1">回滚到此</button>
      </span>
    `;
    div.onclick = async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const f = btn.dataset.file;
      const isRestore = btn.dataset.restore === "1";
      const item = hist.find((h) => h.file === f);
      if (!item) { $("#prompt-status").innerHTML = `<span class="error">找不到版本「${esc(f)}」</span>`; return; }
      if (isRestore) {
        if (!confirm(`回滚到 ${f} 的版本？当前版本会自动存档`)) return;
        await savePromptLocal(item.content);
        renderPromptPage();
      } else {
        $("#prompt-text").value = item.content;
        $("#prompt-status").innerHTML = `<span class="ok">已载入「${f}」的内容（未保存，点保存规则才生效）</span>`;
      }
    };
    box.appendChild(div);
  }
}

async function loadPromptHistory() {
  const st = await dbGet("settings", "prompt_history");
  return (st && Array.isArray(st.value)) ? st.value : [];
}

/* 保存规则（纯本地）：先把当前内容压入历史，再写新内容 */
async function savePromptLocal(content) {
  const newText = (content || "").trim();
  if (!newText) throw new Error("规则内容为空");
  const current = await loadPrompt();
  let hist = await loadPromptHistory();
  if (current.trim() && current.trim() !== newText) {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const file = `generate_${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}_v${hist.length + 1}.txt`;
    const time = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
    hist = [{ file, time, content: current }, ...hist];
  }
  await dbPut("settings", { key: "prompt_history", value: hist });
  await dbPut("settings", { key: "prompt", value: newText });
}

/* ---------------- 状态提示 ---------------- */
function setStatus(elId, html, type) {
  const el = $(`#${elId}`);
  if (!el) return;
  el.className = "status-area " + (type || "");
  el.innerHTML = html;
  if (elId === "quiz-feedback") el.style.display = "block";
}

/* ---------------- 最近一套 ---------------- */
async function renderLastSet() {
  const sets = await dbAll("sets");
  if (!sets.length) { $("#last-set").style.display = "none"; return; }
  const latest = sets.sort((a, b) => b.createdAt - a.createdAt)[0];
  await loadSetCache(latest.id);
  const { correct, wrong, answered } = calcSetStats(latest.id, latest.questions.length);
  $("#last-set-info").textContent = `「${latest.title}」· ${latest.questions.length} 题 · 已答 ${answered} · 错 ${wrong}`;
  $("#last-set").style.display = "block";
  $("#btn-continue").onclick = async () => {
    await loadSetCache(latest.id);
    showView("quiz");
    startQuiz(latest, state.settings.order);
  };
  $("#btn-review").onclick = async () => {
    await loadSetCache(latest.id);
    showView("quiz");
    startQuiz(latest, "wrong-first");
  };
}

/* ---------------- 联网状态 ---------------- */
function updateNetStatus() {
  const badge = $("#net-status");
  if (navigator.onLine) { badge.textContent = "● 在线"; badge.className = "net-badge online"; }
  else { badge.textContent = "● 离线（可刷已生成的题）"; badge.className = "net-badge offline"; }
}

/* ---------------- 初始化 ---------------- */
async function init() {
  await openDB();
  state.settings = await loadSettings();
  $("#set-apikey").value = state.settings.apiKey || "";
  $("#count-value").textContent = state.settings.count;
  $("#btn-count-minus").onclick = () => changeCount(-1);
  $("#btn-count-plus").onclick = () => changeCount(1);
  $("#btn-save-key").onclick = onSaveKey;
  $$("#seg-order .seg-btn").forEach((b) => b.onclick = () => {
    $$("#seg-order .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    saveSetting("order", b.dataset.order);
    state.settings.order = b.dataset.order;
  });
  $$("#seg-difficulty .seg-btn").forEach((b) => b.onclick = () => {
    $$("#seg-difficulty .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    saveSetting("difficulty", b.dataset.difficulty);
    state.settings.difficulty = b.dataset.difficulty;
  });
  $$("#seg-types .seg-btn").forEach((b) => b.onclick = () => {
    $$("#seg-types .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    saveSetting("types", b.dataset.types);
    state.settings.types = b.dataset.types;
  });
  $("#btn-generate").onclick = onGenerate;
  $("#btn-upload-txt").onclick = () => $("#upload-file").click();
  $("#upload-file").onchange = onUploadTxt;
  $("#btn-submit").onclick = onSubmit;
  $("#btn-next").onclick = onNext;
  $("#btn-restart").onclick = () => startQuiz(state.currentSet, "sequence");
  $("#btn-back-home").onclick = () => { showView("home"); renderLastSet(); };
  $("#btn-settings").onclick = () => { showView("settings"); renderSettings(); };
  $("#btn-data").onclick = () => { showView("data"); renderDataPage(); };
  $("#btn-prompt").onclick = () => { showView("prompt"); renderPromptPage(); };
  $("#btn-export").onclick = onExport;
  $("#btn-import").onclick = () => $("#import-file").click();
  $("#import-file").onchange = (e) => { if (e.target.files[0]) onImport(e.target.files[0]); e.target.value = ""; };
  $("#btn-save-prompt").onclick = onSavePrompt;
  $("#link-getkey").onclick = () => { window.open("https://platform.deepseek.com/api_keys", "_blank"); };

  // 底部导航
  $$(".tab").forEach((t) => t.onclick = () => {
    const v = t.dataset.view;
    if (v === "home") renderLastSet();
    if (v === "data") renderDataPage();
    if (v === "settings") renderSettings();
    if (v === "prompt") renderPromptPage();
    showView(v);
  });

  // 联网状态
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);
  updateNetStatus();

  // 首页最近一套
  renderLastSet();

  // 注册 Service Worker（离线能力）
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW 注册失败:", e));
  }
}

function changeCount(delta) {
  let n = state.settings.count + delta;
  n = Math.max(3, Math.min(50, n));
  state.settings.count = n;
  $("#count-value").textContent = n;
  saveSetting("count", n);
}

async function onSaveKey() {
  const key = $("#set-apikey").value.trim();
  if (!key) { setStatus("key-status", "Key 不能为空", "error"); return; }
  await saveSetting("apiKey", key);
  state.settings.apiKey = key;
  setStatus("key-status", `<span class="ok">✅ Key 已保存（只存在本机浏览器里）</span>`, "ok");
}

async function onSavePrompt() {
  const content = $("#prompt-text").value.trim();
  if (!content) { setStatus("prompt-status", "规则内容不能为空", "error"); return; }
  try {
    await savePromptLocal(content);
    setStatus("prompt-status", `<span class="ok">✅ 规则已保存，旧版本已自动存档</span>`, "ok");
    renderPromptHistory();
  } catch (e) {
    setStatus("prompt-status", `<span class="error">保存失败：${esc(e.message)}</span>`, "error");
  }
}

document.addEventListener("DOMContentLoaded", init);
