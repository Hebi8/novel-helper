# Novel Helper 小说助手

[English](README.md)

在 VS Code 里写小说用的灰字续写，会参考你的设定。在章节里写到行尾停一下，灰字就会接出一句，按 **Tab** 收下。每次请求都会带上这一段需要的东西：光标前后的正文、光标附近出现的名字对应的设定条目、标了常驻的条目（文风要求、世界观总则）、本章大纲，以及前面几章的摘要或结尾。

看设定也只要一步：鼠标停在名字上出设定卡，按 **F12** 打开设定文件。

首先照顾中文长篇（一章一个文件、几百章、词之间没有空格），其他语言也能用。key 用你自己的：Anthropic、OpenAI、DeepSeek、Gemini，或者任何 OpenAI 兼容的端点，包括本地模型。

## 安装

1. 打出 `novel-helper-0.1.0.vsix`（见[从源码构建](#从源码构建)）。
2. VS Code 扩展视图 → `⋯` → **从 VSIX 安装…**，或者运行 `code --install-extension novel-helper-0.1.0.vsix`。用 Remote-SSH 时在远程窗口里装，扩展会跑在文件所在的机器上。

## 设置 API key

1. 命令面板 → **Novel Helper: 设置或清除 API key** → 选服务商 → 粘贴 key。
2. 用的不是 Anthropic 的话，把 `novelHelper.provider` 改成对应的服务商。

key 存在 VS Code 的密钥存储（系统钥匙串）里，不会写进设置。要删掉，再运行一次这个命令，输入框留空直接回车。

| 服务商 | `novelHelper.provider` | 默认模型 | 思考 |
|---|---|---|---|
| Anthropic | `anthropic` | `claude-haiku-5-5` | 关掉：`"thinking": {"type": "disabled"}` |
| OpenAI | `openai` | `gpt-6-luna` | 关掉：`"reasoning_effort": "none"` |
| DeepSeek | `deepseek` | `deepseek-flash` | 关掉：`"thinking": {"type": "disabled"}` |
| Gemini（OpenAI 兼容端点） | `gemini` | `gemini-3.5-flash-lite` | Gemini 3 关不掉；这个模型默认是最低的 `minimal` 档 |
| 本地模型或其他 OpenAI 兼容端点 | `openaiCompatible` | 填 `novelHelper.openaiCompatible.model` | 看服务端 |

服务商、模型、地址和 `extraRequestBody` 写在工作区设置里时，要信任这个文件夹才生效；受限模式下只认你的用户设置，没信任的文件夹没法把你的正文和 key 转发到别处。

换模型改 `novelHelper.<服务商>.model`。模型需要别的请求字段时，写进 `novelHelper.extraRequestBody`：它会合并进每次请求，值写 `null` 会去掉那个字段。比如 Claude Sonnet 5.5 不接受 `disabled`，要这样关思考：

```json
"novelHelper.anthropic.model": "claude-sonnet-5-5",
"novelHelper.extraRequestBody": { "thinking": { "type": "between_tools" } }
```

用 Ollama：`novelHelper.provider` 设成 `openaiCompatible`，`novelHelper.openaiCompatible.model` 填模型名；默认地址 `http://localhost:11434/v1` 就是 Ollama 的，不用 key。

## 工作区怎么摆

打开放小说的文件夹。默认的摆法如下，都能在设置里改：

```text
我的小说/
├── 设定/        设定条目，一条一个文件（也认：人物/ 角色/ 资料/ 世界观/ lore/ characters/ worldbuilding/）
│   ├── 文风.md
│   └── 雾港.md
├── 人物/
│   └── 林小满.md
├── 正文/        章节，一章一个文件（也认：章节/ chapters/ manuscript/）
│   ├── 第1章 雾里来信.md
│   └── 第2章 灯塔.md
├── 大纲/        和章节同名的文件就是那一章的大纲（也认：细纲/ outline/ outlines/）
│   └── 第2章 灯塔.md
└── 摘要/        和章节同名的文件就是那一章的摘要（也认：summary/ summaries/）
    └── 第1章 雾里来信.md
```

一条设定就是一个 Markdown（或 `.txt`）文件，文件名就是条目名。frontmatter 可写可不写：

```markdown
---
name: 林小满                 # 不写就用文件名
aliases: [小满, 林姑娘]      # 别名，正文里出现也算提到
type: 人物                   # 随便写，设定卡上会显示
always: true                 # 常驻：每次请求都带，适合文风要求、世界观总则
summary: 十七岁，雾港邮局的送信员……   # 有摘要时发摘要，不发下面的正文
---
条目正文。没有摘要时发正文的前 500 字。
```

章节按路径排序，数字按大小比：第2章 在 第10章 前面，第九章 在 第十二章 前面，卷二 在 卷十 前面。分卷放在子文件夹里时，大纲和摘要也可以照着分（`大纲/卷二/第1章.md` 对应 `正文/卷二/第1章.md`）。

## 写的时候

- 在章节文件的行尾停一下，750 毫秒后出灰字。**Tab** 收下；**Esc** 或者接着打字就放弃，还在跑的请求也会一起断掉。
- 在任何 Markdown 或纯文本文件里按 **Alt+\\**，马上要一条。
- 状态栏上的按钮显示开、关、请求中，点一下切换开关。`novelHelper.trigger` 设成 `manual` 就只在按 Alt+\\ 时请求。
- 灰字只给一句：到第一个 。！？…（连同后面的引号）为止，最多 60 字。模型回「好的，以下是续写：……」这类话时不显示。
- 输入法还在组字时（中文后面跟着拼音字母）不会自动发请求。

## 看喂了什么

命令面板 → **Novel Helper: 查看上次发给模型的内容**，打开一个只读页面，内容是上一次完成的请求：

- 带上了哪些条目，为什么带：常驻，还是哪些名字命中、命中几次、离光标多近、大纲里有没有提到；各用了多少字，用的是摘要还是正文；
- 哪些条目因为预算用完没带上；
- 用了哪个大纲、哪几章前文，各多少字；
- 完整的提示词、请求参数（不含 key）、模型原始返回、截成灰字后的结果，以及耗时。

模型没用上你以为它知道的设定时，看这一页就知道是名字没找到，还是预算满了。

## 一次请求里有什么

按下面的顺序排，变得最少的放最前面，支持前缀缓存的服务商能复用这一段（Anthropic 靠缓存断点，OpenAI、DeepSeek、Gemini 自动缓存）：

1. 指令和常驻条目。
2. 前面几章（有摘要用摘要，没有就用那一章的结尾）和本章大纲。
3. 名字或别名出现在光标前 3000 字里、或者出现在本章大纲里的条目。每处提到都算分，离光标越近分越高；按分数从高到低放，放满预算为止。
4. 光标前的正文，以及光标后的一小段。

名字按最长匹配：「张三丰」不会算成「张三」。含英文字母的名字不分大小写，而且要整词：`Al` 不会命中 `Also`。

## 看设定

- 在任何 Markdown 或纯文本文件里，鼠标停在名字或别名上就出设定卡；不用鼠标的话，光标放在名字上按 **Ctrl+K Ctrl+I**。
- **F12** 打开设定文件；**Alt+F12**（Linux 上是 **Ctrl+Shift+F10**）在原地展开，可以直接改。
- 设定文件保存、新建、改名、删除后马上生效。

## 设置项

| 设置 | 默认值 | |
|---|---|---|
| `novelHelper.enabled` | `true` | 灰字开关；点状态栏按钮也能切换 |
| `novelHelper.trigger` | `auto` | `auto`：章节文件行尾停顿时自动请求，另外任何地方都能按 Alt+\\；`manual`：只按 Alt+\\ |
| `novelHelper.debounceMs` | `750` | 停止打字后等多久发请求，毫秒 |
| `novelHelper.maxSuggestionChars` | `60` | 灰字最多几个字 |
| `novelHelper.provider` | `anthropic` | `anthropic`、`openai`、`deepseek`、`gemini`、`openaiCompatible` |
| `novelHelper.anthropic.model` | `claude-haiku-5-5` | |
| `novelHelper.openai.model` | `gpt-6-luna` | |
| `novelHelper.deepseek.model` | `deepseek-flash` | |
| `novelHelper.gemini.model` | `gemini-3.5-flash-lite` | |
| `novelHelper.openaiCompatible.baseUrl` | `http://localhost:11434/v1` | 写到 `/v1` |
| `novelHelper.openaiCompatible.model` | | |
| `novelHelper.extraRequestBody` | `{}` | 合并进每次请求体；`null` 去掉字段 |
| `novelHelper.files.lore` | `{设定,人物,角色,资料,世界观,lore,characters,worldbuilding}/**/*.{md,txt}` | glob，相对于工作区文件夹 |
| `novelHelper.files.chapters` | `{正文,章节,chapters,manuscript}/**/*.{md,txt}` | |
| `novelHelper.files.outlines` | `{大纲,细纲,outline,outlines}/**/*.{md,txt}` | |
| `novelHelper.files.summaries` | `{摘要,summary,summaries}/**/*.{md,txt}` | |
| `novelHelper.context.beforeChars` | `1500` | 发给模型的光标前正文 |
| `novelHelper.context.afterChars` | `200` | 发给模型的光标后正文 |
| `novelHelper.context.scanChars` | `3000` | 在光标前多少字里找名字 |
| `novelHelper.context.alwaysChars` | `1500` | 常驻条目的预算 |
| `novelHelper.context.matchedChars` | `2500` | 命中条目的预算 |
| `novelHelper.context.entryChars` | `500` | 每条最多取多少 |
| `novelHelper.context.outlineChars` | `800` | 本章大纲最多取多少 |
| `novelHelper.context.previousChapters` | `3` | 带前面几章 |
| `novelHelper.context.previousChapterChars` | `400` | 每个前面章节最多取多少 |

长度都按字算，一个汉字算一个。`files` 和 `context` 两组设置可以按工作区文件夹分别设。

## 试一下示例

1. 把本仓库的 [`examples/`](examples) 文件夹当工作区打开，设好 key。
2. 打开 `正文/第2章 灯塔.md`，光标放到最后一行末尾，等灰字出来。
3. 运行「查看上次发给模型的内容」看带了什么：「陆青山」按自己命中，没有算成「陆青」；潮汐钟是因为大纲里提到才带上的。

第1章 有摘要，第2章 没有：新建 `正文/第3章.md` 写几个字，它的请求里带的就是第2章 的结尾。

## 从源码构建

```sh
npm install
npm test
npx @vscode/vsce package
```

`npm test` 用 Node 自带的测试运行器跑单元测试，覆盖名字匹配、章节排序、预算裁剪、提示词拼装、句末截断，以及对着本地假服务测的模型客户端。

## 许可

[MIT](LICENSE)
