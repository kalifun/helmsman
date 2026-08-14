// 职责：入口 —— 挂载 App 与全局样式。
import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);