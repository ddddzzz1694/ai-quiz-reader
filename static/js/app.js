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
const DB_VER = 2;   // v2: 新增 books 表（多本书管理）
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
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("transfers")) {
        db.createObjectStore("transfers", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "id" });
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
const DEFAULT_SETTINGS = { apiKey: "", count: 10, order: "sequence", difficulty: "auto", types: "choice", feedbackMode: "now", dailyGoal: 0 };

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
  pendingFeedback: [],     // 统一点评模式：收集待点评的题目
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
  const goal = $("#input-goal").value.trim();  // 本次学习目的（可空）
  $("#btn-generate").disabled = true;
  setStatus("gen-status", `<span class="loading-spinner"></span>AI 正在判断该出多少题并出题，大约 10-40 秒……`, "loading");
  try {
    const prompt = await loadPrompt();
    const questions = await callAI(settings.apiKey, prompt, text, settings.count, settings.difficulty, settings.types, goal);
    if (!questions || !questions.length) throw new Error("AI 返回了空结果");
    const setObj = {
      id: uid(),
      title: makeTitle(text),
      source: text,
      goal,
      bookId: $("#book-select") ? $("#book-select").value : "",
      questions,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbPut("sets", setObj);
    $("#input-text").value = "";
    $("#input-goal").value = "";
    setStatus("gen-status", `<span class="ok">✅ AI 判断这套出 ${questions.length} 道题（覆盖文本核心${goal ? "，围绕你的目的" : ""}），开始刷吧！</span>`, "ok");
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
async function callAI(apiKey, prompt, text, count, difficulty, types, goal) {
  const diffText = {
    auto: "难度由你根据文本内容判断，总体保持适中（先易后难）",
    easy: "整体偏简单：大部分题直接对应原文观点，少部分需简单推理",
    mixed: "难度适中：40%简单、30%中等、30%困难，先易后难",
    hard: "整体偏难：大部分题需要综合多个点推理，少部分直接对应原文",
  }[difficulty] || "难度由你根据文本内容判断，总体保持适中（先易后难）";
  const typeText = types === "choice-judge"
    ? "题型：大部分为单选题（4选1），可以穿插少量判断题（对/错）"
    : "题型：全部为单选题（4个选项 A/B/C/D，只有一个正确答案）";
  // 目的描述：老板想达成什么（决定出题数量与侧重）
  const goalText = goal && goal.trim()
    ? `\n【本次学习目的】用户想通过这套题达到：${goal.trim()}。请围绕这个目的决定出题数量和侧重，不必拘泥于固定题数。`
    : "";
  const body = {
    model: "deepseek-chat",
    temperature: 0.7,
    max_tokens: 4000,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `请根据以下文本出 ${count} 道题（这是一个初始建议数，你可以根据内容重要性微调，最终以你判断为准）。\n${diffText}\n${typeText}${goalText}\n\n文本内容：\n${text.slice(0, 8000)}` },
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

/* 追问 AI：基于当前题目继续对话（记录存 IndexedDB chats 表） */
async function askAI(question, q, myAnswer, correct, supplement) {
  const settings = state.settings;
  if (!settings || !settings.apiKey) throw new Error("no key");
  const opts = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n");
  const body = {
    model: "deepseek-chat",
    temperature: 0.6,
    max_tokens: 800,
    messages: [
      { role: "system", content: "你是这套题的学习陪练。用户在追问这道题，结合题目和解析用大白话回答，帮他真正搞懂。简洁、具体。" },
      { role: "user", content: `题目：${q.question}\n选项：\n${opts}\n正确答案：${q.answer}\n解析：${q.explanation || ""}\n我的选择：${myAnswer}（${correct ? "对" : "错"}）${supplement ? "\n我的想法：" + supplement : ""}\n\n我的追问：${question}` },
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
  state.pendingFeedback = [];

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
  const askBtn = $("#btn-ask-ai");
  if (askBtn) { askBtn.style.display = "none"; }
  const askBox = $("#ask-ai-box");
  if (askBox) { askBox.style.display = "none"; }
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
  // 追问 AI 按钮：任何时候都可点（对解析/点评不满意就问）
  const askBtn = $("#btn-ask-ai");
  if (askBtn) { askBtn.style.display = "block"; askBtn.dataset.qIndex = item.qIndex; }

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

  // AI 点评：答错必评（无论有没有感想）；写了感想也评。按设置的时机（当时/统一）
  const shouldFeedback = (!correct || supplement);
  if (shouldFeedback && state.settings.feedbackMode === "after") {
    // 统一点评模式：先收集，刷完在完成页统一评
    state.pendingFeedback.push({ q, myAnswer: state.selected, correct, supplement });
  } else if (shouldFeedback && state.settings.feedbackMode !== "after") {    // 每题当时点评
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
  // 作答历史全留存：每次作答都新增一条，不删除旧记录（老板要求：重刷不覆盖历史）
  await dbPut("records", rec);
  // 更新内存缓存：记录按 题号→最新一条 维护（统计用最新，历史在 IndexedDB 全留）
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

/* 追问 AI：展开/收起对话框 */
function onAskToggle() {
  const box = $("#ask-ai-box");
  if (box.style.display === "none") {
    box.style.display = "block";
    $("#ask-ai-input").focus();
    const qIdx = $("#btn-ask-ai").dataset.qIndex;
    renderAskHistory(qIdx);
  } else {
    box.style.display = "none";
  }
}

/* 显示这道题的追问历史 */
async function renderAskHistory(qIndex) {
  const box = $("#ask-ai-history");
  if (!box) return;
  const chats = await dbAll("chats");
  const mine = chats
    .filter((c) => c.setId === state.currentSet.id && String(c.qIndex) === String(qIndex))
    .sort((a, b) => a.ts - b.ts);
  box.innerHTML = mine.length
    ? mine.map((c) => `<div class="ask-row"><div class="ask-q">🙋 ${esc(c.question)}</div><div class="ask-a">🤖 ${esc(c.answer)}</div></div>`).join("")
    : "";
}

/* 发送追问 */
async function onAskSend() {
  const q = $("#ask-ai-input").value.trim();
  if (!q) return;
  const settings = state.settings;
  if (!settings || !settings.apiKey) { alert("请先在 ⚙️ 设置 填 DeepSeek Key"); return; }
  const qIdx = $("#btn-ask-ai").dataset.qIndex;
  const item = state.quizOrder.find((it) => it.qIndex === parseInt(qIdx, 10));
  if (!item) return;
  // 找这条作答记录（最新一条）
  const recs = await dbAll("records");
  const mine = recs.filter((r) => r.setId === state.currentSet.id && r.qIndex === item.qIndex).sort((a, b) => b.ts - a.ts);
  const latest = mine[0];
  $("#ask-ai-input").value = "";
  $("#ask-ai-history").innerHTML += `<div class="ask-row"><div class="ask-q">🙋 ${esc(q)}</div><div class="ask-a" style="color:#888">🤖 思考中…</div></div>`;
  try {
    const answer = await askAI(q, item.q, latest?.answer || "", latest?.correct || false, latest?.supplement || "");
    await dbPut("chats", {
      id: uid(),
      setId: state.currentSet.id,
      qIndex: item.qIndex,
      question: q,
      answer,
      ts: Date.now(),
    });
    renderAskHistory(qIdx);
  } catch (e) {
    renderAskHistory(qIdx);
    alert("追问失败：" + (e.message || "网络/Key 问题"));
  }
}

function renderDone() {
  $("#quiz-progress").textContent = "完成！";
  const { correct, wrong, answered } = calcSetStats(state.currentSet.id, state.currentSet.questions.length);
  $("#done-stats").textContent = `已刷 ${answered}/${state.currentSet.questions.length} 题 · 对 ${correct} · 错 ${wrong}`;
  $("#quiz-feedback").style.display = "none";
  $("#btn-submit").style.display = "none";
  $("#btn-next").style.display = "none";
  $("#quiz-done").style.display = "block";
  // 统一点评模式：刷完统一评（只评待点评的题）
  if (state.settings.feedbackMode === "after" && state.pendingFeedback.length) {
    runBatchFeedback();
  }
}

/* 远迁移测试：检验"记忆→行动"——你能在现实中用出书里的方法吗 */
function openTransferTest() {
  const set = state.currentSet;
  if (!set) return;
  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-title">🧠 远迁移测试 — ${esc(set.title)}</div>
      <div class="detail-body">
        <p class="hint">检验你是否真的掌握了：不看题目，想想这套书里的方法，在真实生活/工作中你会怎么用它？</p>
        <div class="transfer-example">
          <div class="transfer-ex-title">💡 示例（ABCD 引导）</div>
          <p>假设你刚学了《非暴力沟通》，今天同事迟到没道歉，你很生气——你会怎么做？</p>
          <p>A. 直接说他怎么又迟到<br>B. 说出观察+感受+需要+请求<br>C. 忍着不说<br>D. 跟别人吐槽</p>
          <p class="hint">你不需要选 ABCD，直接用你自己的话回答：</p>
        </div>
        <textarea id="transfer-input" rows="5" placeholder="在这个场景（或你想到的其他场景）里，你会怎么用书里的方法？"></textarea>
        <button id="btn-voice-transfer" class="btn-voice" type="button">🎤</button>
        <button class="btn-primary btn-big" id="transfer-submit">提交，让 AI 判断我掌握没</button>
        <div id="transfer-result" class="transfer-result" style="margin-top:10px"></div>
      </div>
      <button class="btn-primary" id="transfer-close">关闭</button>
    </div>
  `;
  overlay.querySelector("#transfer-close").onclick = () => overlay.remove();
  overlay.querySelector("#transfer-submit").onclick = async () => {
    const ans = overlay.querySelector("#transfer-input").value.trim();
    if (!ans) { overlay.querySelector("#transfer-result").innerHTML = `<span class="error">先写点你的想法～</span>`; return; }
    const resBox = overlay.querySelector("#transfer-result");
    resBox.innerHTML = `<span class="loading-spinner"></span> AI 正在判断你的掌握程度…`;
    try {
      const result = await runTransferCheck(set, ans);
      resBox.innerHTML = `<div class="ai-feedback"><div class="ai-fb-title">🤖 AI 判断</div><div class="ai-fb-body">${esc(result)}</div></div>`;
    } catch (e) {
      resBox.innerHTML = `<span class="error">判断失败：${esc(e.message)}（检查 Key/网络）</span>`;
    }
  };
  document.body.appendChild(overlay);
}

/* 调 AI 判断掌握度，结果存案例库（transfers 表） */
async function runTransferCheck(set, userAnswer) {
  const settings = state.settings;
  if (!settings || !settings.apiKey) throw new Error("请先在 ⚙️ 设置 填 Key");
  const coreIdeas = set.questions.slice(0, 8).map((q, i) => `${i + 1}. ${q.question} → ${q.explanation || ""}`).join("\n");
  const body = {
    model: "deepseek-chat",
    temperature: 0.5,
    max_tokens: 900,
    messages: [
      { role: "system", content: "你是掌握度诊断教练。用户学了一套书的方法，现在回答了一个现实应用场景。请判断：他是否真的理解并能应用（不是背书）？指出：①理解对不对 ②哪里偏了/漏了 ③具体怎么修正。语气鼓励、具体。250字内。" },
      { role: "user", content: `这本书/这套题的核心方法：\n${coreIdeas}\n\n用户说：${userAnswer}` },
    ],
  };
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();
  const result = (data?.choices?.[0]?.message?.content || "").trim();
  // 案例库：你的应用场景 + AI 判断，自动归档（老板最初意见）
  await dbPut("transfers", {
    id: uid(),
    setId: set.id,
    setTitle: set.title,
    userAnswer,
    aiResult: result,
    ts: Date.now(),
  });
  return result;
}

/* 统一点评：刷完把待点评的题一起发给 AI 点评，结果追加到完成页 */
async function runBatchFeedback() {
  const settings = state.settings;
  if (!settings || !settings.apiKey) return;
  const items = state.pendingFeedback;
  state.pendingFeedback = [];
  const listText = items.map((it, i) => {
    const opts = (it.q.options || []).map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join("\n");
    return `【${i + 1}】题目：${it.q.question}\n选项：\n${opts}\n正确答案：${it.q.answer}\n我的选择：${it.myAnswer}（${it.correct ? "答对" : "答错"}）\n我的想法：${it.supplement || "（未填写）"}`;
  }).join("\n\n");
  const body = {
    model: "deepseek-chat",
    temperature: 0.6,
    max_tokens: 1500,
    messages: [
      { role: "system", content: "你是一位耐心的学习陪练。用户刚刷完一套题，请针对下面每道做错的题（或写了想法的题）给简短点评：理解对不对、哪里偏了、怎么修正。每题 2-3 句，编号对应。" },
      { role: "user", content: listText },
    ],
  };
  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const comment = (data?.choices?.[0]?.message?.content || "").trim();
    if (!comment) return;
    const box = document.createElement("div");
    box.className = "ai-feedback";
    box.style.marginTop = "12px";
    box.innerHTML = `<div class="ai-fb-title">🤖 AI 统一点评</div><div class="ai-fb-body">${esc(comment)}</div>`;
    const doneCard = $("#quiz-done");
    if (doneCard) doneCard.appendChild(box);
  } catch (e) { /* 失败静默 */ }
}

/* ---------------- 数据页 ---------------- */
async function renderDataPage(book) {
  let sets = await dbAll("sets");
  const records = await dbAll("records");
  // 按书筛选（book 传入时只显示该书题集；bookId 为空的旧数据归"未分类"）
  let scopeTitle = "";
  if (book) {
    sets = sets.filter((s) => s.bookId === book.id);
    scopeTitle = `📖 ${book.title} · `;
  }

  // 每套题的最新作答统计（每题取最新一条记录，按时间排序保证最新在后）
  let totalAnswered = 0, totalCorrect = 0, totalWrong = 0;
  const perSet = {};   // setId -> {correct, wrong, answered}
  for (const s of sets) {
    const latest = new Map();
    const mine = records.filter((r) => r.setId === s.id).sort((a, b) => a.ts - b.ts);
    for (const r of mine) latest.set(r.qIndex, r);
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
  const titleEl = $("#data-title");
  if (titleEl) titleEl.textContent = scopeTitle ? `💾 ${scopeTitle}我的数据` : "💾 我的数据";
  const allBtn = $("#btn-data-all");
  if (allBtn) allBtn.style.display = book ? "inline-block" : "none";

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
        <button class="btn-secondary" data-act="addq" data-id="${s.id}">➕ 加题</button>
        <button class="btn-secondary" data-act="sort" data-id="${s.id}">↕️ 排序</button>
        <button class="btn-secondary" data-act="detail" data-id="${s.id}">📋 明细</button>
        <button class="btn-secondary" data-act="delete" data-id="${s.id}">🗑 删除</button>
      </div>
    `;
    item.querySelector('[data-act="addq"]').onclick = async () => {
      await addQuestionsToSet(s);
    };
    item.querySelector('[data-act="sort"]').onclick = async () => {
      await sortQuestions(s);
    };
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

/* 调整顺序：简单前置 / 错题优先，原题不删 */
async function sortQuestions(set) {
  const mode = prompt("排序方式：\n1. 简单前置（简单→中等→困难）\n2. 错题优先（没掌握的先刷）", "1");
  const order = [
    { q: "简单", d: 1 },
    { q: "中等", d: 2 },
    { q: "困难", d: 3 },
    { q: "难", d: 3 },
  ];
  const diffRank = (s) => {
    const t = String(s || "").trim();
    for (const o of order) if (t.includes(o.q)) return o.d;
    return 2;
  };
  let sorted;
  if (String(mode).trim() === "2") {
    // 错题优先：先未掌握的（答错/未答），再已掌握的；每题顺序稳定
    const recs = await dbAll("records");
    const mine = recs.filter((r) => r.setId === set.id);
    const latest = new Map();
    for (const r of mine) latest.set(r.qIndex, r);
    const idxs = set.questions.map((_, i) => i);
    const wrongFirst = idxs.filter((i) => !latest.get(i) || !latest.get(i).correct);
    const rest = idxs.filter((i) => latest.get(i) && latest.get(i).correct);
    sorted = [...wrongFirst, ...rest].map((i) => set.questions[i]);
  } else {
    // 简单前置（默认）：难度升序，同难度保持原顺序
    sorted = [...set.questions].sort((a, b) => (diffRank(a.difficulty) - diffRank(b.difficulty)));
  }
  set.questions = sorted;
  set.updatedAt = Date.now();
  await dbPut("sets", set);
  alert(`✅ 已按${mode === "2" ? "错题优先" : "简单前置"}重新排序（原题都没删）`);
  renderDataPage();
}

/* 增加题目：AI 基于原文+已有题补出新题，追加到原题后（只增不替换） */
async function addQuestionsToSet(set) {
  const settings = state.settings;
  if (!settings || !settings.apiKey) {
    alert("请先在 ⚙️ 设置 里填 DeepSeek Key");
    return;
  }
  const addCount = prompt("想增加几道题？（默认 5 道）", "5");
  const n = Math.max(1, Math.min(20, parseInt(addCount, 10) || 5));
  const existing = set.questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
  const prompt = await loadPrompt();
  const userMsg = `以下是已经出过的 ${set.questions.length} 道题：\n${existing}\n\n请再出 ${n} 道【新题】——围绕原文核心但避免与上面重复，覆盖未涉及的角度。\n\n原文：\n${(set.source || "").slice(0, 8000)}`;
  const body = {
    model: "deepseek-chat",
    temperature: 0.7,
    max_tokens: 4000,
    messages: [
      { role: "system", content: prompt },
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
  const content = data?.choices?.[0]?.message?.content || "";
  const newQs = parseQuestions(content);
  if (!newQs || !newQs.length) { alert("AI 没出出新题，请重试或换说法"); return; }
  // 追加到原题后（只增不替换）
  set.questions = set.questions.concat(newQs);
  set.updatedAt = Date.now();
  await dbPut("sets", set);
  scoreCache.delete(set.id);
  wrongCache.delete(set.id);
  await loadSetCache(set.id);
  alert(`✅ 增加了 ${newQs.length} 道题，现在共 ${set.questions.length} 道（原题保留）`);
  renderDataPage();
}

/* 答题明细：展示这套题每道题的作答记录（对错/选择/感想/时间/AI点评） */
async function showSetDetail(set, recs) {
  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  // 每题的全部作答历史（按时间倒序，最新在前）——老板要求：重刷不覆盖历史
  const byQ = {};
  for (const r of recs) {
    if (!byQ[r.qIndex]) byQ[r.qIndex] = [];
    byQ[r.qIndex].push(r);
  }
  for (const k in byQ) byQ[k].sort((a, b) => b.ts - a.ts);
  const rows = set.questions.map((q, i) => {
    const hist = byQ[i] || [];
    const times = hist.map((r) => new Date(r.ts).toLocaleString("zh-CN"));
    const verdicts = hist.map((r) => (r.correct ? '<span class="dv-ok">✅ 对</span>' : '<span class="dv-no">❌ 错</span>'));
    const attempts = hist.length
      ? hist.map((r, j) => {
          const optText = (q.options && r.answer) ? (q.options[r.answer.charCodeAt(0) - 65] || "") : "";
          const sup = r.supplement ? `<div class="dv-sup">💬 ${esc(r.supplement)}</div>` : "";
          const ai = r.aiComment ? `<div class="dv-ai">🤖 ${esc(r.aiComment)}</div>` : "";
          return `<div class="dv-attempt"><div class="dv-head">${verdicts[j]} <span class="dv-ans">我的选择：${esc(r.answer)}${optText ? " · " + esc(optText) : ""}</span> <span class="dv-time">${times[j]}</span></div>${sup}${ai}</div>`;
        }).join("")
      : '<span class="dv-na">未答</span>';
    const badge = hist.length > 1 ? `<span class="dv-count">共刷 ${hist.length} 次</span>` : "";
    return `<div class="dv-item">
      <div class="dv-head">${badge} <span class="dv-q">${i + 1}. ${esc(q.question)}</span></div>
      ${attempts}
      <div class="dv-exp"><span class="dv-correct">正确答案：${esc(q.answer)}</span> — ${esc(q.explanation || "")}</div>
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
  const fmt = prompt("导出格式：\n1. JSON（备份/恢复用）\n2. Markdown（阅读用）\n3. 纯文本", "1");
  if (fmt === "2") return exportMarkdown();
  if (fmt === "3") return exportPlainText();
  // 默认 JSON 备份
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  const settings = await loadSettings();
  const data = {
    app: "AI出题读书法",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { count: settings.count, order: settings.order, dailyGoal: settings.dailyGoal || 0 },
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

/* 导出 Markdown（阅读用）：每套题+解析+我的最新作答 */
async function exportMarkdown() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  let md = `# AI出题读书法 导出\n\n> 导出时间：${new Date().toLocaleString("zh-CN")}\n\n`;
  for (const s of sets) {
    md += `## ${s.title}\n\n`;
    const mine = records.filter((r) => r.setId === s.id).sort((a, b) => a.ts - b.ts);
    const latest = new Map();
    for (const r of mine) latest.set(r.qIndex, r);
    s.questions.forEach((q, i) => {
      md += `### ${i + 1}. ${q.question}\n\n`;
      q.options.forEach((o, j) => md += `- ${String.fromCharCode(65 + j)}. ${o}\n`);
      const r = latest.get(i);
      md += `\n**正确答案**：${q.answer}\n\n**解析**：${q.explanation || ""}\n\n`;
      if (r) md += `**我的作答**：${r.answer}（${r.correct ? "对" : "错"}）${r.supplement ? " · 感想：" + r.supplement : ""}${r.aiComment ? "\n\n**AI 点评**：" + r.aiComment : ""}\n\n`;
      md += `---\n\n`;
    });
  }
  downloadText(md, `AI出题读书法_${new Date().toISOString().slice(0, 10)}.md`, "text/markdown");
}

/* 导出纯文本 */
async function exportPlainText() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  let txt = `AI出题读书法 导出\n导出时间：${new Date().toLocaleString("zh-CN")}\n\n`;
  for (const s of sets) {
    txt += `【${s.title}】\n`;
    const mine = records.filter((r) => r.setId === s.id).sort((a, b) => a.ts - b.ts);
    const latest = new Map();
    for (const r of mine) latest.set(r.qIndex, r);
    s.questions.forEach((q, i) => {
      txt += `${i + 1}. ${q.question}\n`;
      q.options.forEach((o, j) => txt += `   ${String.fromCharCode(65 + j)}. ${o}\n`);
      txt += `   答案：${q.answer} 解析：${q.explanation || ""}\n`;
      const r = latest.get(i);
      if (r) txt += `   我的作答：${r.answer}（${r.correct ? "对" : "错"}）${r.supplement ? "感想：" + r.supplement : ""}\n`;
    });
    txt += "\n";
  }
  downloadText(txt, `AI出题读书法_${new Date().toISOString().slice(0, 10)}.txt`, "text/plain");
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
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
  $("#goal-value").textContent = state.settings.dailyGoal || 0;
  $$("#seg-order .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.order === state.settings.order));
  $$("#seg-difficulty .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.difficulty === state.settings.difficulty));
  $$("#seg-types .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.types === state.settings.types));
  $$("#seg-feedback .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.feedback === state.settings.feedbackMode));
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

/* ---------------- 多本书管理（B1） ---------------- */
async function renderBooks() {
  const panel = $("#books-panel");
  if (!panel) return;
  const books = await dbAll("books");
  const sets = await dbAll("sets");
  panel.style.display = "block";

  // 选择框（生成题目时归书用）
  const sel = $("#book-select");
  const cur = sel.value;
  sel.innerHTML = `<option value="">（未分类）</option>` +
    books.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join("");
  if (cur) sel.value = cur;

  // 书列表（每本：书名 + 该书题集数 + 点按书看题集）
  const list = $("#book-list");
  list.innerHTML = books.map((b) => {
    const cnt = sets.filter((s) => s.bookId === b.id).length;
    return `<div class="book-item" data-book="${b.id}">
      <span class="book-title">📖 ${esc(b.title)}</span>
      <span class="book-meta">${cnt} 套题</span>
    </div>`;
  }).join("") || `<p class="hint">还没有书，点"➕ 新建书"开始</p>`;

  // 点书 → 数据页按书筛选
  list.querySelectorAll(".book-item").forEach((el) => {
    el.onclick = () => {
      const bid = el.dataset.book;
      const book = books.find((x) => x.id === bid);
      renderDataPage(book);
      showView("data");
    };
  });
}

async function createBook() {
  const name = prompt("书名叫什么？（如：非暴力沟通）", "");
  if (!name || !name.trim()) return;
  await dbPut("books", { id: uid(), title: name.trim(), createdAt: Date.now() });
  renderBooks();
  // 选中新建的书
  const books = await dbAll("books");
  const b = books.find((x) => x.title === name.trim());
  if (b) $("#book-select").value = b.id;
}

/* ---------------- 错题本独立页（B2） ---------------- */
async function renderWrongBook() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  const books = await dbAll("books");
  // 每题最新一条
  const latestBySet = {};
  for (const s of sets) {
    const map = new Map();
    // 显式按时间排序（IndexedDB getAll 不保证顺序），取最新一条
    const mine = records.filter((r) => r.setId === s.id).sort((a, b) => a.ts - b.ts);
    for (const r of mine) map.set(r.qIndex, r);
    latestBySet[s.id] = map;
  }
  // 汇总当前错题（每题最新一条是答错的）
  const wrongItems = [];
  for (const s of sets) {
    const map = latestBySet[s.id];
    if (!map) continue;
    for (const r of map.values()) {
      if (!r.correct) {
        const q = s.questions[r.qIndex];
        if (q) wrongItems.push({ set: s, qIndex: r.qIndex, q, record: r });
      }
    }
  }
  // 按书分组（bookId → 题）
  const groups = {};
  for (const item of wrongItems) {
    const bid = item.set.bookId || "";
    if (!groups[bid]) groups[bid] = [];
    groups[bid].push(item);
  }
  const bookTitle = (bid) => (bid ? (books.find((b) => b.id === bid)?.title || "未知书") : "未分类");
  const list = $("#wrong-list");
  list.innerHTML = wrongItems.length
    ? Object.keys(groups).map((bid) => `
      <div class="wrong-group">
        <div class="wrong-group-title">📖 ${esc(bookTitle(bid))} · ${groups[bid].length} 题错</div>
        ${groups[bid].map((it) => `
          <div class="wrong-item">
            <div class="wrong-q">${esc(it.q.question)}</div>
            <div class="wrong-actions">
              <button class="btn-mini" data-wrong-practice="${it.set.id}" data-wrong-q="${it.qIndex}">重练</button>
            </div>
          </div>`).join("")}
      </div>`).join("")
    : `<p class="hint">🎉 没有错题，全掌握了！</p>`;
  list.style.display = "block";
  // 隐藏题集列表和统计
  $("#set-list").style.display = "none";
  $("#data-stats").style.display = "none";
  $("#data-title").textContent = "❌ 错题本";
  // 重练按钮
  list.querySelectorAll("[data-wrong-practice]").forEach((btn) => {
    btn.onclick = async () => {
      const setId = btn.dataset.wrongPractice;
      const qIdx = parseInt(btn.dataset.wrongQ, 10);
      const set = sets.find((s) => s.id === setId);
      if (!set) return;
      await loadSetCache(setId);
      // 构造只含该题的临时题集
      const single = { ...set, questions: [set.questions[qIdx]] };
      showView("quiz");
      startQuiz(single, "sequence");
    };
  });
}

async function exitWrongBook() {
  $("#wrong-list").style.display = "none";
  $("#set-list").style.display = "";
  $("#data-stats").style.display = "";
  $("#data-title").textContent = "💾 我的数据";
  renderDataPage();
}

/* ---------------- 每日目标（B3） ---------------- */
async function renderDailyGoal() {
  const goal = state.settings.dailyGoal || 0;
  const el = $("#daily-progress");
  if (!el) return;
  if (!goal) { el.style.display = "none"; return; }
  el.style.display = "block";
  // 今日已答
  const records = await dbAll("records");
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const todayCount = records.filter((r) => r.ts >= startOfDay).length;
  const pct = Math.min(100, Math.round((todayCount / goal) * 100));
  $("#daily-text").textContent = `🎯 今日 ${todayCount}/${goal} 题`;
  $("#daily-fill").style.width = pct + "%";
  $("#daily-fill").style.background = pct >= 100 ? "#4caf50" : "#2196F3";
  if (pct >= 100 && !sessionStorage.getItem("goalPraise")) {
    sessionStorage.setItem("goalPraise", "1");
    setStatus("gen-status", `<span class="ok">🎉 今日目标达成！明天继续～</span>`, "ok");
  }
}

function changeGoal(delta) {
  let g = (state.settings.dailyGoal || 0) + delta;
  g = Math.max(0, Math.min(100, g));
  state.settings.dailyGoal = g;
  $("#goal-value").textContent = g;
  saveSetting("dailyGoal", g);
  renderDailyGoal();
}

/* ---------------- 统计看板（B4，纯 SVG 折线不引库） ---------------- */
async function renderStats() {
  const sets = await dbAll("sets");
  const records = await dbAll("records");
  const books = await dbAll("books");

  // 近 7 天每日 对/错/总
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = start + 86400000;
    const dayRecs = records.filter((r) => r.ts >= start && r.ts < end);
    const c = dayRecs.filter((r) => r.correct).length;
    days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, total: dayRecs.length, correct: c });
  }
  // 总天数（有作答的天数）
  const daySet = new Set(records.map((r) => new Date(r.ts).toDateString()));
  const totalDays = daySet.size;

  // 每本书掌握度（最新作答对错率）
  const bookStats = books.map((b) => {
    const bSets = sets.filter((s) => s.bookId === b.id);
    let c = 0, w = 0;
    for (const s of bSets) {
      const mine = records.filter((r) => r.setId === s.id).sort((x, y) => x.ts - y.ts);
      const latest = new Map();
      for (const r of mine) latest.set(r.qIndex, r);
      for (const r of latest.values()) { if (r.correct) c++; else w++; }
    }
    return { title: b.title, rate: (c + w) ? Math.round((c / (c + w)) * 100) : 0, total: c + w };
  });
  // 未分类
  {
    let c = 0, w = 0;
    for (const s of sets) {
      if (s.bookId) continue;
      const mine = records.filter((r) => r.setId === s.id).sort((x, y) => x.ts - y.ts);
      const latest = new Map();
      for (const r of mine) latest.set(r.qIndex, r);
      for (const r of latest.values()) { if (r.correct) c++; else w++; }
    }
    if (c + w > 0) bookStats.push({ title: "未分类", rate: Math.round((c / (c + w)) * 100), total: c + w });
  }

  // SVG 折线（近 7 天正确率）
  const W = 300, H = 100, PAD = 10;
  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const pts = days.map((d, i) => {
    const x = PAD + (i * (W - 2 * PAD)) / 6;
    const y = H - PAD - (d.total / maxTotal) * (H - 2 * PAD);
    return { x: Math.round(x), y: Math.round(y), d };
  });
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
  const labels = days.map((d, i) => `<text x="${pts[i].x}" y="${H - 2}" font-size="9" text-anchor="middle" fill="#888">${d.label}</text>`).join("");
  const dots = pts.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#2196F3"><title>${p.d.label}: 共${p.d.total}题 对${p.d.correct}</title></circle>`).join("");
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#ddd"/>
    <path d="${line}" fill="none" stroke="#2196F3" stroke-width="2"/>
    ${dots}${labels}
  </svg>`;

  $("#data-stats").innerHTML = `
    <div class="stat-chip"><div class="num">${records.length}</div><div class="label">总答题</div></div>
    <div class="stat-chip"><div class="num">${totalDays}</div><div class="label">刷题天数</div></div>
    <div class="stat-chip"><div class="num">${Math.round((records.filter(r=>r.correct).length / Math.max(1, records.length)) * 100)}%</div><div class="label">总正确率</div></div>
  `;
  const list = $("#set-list");
  list.style.display = "none";
  $("#wrong-list").style.display = "none";
  $("#data-title").textContent = "📊 统计";
  const statsBox = document.createElement("div");
  statsBox.className = "stats-box";
  statsBox.innerHTML = `
    <h3>📈 近 7 天答题量</h3>
    <div class="stats-svg">${svg}</div>
    <h3>📖 每本书掌握度</h3>
    ${bookStats.length ? bookStats.map((b) => `
      <div class="stat-book-row">
        <span>${esc(b.title)}</span>
        <div class="daily-bar"><div class="daily-fill" style="width:${b.rate}%;background:${b.rate >= 70 ? "#4caf50" : b.rate >= 40 ? "#ff9800" : "#f44336"}"></div></div>
        <span class="stat-rate">${b.rate}% (${b.total}题)</span>
      </div>`).join("") : `<p class="hint">还没有书的数据</p>`}
    <button class="btn-primary btn-big" id="stats-back">返回</button>
  `;
  statsBox.querySelector("#stats-back").onclick = exitWrongBook;
  // 替换统计区
  const statsArea = $("#data-stats").parentElement;
  const oldBox = statsArea.querySelector(".stats-box");
  if (oldBox) oldBox.remove();
  statsArea.appendChild(statsBox);
}

/* ---------------- 语音输入（手机说话变文字） ----------------
 * 用浏览器自带 Web Speech API（手机 Chrome 支持中文），把说话转成文字填入输入框。
 * 需要 https（GitHub Pages 已满足）；不支持的环境按钮隐藏。
 */
function setupVoiceInput(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.style.display = "none"; return; }
  let recognizing = false;
  btn.onclick = () => {
    if (recognizing) { recognizing = false; rec.stop(); btn.textContent = "🎤"; return; }
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onstart = () => { recognizing = true; btn.textContent = "🔴 说话中…"; };
    rec.onresult = (e) => {
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
      if (finalText) input.value = (input.value ? input.value + " " : "") + finalText;
    };
    rec.onend = () => { recognizing = false; btn.textContent = "🎤"; };
    rec.onerror = () => { recognizing = false; btn.textContent = "🎤"; };
    rec.start();
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
  $("#btn-goal-minus").onclick = () => changeGoal(-1);
  $("#btn-goal-plus").onclick = () => changeGoal(1);
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
  $$("#seg-feedback .seg-btn").forEach((b) => b.onclick = () => {
    $$("#seg-feedback .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    saveSetting("feedbackMode", b.dataset.feedback);
    state.settings.feedbackMode = b.dataset.feedback;
  });
  $("#btn-generate").onclick = onGenerate;
  $("#btn-upload-txt").onclick = () => $("#upload-file").click();
  $("#upload-file").onchange = onUploadTxt;
  $("#btn-submit").onclick = onSubmit;
  $("#btn-next").onclick = onNext;
  $("#btn-ask-ai").onclick = onAskToggle;
  $("#btn-ask-send").onclick = onAskSend;
  $("#btn-restart").onclick = () => startQuiz(state.currentSet, "sequence");
  $("#btn-transfer").onclick = openTransferTest;
  $("#btn-back-home").onclick = () => { showView("home"); renderLastSet(); renderBooks(); renderDailyGoal(); };
  $("#btn-add-book").onclick = createBook;
  $("#btn-data-all").onclick = () => { renderDataPage(); };
  $("#btn-wrong-book").onclick = renderWrongBook;
  $("#btn-stats-view").onclick = renderStats;
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
    if (v === "home") { renderLastSet(); renderBooks(); renderDailyGoal(); }
    if (v === "data") renderDataPage();
    if (v === "settings") renderSettings();
    if (v === "prompt") renderPromptPage();
    showView(v);
  });

  // 联网状态
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);
  updateNetStatus();

  // 语音输入（不支持的浏览器自动隐藏 🎤）
  setupVoiceInput("btn-voice-supplement", "supplement-text");
  setupVoiceInput("btn-voice-ask", "ask-ai-input");
  setupVoiceInput("btn-voice-transfer", "transfer-input");

  // 首页最近一套 + 我的书 + 今日进度
  renderLastSet();
  renderBooks();
  renderDailyGoal();

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
