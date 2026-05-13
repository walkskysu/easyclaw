# CLAWDIY

一个基于 Electron + Vue 3 + TypeScript 的桌面智能助手项目，支持：

- OpenAI 兼容接口对话
- 工具调用（读写文件、执行命令、网页检索等）
- Skill 机制（自动发现与刷新）
- 微信消息桥接（收发文本，支持发送文件）

适合用于构建本地可控的 AI Agent 桌面应用。

## 功能特性

- 对话界面
  - 支持 Markdown 渲染
  - 显示消息时间戳
  - 支持流式状态提示（例如“调用 tool 中”）
- 配置管理
  - 首次启动自动生成配置文件
  - UI 内可直接修改模型地址、模型名、API Key
  - 可配置最大工具调用轮次和最大 Skill 读取次数
- Agent + Tool
  - 从 `agent/` 目录拼装系统提示词
  - 从 `agent/tools.json` 加载工具定义
  - 由主进程统一执行工具，限制在项目根目录内访问
- Skills
  - 自动扫描 `skills/*/SKILL.md`
  - 一键刷新并生成 `agent/available_skills.xml`
- 微信桥接
  - 接收微信消息后自动转发到对话界面
  - 网页端消息和模型回复可自动回传微信
  - 支持通过工具把本地文件发回微信用户
- 调试日志
  - 请求与响应自动写入 `logs/` 目录，便于排查问题

## 技术栈

- 前端: Vue 3, TypeScript, Vite
- 桌面端: Electron
- 网络请求: Axios
- Markdown 渲染: marked + DOMPurify
- 微信能力: @wechatbot/wechatbot

## 项目结构

```text
clawdiy/
├─ electron/                # Electron 主进程与 preload
├─ src/                     # Vue 渲染进程代码
│  ├─ services/             # 配置与 LLM 调用逻辑
│  └─ App.vue               # 主界面
├─ agent/                   # Agent 提示词、工具定义、技能索引
├─ skills/                  # 可扩展技能目录（每个技能一个子目录）
├─ logs/                    # 运行日志输出
├─ public/
├─ create_docx.py           # 示例脚本（生成 docx）
└─ package.json
```

## 环境要求

- Node.js 16+
- npm
- Windows（当前脚本对 Windows 开发体验做了适配）

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 启动开发模式（推荐）

```bash
npm run electron-dev
```

该命令会同时启动 Vite 与 Electron。

3. 首次启动后，在右上角点击“配置”填写模型参数。

## 配置说明

配置文件会在首次运行时自动创建，默认路径：

- `%APPDATA%\llm-chat-electron\llm.config.json`

示例：

```json
{
  "LLM_API_URL": "https://api.openai.com/v1/chat/completions",
  "LLM_MODEL": "gpt-4o-mini",
  "LLM_API_KEY": "your-api-key",
  "MAX_TOOL_ROUNDS": 8,
  "MAX_SKILL_READ_CALLS": 3
}
```

字段说明：

- `LLM_API_URL`: OpenAI 兼容聊天接口地址
- `LLM_MODEL`: 模型名称
- `LLM_API_KEY`: 接口密钥
- `MAX_TOOL_ROUNDS`: 单次请求允许的工具调用总次数上限
- `MAX_SKILL_READ_CALLS`: 单次请求允许读取 Skill 文档次数上限

## NPM 脚本

- `npm run dev`: 仅启动 Vite
- `npm run build`: 构建前端产物
- `npm run preview`: 预览构建产物
- `npm run electron`: 启动 Electron（基于已构建资源）
- `npm run electron-dev`: 开发模式（Vite + Electron）
- `npm run electron-build`: 构建并使用 electron-builder 打包

## 微信桥接说明

项目在启动时会尝试初始化微信机器人：

- 收到微信消息后，会在 UI 中显示并触发模型处理
- 模型回复会自动回发给对应微信用户
- 当 Agent 调用 `send_file_to_wechat` 工具时，可把本地文件发给微信用户

如果微信机器人未登录成功，应用的对话能力仍可正常使用。

## Skills 开发

### Skill 依赖预安装

使用相关 skill 前，建议先安装以下依赖：

```bash
npm install agent-browser
pip install python-docx
```

说明：

- `agent-browser`：用于浏览器自动化相关 skill（如 `skills/agent-browser`）
- `python-docx`：用于 DOCX 文档生成相关 skill（如 `skills/docx-generator-cn`）

1. 在 `skills/` 下创建技能目录，例如 `skills/my-skill/`
2. 添加 `SKILL.md`
3. 在应用中点击“刷新 skill”按钮
4. 系统会重建 `agent/available_skills.xml`

## 日志与排错

- 模型请求和响应日志位于 `logs/`
- 常见检查项：
  - API 地址和 Key 是否正确
  - 模型名是否可用
  - `MAX_TOOL_ROUNDS` 是否过小导致工具调用提前终止
  - Skill 文档是否存在且命名为 `SKILL.md`

## 常见问题

### 1) 启动后无法对话

通常是配置不完整。请在“配置”中填写 `LLM_API_URL`、`LLM_MODEL`、`LLM_API_KEY` 后保存。

### 2) 工具调用循环过多

可提高 `MAX_TOOL_ROUNDS`，或优化提示词，减少不必要的工具往返。

### 3) Skill 没被识别

确认目录结构为 `skills/<skill-name>/SKILL.md`，然后点击“刷新 skill”。

## 许可协议

MIT
