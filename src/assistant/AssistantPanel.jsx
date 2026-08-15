import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

/* =========================================================
 * AI 选房助手面板（React Island）
 * 真实回答由 /api/ai/assistant（DeepSeek + Tool）流式返回；
 * 历史问答仅保存在浏览器 localStorage，不上传服务器。
 * ========================================================= */

const QUICK_QUESTIONS = [
  '预算内且通勤最短的有哪些？',
  '为什么当前第一名最适合我？',
  '房源 A 和 B 有哪些关键差异？',
  '哪些条件需要线下核验？',
];

const WELCOME_TEXT = '你好，我是你的 AI 选房助手。\n\n我只能基于当前页面的真实房源、通勤和评分结果帮你筛选、比较和解释，不会编造房源信息。';

const TOOL_LABEL = {
  'tool-searchListings': '关键词查找',
  'tool-filterListings': '条件筛选',
  'tool-compareListings': '房源对比',
  'tool-getListingById': '房源详情',
};

/* ---------- 历史记录（localStorage，最多 50 条，保留 30 天） ---------- */
const AI_HISTORY_KEY = 'zhunaer_ai_chat_history_v1';
const AI_HISTORY_MAX = 50;
const AI_HISTORY_MAX_AGE = 30 * 24 * 3600 * 1000;

/* 当前选房结果签名：条件变化后用于提示历史回答可能过期 */
function computeContextSignature() {
  const ctx = window.getAssistantContext ? window.getAssistantContext() : null;
  if (!ctx) return 'no-context';
  const core = [
    ctx.company, ctx.budget, ctx.arriveTime, ctx.mode,
    ...(ctx.listings || []).map((l) =>
      [l.id, l.rank, l.score, l.status, l.totalMonthlyCost, l.commute?.conservativeMinutes].join('_')),
  ].join('|');
  let h = 0;
  for (let i = 0; i < core.length; i++) h = ((h * 31 + core.charCodeAt(i)) | 0);
  return 'sig_' + h;
}

function loadAiHistory() {
  try {
    const raw = localStorage.getItem(AI_HISTORY_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.messages)) return [];
    const cutoff = Date.now() - AI_HISTORY_MAX_AGE; // 超过 30 天的消息自动清理
    return data.messages
      .filter((m) => m && typeof m.content === 'string' && new Date(m.createdAt).getTime() > cutoff)
      .slice(-AI_HISTORY_MAX);
  } catch {
    // 数据损坏或解析失败：安全清除，页面仍正常运行
    localStorage.removeItem(AI_HISTORY_KEY);
    return [];
  }
}

function saveAiHistory(messages) {
  try {
    localStorage.setItem(AI_HISTORY_KEY, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      messages: messages.slice(-AI_HISTORY_MAX), // 超过 50 条时删除最早消息
    }));
  } catch { /* 存储满或被禁用时静默失败，不影响聊天 */ }
}

function appendAiHistoryMessage(role, content, citations) {
  const messages = loadAiHistory();
  messages.push({
    id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    role,
    content,
    createdAt: new Date().toISOString(),
    contextSignature: computeContextSignature(),
    citations: citations && citations.length ? citations : undefined,
  });
  saveAiHistory(messages);
}

function clearAiHistory() {
  localStorage.removeItem(AI_HISTORY_KEY); // 仅删除聊天记录，不影响房源/评分/预算等
}

/* 历史记录 → useChat 消息（时间戳与引用卡片放入 metadata） */
function toUIMessage(m) {
  return {
    id: m.id,
    role: m.role,
    parts: [{ type: 'text', text: m.content }],
    metadata: { createdAt: m.createdAt, citations: m.citations },
  };
}

