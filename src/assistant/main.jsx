import React from 'react';
import { createRoot } from 'react-dom/client';
import AssistantPanel from './AssistantPanel.jsx';

// AI 选房助手 React Island：挂载到 index.html 的 #aiRoot，
// 真实房源数据由 public/app.js 暴露的 window.getAssistantContext() 提供。
const root = document.getElementById('aiRoot');
if (root) {
  createRoot(root).render(<AssistantPanel />);
}
