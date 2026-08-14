# web —— 前端（先 Web，后 Tauri）

Helmsman 任务工作台前端 **P0 骨架**（Vite + React 18 + TypeScript + zustand）。
视觉/交互权威：`taskboard-v9.html`（THEMES 主题契约、布局、组件、文案全部从它提取，原样移植）。

## 快速开始

```bash
pnpm install    # esbuild 构建已通过 pnpm-workspace.yaml 的 allowBuilds 批准，无需交互
pnpm dev        # http://localhost:5173（/api 与 /api/events 经 Vite proxy → 127.0.0.1:3081）
pnpm build      # tsc -b && vite build
pnpm lint       # eslint（基础配置）
```

前置：Rust 产品服务运行在 3081（服务无 CORS 头，必须走 dev proxy；proxy 已配 ws:true 支持 /api/events）。

## 目录结构

```
web/src/
  theme/      themes.ts（THEME CONTRACT：六套主题 25 键 token + atmo spec，原样移植）
              ThemeProvider.tsx（CSSOM 注入全部 token；system 跟随；localStorage 持久化）
              Atmosphere.tsx（按 atmo spec 渲染 glow/stars/blobs，档位 off/soft/on/strong）
  api/        client.ts（REST 封装：projects / project / task / POST tasks / cancel）
              events.ts（WS 客户端：指数退避重连 1s→2s→…30s；事件回调）
  store/      projection.ts（{pid:{sid:TaskState}} 投影 + 状态推导 + 会话级成本/缓存命中 + usage 折叠）
              ui.ts（路由/侧栏/模态/toast + hash 写入）
  components/ 布局（Sidebar/Topbar/Statusbar）+ 基础（Button/Badge/Card/EmptyState/Modal/Switch/ThemePicker/Toast/Skeleton/Icon）
              modals/（NewTask / Dir / Settings）
  views/      工作台首页 / 项目首页 / 看板 / 会话 / 图 / 知识库 / 文件 / 任务详情抽屉
  styles/     base.css（原型视觉系统移植）
  main.tsx / App.tsx
```

## 关键机制

- **引擎是唯一状态写入者**：前端"改状态"都是发事件（运行=POST tasks、停止=POST cancel）。
  运行中卡片锁死（不可拖、无操作按钮，仅评论）。拖拽/重跑/评论 = 目标契约（P0 未开，占位标注）。
- **阻塞现算**：依赖未完成每次渲染算（`depsUnmet`），绝不写状态字段。
- **数据流**：REST 快照 → 投影；WS 事件 = 变化信号（防抖重拉，按 `last_seq` 追平）；
  `assistant/message.usage` 在 activeSession 边界内折叠为会话级 usage。
- **成本/命中率**：会话级。定价表 输入¥2/输出¥8/缓存读¥0.2/思考¥8 每 M token；
  命中率 = cacheRead/(cacheRead+input)。无 usage（服务重启前完成的会话）显示 —。
- **hash 路由**：`#pid=&view=&open=&tab=`（view: home|projhome|kanban|chat|graph|kb|files）。

## 目标契约（不做假实现，仅占位标注）

评论即控制、依赖/DAG、待确认(Waiting)、简报、知识库(KbNote)、度量、文件树、项目注册
（POST /api/projects 未开：项目在首张任务卡 POST tasks 带 cwd 时注册）。