/* ---------- 引用卡片 ---------- */
function extractCitations(msg) {
  const map = new Map();
  const push = (s) => {
    if (s && s.id != null && !map.has(s.id)) {
      map.set(s.id, {
        id: s.id, letter: s.letter ?? null, name: s.name, rank: s.rank ?? null,
        totalMonthlyCost: s.totalMonthlyCost ?? null,
        commute: s.commute ?? null,
        statusLabel: s.statusLabel || s.status || null,
        dataStatus: s.dataStatus || 'ok',
      });
    }
  };
  for (const p of msg.parts || []) {
    if (typeof p.type !== 'string' || !p.type.startsWith('tool-')) continue;
    if (p.state !== 'output-available' || !p.output) continue;
    const out = p.output;
    if (p.type === 'tool-searchListings') (out.results || []).forEach(push);
    else if (p.type === 'tool-filterListings') (out.matched || []).forEach(push);
    else if (p.type === 'tool-compareListings') { push(out.a); push(out.b); }
    else if (p.type === 'tool-getListingById') push(out.listing);
  }
  return [...map.values()];
}

function CitationCard({ c }) {
  const commute = c.commute;
  return (
    <button
      type="button"
      className="ai-cite"
      title="在结果页中定位该房源"
      onClick={() => window.highlightListing && window.highlightListing(c.id)}
    >
      <div className="ai-cite-head">
        <b>{c.letter ? `房源 ${c.letter}` : '房源'} · {c.name}</b>
        {c.rank != null && <span className="ai-cite-rank">第 {c.rank} 名</span>}
      </div>
      <div className="ai-cite-meta">
        {c.totalMonthlyCost != null && <span>月总成本 ¥{c.totalMonthlyCost}</span>}
        {commute && <span>保守通勤 {commute.conservativeMinutes} 分钟 · 最晚 {commute.latestDeparture} 出发</span>}
        {c.statusLabel && <span>{c.statusLabel}</span>}
        {c.dataStatus === 'pending_verification' && <span>数据待核验</span>}
      </div>
    </button>
  );
}

function fmtMsgTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function Message({ msg, time }) {
  const isUser = msg.role === 'user';
  const live = !isUser ? extractCitations(msg) : [];
  const citations = live.length ? live : (msg.metadata?.citations || []);
  const text = (msg.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  return (
    <div className={`msg-row ${isUser ? 'user' : 'bot'}`}>
      {!isUser && <span className="ai-avatar" aria-hidden="true">✨</span>}
      <div className={`msg ${isUser ? 'user' : 'bot'}`}>
        {(msg.parts || []).map((p, i) => {
          if (p.type !== 'text' && typeof p.type === 'string' && p.type.startsWith('tool-')) {
            return (
              <span key={i} className="ai-tool-line">
                {p.state === 'output-available' ? '已查询真实房源数据' : '正在查询房源…'}
                {TOOL_LABEL[p.type] ? ` · ${TOOL_LABEL[p.type]}` : ''}
              </span>
            );
          }
          return null;
        })}
        {text && <span>{text}</span>}
        {!isUser && citations.length > 0 && (
          <div className="ai-cites">
            <div className="ai-cites-title">回答依据（点击可定位到结果页）</div>
            {citations.map((c) => <CitationCard key={c.id} c={c} />)}
          </div>
        )}
        {!isUser && <span className="msg-src">基于当前页面计算结果 · 高德真实数据</span>}
        {time && <span className="msg-time">{fmtMsgTime(time)}</span>}
      </div>
    </div>
  );
}

/* ---------- 面板 ---------- */
export default function AssistantPanel() {
  const [view, setView] = useState('welcome');
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [stale, setStale] = useState(false);
  const listRef = useRef(null);
  const timesRef = useRef({});

  const initialHistory = useMemo(() => loadAiHistory(), []);
  const { messages, sendMessage, setMessages, status, error, regenerate } = useChat({
    transport: new DefaultChatTransport({ api: '/api/ai/assistant' }),
    throttle: 50,
    messages: initialHistory.map(toUIMessage),
    onFinish: ({ message }) => {
      const text = (message.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
      if (text) appendAiHistoryMessage('assistant', text, extractCitations(message));
    },
  });

  // 与原生页面联动：视图切换控制入口显隐；「向 AI 追问」按钮打开面板
  useEffect(() => {
    const onView = (e) => {
      setView(e.detail);
      if (e.detail !== 'result') setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('zhunaer:viewchange', onView);
    window.addEventListener('zhunaer:open-assistant', onOpen);
    return () => {
      window.removeEventListener('zhunaer:viewchange', onView);
      window.removeEventListener('zhunaer:open-assistant', onOpen);
    };
  }, []);

  // 记录每条消息的显示时间（恢复的历史用其 createdAt）
  useEffect(() => {
    messages.forEach((m) => {
      if (!timesRef.current[m.id]) timesRef.current[m.id] = m.metadata?.createdAt || new Date().toISOString();
    });
  }, [messages]);

  // 新消息/流式更新时滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  // 打开面板时检测：当前计算结果与历史记录签名是否一致
  useEffect(() => {
    if (!open) return;
    const history = loadAiHistory();
    const lastSig = history.length ? history[history.length - 1].contextSignature : null;
    setStale(!!lastSig && lastSig !== computeContextSignature());
  }, [open, messages.length]);

  const busy = status !== 'ready';
  const send = (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    appendAiHistoryMessage('user', q); // 用户消息立即保存
    // 每次提问都带上当前页面最新真实计算结果快照
    const context = window.getAssistantContext ? window.getAssistantContext() : null;
    sendMessage({ text: q }, { body: { context } });
    setInput('');
  };

  const onClear = () => {
    if (!window.confirm('确定清空聊天记录吗？此操作不可恢复。')) return;
    clearAiHistory();
    setMessages([]);
    setStale(false);
  };

  const showFab = view === 'result';
  const lastMsg = messages[messages.length - 1];
  const waiting = busy && (!lastMsg || lastMsg.role !== 'assistant'
    || !(lastMsg.parts || []).some((p) => p.type === 'text' && p.text));

  return (
    <>
      <button
        className={`ai-fab ${showFab && !open ? '' : 'hidden'}`}
        title="AI 选房助手"
        onClick={() => setOpen(true)}
      >AI</button>
      <aside className={`ai-panel ${open ? 'open' : ''}`}>
        <div className="ai-head">
          <div className="ai-head-title">
            <span className="ai-head-icon" aria-hidden="true">✨</span>
            <div>
              <h3>AI 选房助手</h3>
              <p>基于当前房源、通勤与评分结果</p>
            </div>
          </div>
          <div className="ai-head-actions">
            <button className="ai-clear" onClick={onClear} title="清空聊天记录">清空记录</button>
            <button className="ai-close" onClick={() => setOpen(false)} title="关闭">×</button>
          </div>
        </div>

        <div className="ai-messages" ref={listRef}>
          {stale && (
            <div className="ai-stale-banner">
              当前房源计算结果已变化。历史回答基于此前的条件，仅供参考；请重新提问以获得最新结果。
            </div>
          )}
          {messages.length === 0 ? (
            <div className="ai-empty">
              <span className="ai-empty-icon" aria-hidden="true">✨</span>
              <p>{WELCOME_TEXT}</p>
              <div className="ai-quick in-empty">
                {QUICK_QUESTIONS.map((q) => (
                  <button key={q} className="chip" disabled={busy} onClick={() => send(q)}>{q}</button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <Message key={m.id} msg={m} time={timesRef.current[m.id]} />)
          )}
          {waiting && <div className="msg bot ai-status">正在查询房源…</div>}
          {error && (
            <div className="msg bot ai-error">
              助手服务出了点问题，请稍后重试。
              <button type="button" className="chip" onClick={() => regenerate()}>重试</button>
            </div>
          )}
        </div>

        {messages.length > 0 && (
          <div className="ai-quick">
            {QUICK_QUESTIONS.map((q) => (
              <button key={q} className="chip" disabled={busy} onClick={() => send(q)}>{q}</button>
            ))}
          </div>
        )}

        <div className="ai-input-row">
          <textarea
            rows={1}
            value={input}
            placeholder="问问预算、通勤、排名或房源对比…"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button className="btn-send" disabled={busy || !input.trim()} onClick={() => send()}>发送</button>
        </div>
      </aside>
    </>
  );
}
