import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

/* 快捷问题（PRD 5.1） */
const QUICK_QUESTIONS = [
  '预算内且通勤最短的有哪些？',
  '为什么当前第一名最适合我？',
  '房源 A 和 B 有哪些关键差异？',
  '哪些条件需要线下核验？',
];

const WELCOME = '你好，我是你的 AI 选房助手。我会调用工具查询你当前页面的真实计算结果（排名、租金、通勤、配套、硬约束）来回答，不参与打分，也不会编造数据。可以点击下方快捷问题试试。';

const TOOL_LABEL = {
  'tool-searchListings': '关键词查找',
  'tool-filterListings': '条件筛选',
  'tool-compareListings': '房源对比',
  'tool-getListingById': '房源详情',
};

/* 从一条助手消息的 Tool 输出中提取引用房源（去重，保持顺序） */
function extractCitations(msg) {
  const map = new Map();
  const push = (s) => {
    if (s && s.id != null && !map.has(s.id)) map.set(s.id, s);
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
        {c.status && <span>{c.statusLabel || c.status}</span>}
        {c.dataStatus === 'pending_verification' && <span>数据待核验</span>}
      </div>
    </button>
  );
}

function Message({ msg }) {
  const isUser = msg.role === 'user';
  const citations = !isUser ? extractCitations(msg) : [];
  return (
    <div className={`msg ${isUser ? 'user' : 'bot'}`}>
      {(msg.parts || []).map((p, i) => {
        if (p.type === 'text') return <span key={i}>{p.text}</span>;
        if (typeof p.type === 'string' && p.type.startsWith('tool-')) {
          return (
            <span key={i} className="ai-tool-line">
              {p.state === 'output-available' ? '已查询真实房源数据' : '正在查询房源…'}
              {TOOL_LABEL[p.type] ? ` · ${TOOL_LABEL[p.type]}` : ''}
            </span>
          );
        }
        return null;
      })}
      {!isUser && citations.length > 0 && (
        <div className="ai-cites">
          <div className="ai-cites-title">回答依据（点击可定位到结果页）</div>
          {citations.map((c) => <CitationCard key={c.id} c={c} />)}
        </div>
      )}
      {!isUser && <span className="msg-src">基于当前页面计算结果 · 高德真实数据</span>}
    </div>
  );
}

export default function AssistantPanel() {
  const [view, setView] = useState('welcome');
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const listRef = useRef(null);

  const { messages, sendMessage, status, error, regenerate } = useChat({
    transport: new DefaultChatTransport({ api: '/api/ai/assistant' }),
    throttle: 50,
    messages: [
      { id: 'welcome', role: 'assistant', parts: [{ type: 'text', text: WELCOME }] },
    ],
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

  // 新消息/流式更新时滚动到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const busy = status !== 'ready';
  const send = (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    // 每次提问都带上当前页面最新真实计算结果快照
    const context = window.getAssistantContext ? window.getAssistantContext() : null;
    sendMessage({ text: q }, { body: { context } });
    setInput('');
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
          <div>
            <h3>AI 选房助手</h3>
            <p>基于当前页面真实计算结果回答 · 不参与评分 · 不构成承诺</p>
          </div>
          <button className="ai-close" onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="ai-quick">
          {QUICK_QUESTIONS.map((q) => (
            <button key={q} className="chip" disabled={busy} onClick={() => send(q)}>{q}</button>
          ))}
        </div>
        <div className="ai-messages" ref={listRef}>
          {messages.map((m) => <Message key={m.id} msg={m} />)}
          {waiting && <div className="msg bot ai-status">正在查询房源…</div>}
          {error && (
            <div className="msg bot ai-error">
              助手服务出了点问题，请稍后重试。
              <button type="button" className="chip" onClick={() => regenerate()}>重试</button>
            </div>
          )}
        </div>
        <div className="ai-input-row">
          <input
            type="text"
            value={input}
            placeholder="例如：预算 7000 内、不能 7:30 前出门的有哪些？"
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button className="btn-send" disabled={busy || !input.trim()} onClick={() => send()}>发送</button>
        </div>
      </aside>
    </>
  );
}
