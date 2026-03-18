# Fit-Running

> Keep 跑步轨迹 FIT 文件生成工具 — 在免 API 地图上绘制路线，配置运动参数，批量生成可导入 Keep 的 `.fit` 活动文件。

## 项目用途

这是一个纯前端的跑步轨迹生成工具，核心场景：

- **在地图上手动绘制跑步路线**，或从 GeoJSON / GPX / TCX 文件导入已有轨迹
- **配置运动参数**（配速、心率、步频、海拔、卡路里等），生成标准 FIT 活动文件
- **批量生成**一周或一个月的跑步记录（随机时间、随机轨迹偏移、随机配速浮动）
- **导入 Keep**（或其他支持 FIT 的运动平台）

### 关键特性

| 能力 | 说明 |
|---|---|
| 免 API 地图 | 基于 Leaflet + OpenStreetMap / CARTO 瓦片，无需申请任何 Key |
| WGS84 原生 | 地图编辑与导出统一使用 WGS84 坐标系，无需坐标转换 |
| 5 种兼容策略 | 平衡 / Keep优先 / 设备兼容 / 简化兼容 / 极简兼容 |
| 批量生成 | 日期范围 + 星期选择 + 时间段 + 轨迹随机偏移/打点/距离浮动 |
| 批量预览 | 生成前可查看每条活动的时间、距离、配速，支持行级编辑/删除/重随机 |
| 多格式导入 | GeoJSON / GPX / TCX / 坐标文本 |
| 多格式导出 | FIT / GeoJSON / GPX / TCX |
| 轨迹优化 | Douglas-Peucker 精简、滑动平均平滑、自动清洗（去重/跳点过滤） |
| 质量评分 | 导出前自动评估轨迹质量并给出风险等级 |
| 参数预设 | 保存/应用/删除常用参数组合 |
| 配置快照 | JSON 导入/导出，便于分享与复现 |
| 双交互模式 | 引导式（Apple Liquid Glass 风格）/ 完全控制式（Fluent 效率风格） |
| 深浅色主题 | 浅色 / 深色，自动持久化 |
| 快捷键 | `Ctrl/Cmd+S` 导出、`Ctrl/Cmd+Shift+S` 批量导出、`Ctrl/Cmd+L` 视野适配 |

## 部署方法

### 环境要求

- Node.js >= 18
- npm >= 9（或 pnpm / yarn）

### 本地开发

```bash
git clone https://github.com/dentar142/Fit-Running.git
cd Fit-Running
npm install
npm run dev
```

浏览器打开终端显示的地址（通常是 `http://localhost:5173/`）。

### 生产构建

```bash
npm run build
```

构建产物在 `dist/` 目录，是纯静态文件，可部署到任何静态托管服务：

| 平台 | 方法 |
|---|---|
| Vercel | 导入 GitHub 仓库，自动检测 Vite 项目 |
| Netlify | 同上，构建命令 `npm run build`，发布目录 `dist` |
| GitHub Pages | 推送 `dist/` 到 `gh-pages` 分支 |
| Nginx / Apache | 将 `dist/` 内容放到 Web 根目录 |
| Docker | 用任意静态服务镜像（如 `nginx:alpine`）挂载 `dist/` |

### 本地预览构建结果

```bash
npm run preview
```

## 使用流程

1. 打开页面，进入引导首屏（或直接切换到完全控制模式）
2. 在地图上点击绘制路线，或导入已有轨迹文件
3. 配置运动参数（配速、心率、步频等）
4. 单次导出：点击"生成当前策略 .fit"
5. 批量导出：设置日期范围与随机参数 → 生成预览 → 检查/编辑 → 批量下载

## 技术栈

- React + TypeScript + Vite
- Leaflet（WGS84 瓦片地图）
- fit-encoder（FIT 文件编码）

## 设计风格

- 引导模式：Apple Human Interface 液态玻璃风格（半透明、视差、渐变 orb）
- 控制模式：Fluent 效率风格（紧凑布局、直接操作）
- 深浅色主题、舒适/紧凑密度、`prefers-reduced-motion` 无障碍支持

## License

Apache-2.0
