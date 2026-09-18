import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "划词翻译（有道）",
  version: "0.2.0",
  description: "在任意网页选中文本，浮动气泡显示有道翻译结果。",
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "contextMenus"],
  host_permissions: [
    "https://dict-trans.youdao.com/*",
    "https://dict.youdao.com/*",
  ],
});
