# PDF 手写批注 · 做题画笔 (Chrome 扩展 MVP)

在 Chrome 里打开 PDF 时，用画笔直接在上面手写答案 / 演算过程。主要面向**做题**场景：
笔迹按 PDF 自动保存、下次打开同一份自动恢复，写完可导出成带手写的 PDF。

> 为什么要替换 Chrome 自带阅读器？Chrome 内置 PDF 阅读器是一个沙箱化组件，
> 无法注入脚本、无法在其上叠加画布。因此本扩展用 **PDF.js** 自建阅读器并接管 PDF 链接，
> 在每一页上叠加一层透明画布来手写。

## 安装（加载已解压扩展）

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**。
2. 点 **加载已解压的扩展程序**，选择本项目根目录（`drawer/`）。
3. （接管本地 `file://` PDF 必需）点开本扩展的 **详情**，打开 **允许访问文件网址 (Allow access to file URLs)**。

## 使用

打开 PDF 有两种方式，效果一样：

- **自动接管**：在浏览器里打开任意 `.pdf` 链接（本地 `file://` 或在线 `http/https`）→ 自动进入手写阅读器。
- **手动打开**：点工具栏的扩展图标 → 在欢迎页 **拖拽** 或 **选择** 一个本地 PDF（这条路径不需要任何文件权限，是最稳的本地兜底）。

先用根目录的 `sample.pdf` 试一下（拖进欢迎页即可）。

### 工具
- ✏️ 画笔（颜色 / 粗细，手写笔自动带压感粗细变化）
- 🧹 橡皮（整条笔迹删除，可撤销）
- 撤销 / 重做、清空本页
- 翻页、跳页、缩放、适应宽度
- ⬇ 导出带手写的 **PDF**、🖼 导出当前页 **PNG**
- 笔迹按 PDF **自动保存**到本地，重开自动恢复

### 快捷键
`P` 画笔 · `E` 橡皮 · `Ctrl/⌘+Z` 撤销 · `Ctrl/⌘+Shift+Z`（或 `Ctrl+Y`）重做 · `[` / `]` 翻页 · `Ctrl/⌘+S` 导出 PDF

## 目录结构
```
manifest.json            MV3 清单
src/background.js         service worker：DNR 重定向 .pdf → 查看页；图标点击打开查看页
src/viewer/
  viewer.html/.css       查看页 UI（工具栏 / 页面区 / 欢迎拖拽区）
  pdf-loader.js          PDF.js 初始化（worker / CMaps / 标准字体）
  viewer.js              入口：加载 PDF、逐页渲染、缩放/翻页、撤销栈、自动保存、导出
  drawing.js             绘图引擎（Pointer Events、归一化笔迹、橡皮、共享渲染函数）
  store.js               chrome.storage.local 持久化（docId 哈希 + 防抖保存）
  export.js              合成底图+笔迹 → jsPDF 导出
  toolbar.js             工具栏交互 + 快捷键
vendor/                  PDF.js (pdfjs-dist@4.10.38) + jsPDF(@2.5.2) + cmaps/standard_fonts
icons/                   扩展图标
sample.pdf               自测用样例
```

## 技术要点
- **Manifest V3，无构建步骤**：vanilla JS + ES module，`vendor/` 直接打包第三方库。
- **接管机制**：`declarativeNetRequest` 动态规则把 `main_frame` 的 `.pdf` 导航重定向到查看页
  （动态规则才能用 `chrome.runtime.getURL` 拿到真实扩展 ID）。查看页自身去拉取 PDF 字节属于
  非 `main_frame` 请求，不会被再次重定向，无循环。
- **中文 PDF**：打包了 PDF.js 的 `cmaps/` 与 `standard_fonts/` 并通过 `cMapUrl/standardFontDataUrl`
  指向，保证 CJK 文本正常渲染（否则会空白）。
- **笔迹模型**：坐标归一化到 `[0,1]`，缩放 / 重渲染 / 不同 DPR 下都对齐，导出时可任意分辨率重画。
- **CSP**：`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`，worker 走本地打包文件。

## 已知限制（MVP 边界，后续迭代）
- 仅按 **`.pdf` 后缀** 自动接管；无后缀但 `Content-Type: application/pdf` 的链接不会自动接管
  （可用「手动打开」兜底）。
- 接管本地 `file://` 依赖手动开启「允许访问文件网址」。
- 绘图层覆盖整页，**触摸拖动不滚动**（用滚轮 / 滚动条 / 翻页按钮）；暂无「手型/平移」工具。
- 暂无 文字 / 高亮 / 图形 / 便签 工具、PDF 内文本选择、跨设备云同步、像素级橡皮、激进防手掌误触。
- 大 PDF 采用**按需渲染**（只渲染视口附近的页，滚走的页释放内存，笔迹以矢量数据保留），
  几百页的讲义也能流畅打开；但「导出 PDF」会重渲染全部页，页数很多时导出会较慢、文件较大。

## 第三方许可
- PDF.js — Apache-2.0（Mozilla）
- jsPDF — MIT
