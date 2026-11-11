# Novel Helper 小说助手

[English](README.md)

在 VS Code 里写小说用的灰字续写，会参考你的设定。在章节里写到行尾停一下，灰字就会接出一句，按 **Tab** 收下。每次请求都会带上这一段需要的东西：本章已经写的正文、正文里出现的名字对应的设定条目、标了常驻的条目（文风要求、世界观总则）、全书到卷到本章的各层大纲，以及前面几章的摘要或结尾。花了多少 token、多少钱，随时能看。

看设定也只要一步：鼠标停在名字上出设定卡，按 **F12** 打开设定文件。

首先照顾中文长篇（一章一个文件、几百章、词之间没有空格），其他语言也能用。key 用你自己的：Anthropic、OpenAI、DeepSeek、Gemini，或者任何 OpenAI 兼容的端点，包括本地模型。

## 安装

1. 打出 `novel-helper-0.2.0.vsix`（见[从源码构建](#从源码构建)）。
2. VS Code 扩展视图 → `⋯` → **从 VSIX 安装…**，或者运行 `code --install-extension novel-helper-0.2.0.vsix`。用 Remote-SSH 时在远程窗口里装，扩展会跑在文件所在的机器上。

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

服务商、模型、地址、`extraRequestBody`、单价和日上限写在工作区设置里时，要信任这个文件夹才生效；受限模式下只认你的用户设置，没信任的文件夹没法把你的正文和 key 转发到别处，也没法取消你设的花费上限。

换模型改 `novelHelper.<服务商>.model`。模型需要别的请求字段时，写进 `novelHelper.extraRequestBody`：它会合并进每次请求，值写 `null` 会去掉那个字段。比如 Claude Sonnet 5.5 不接受 `disabled`，要这样关思考：

```json
"novelHelper.anthropic.model": "claude-sonnet-5-5",
"novelHelper.extraRequestBody": { "thinking": { "type": "between_tools" } }
```

用 Ollama：`novelHelper.provider` 设成 `openaiCompatible`，`novelHelper.openaiCompatible.model` 填模型名；默认地址 `http://localhost:11434/v1` 就是 Ollama 的，不用 key。

OpenAI 这一项按 GPT-5.6 及之后的模型发缓存断点（见[花多少钱](#花多少钱)）。更早的 OpenAI 模型不认这些字段，请用 `openaiCompatible`，地址填 `https://api.openai.com/v1`。

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
│   └── 第一卷 雾港/                 卷：一层文件夹
│       └── 第一幕 来信/             大章：卷下面再一层文件夹
│           ├── 第1章 雾里来信.md
│           └── 第2章 灯塔.md
├── 大纲/        （也认：细纲/ outline/ outlines/）
│   ├── 全书.md                      全书大纲（也认：总纲.md、book.md）
│   ├── 第一卷 雾港.md               卷纲：和卷的文件夹同名
│   └── 第一卷 雾港/
│       ├── 第一幕 来信.md           大章的大纲：和大章的文件夹同名
│       └── 第一幕 来信/
│           └── 第2章 灯塔.md        本章大纲：和章节同名
└── 摘要/        和章节同名的文件就是那一章的摘要（也认：summary/ summaries/）
    └── 第1章 雾里来信.md
```

写某一章时，它上面每一层的大纲都会自动带上：全书、卷、大章、本章。规则只有两条：

- **正文目录下的每一层文件夹就是一层**，层数不限：可以不分卷直接放章，可以只分卷，也可以卷下面再分大章、大章下面再分。
- **大纲文件和它对应的东西同名，放在大纲目录里同样的位置**：章的大纲和章节文件同名，一层的大纲和那层的文件夹同名（`正文/第一卷 雾港/` → `大纲/第一卷 雾港.md`）。全书大纲叫 `全书.md`，直接放在大纲目录下；这个名字可以在 `novelHelper.files.bookNames` 里改。

哪一层没有大纲文件就跳过，不影响别的层。大纲和摘要也可以放得比正文浅：`大纲/第31章.md`、`摘要/第31章.md` 对 `正文/卷二/第31章.md` 同样有效；两处都有时，用位置对得上的那个。别的卷里同名的文件不会被拿来用（`大纲/卷一/第1章.md` 不会配给 `正文/卷二/第1章.md`）。

不分卷、所有章节直接放在 `正文/` 下的摆法照常能用。

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

章节按路径排序，数字按大小比：第2章 在 第10章 前面，第九章 在 第十二章 前面，卷二 在 卷十 前面。

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
- 每一层大纲用了哪个文件、多少字、有没有被截断，哪一层没有大纲；用了哪几章前文，各多少字；
- 这次请求的用量：全价输入、缓存读取、缓存写入、输出各多少 token，按单价估出来的花费；
- 完整的提示词（按缓存断点分段）、请求参数（不含 key）、模型原始返回、截成灰字后的结果，以及耗时。

模型没用上你以为它知道的设定时，看这一页就知道是名字没找到，还是预算满了。

## 一次请求里有什么

按下面的顺序排，越不变的越靠前：

1. 指令和常驻条目。
2. 各层大纲，从大到小：全书、卷、大章；然后是前面几章（有摘要用摘要，没有就用那一章的结尾）和本章大纲。上层大纲各有字数上限，超了截断。
3. 名字或别名出现在本章光标前的正文里、或者出现在本章大纲里的条目。每处提到都算分，离光标越近分越高；预算不够时留分高的。上层大纲里的名字不算，不然全书大纲会把所有人物都带进来。
4. 本章正文，从章首到光标，以及光标后的一小段。

名字按最长匹配：「张三丰」不会算成「张三」。含英文字母的名字不分大小写，而且要整词：`Al` 不会命中 `Also`。

## 花多少钱

写一章要发很多次请求，每次的提示词大半和上一次相同。服务商对「和之前的请求开头相同的部分」按大约一成的价格收费（提示词缓存），所以提示词是按「上一次请求是下一次的开头」来排的：

- 正文从章首发起，不是只发光标前的一小段：往下写的时候，前面的内容一个字都不变。章节超过 `novelHelper.context.beforeChars`（默认 6000 字）时，每次从开头去掉三分之一，而不是每写一个字就挪一下。
- 设定条目排在正文前面，按在本章第一次出现的先后排：新提到一个名字，只是在末尾加一条。
- 正文按行切成每段三百来字，缓存断点放在各层大纲后面，以及最后两段写完的正文后面。每次请求从缓存读到上一个断点，再把新写完的一段写进缓存。

结果是：连着写的时候，一次请求里按全价算的只有正在写的那一小段（平均一两百字）和收尾的一句指令，其余都按缓存价。停下超过缓存的有效期再回来，第一次请求要把整个提示词重新写进缓存。

| 服务商 | 缓存怎么用上 | 有效期 | 默认模型的单价（每百万 token，美元；2026-11-12 查的官方定价） |
|---|---|---|---|
| Anthropic | 请求里标断点 | 5 分钟，每次命中续期 | 输入 0.10，缓存写入 0.125，缓存读取 0.01，输出 0.50 |
| OpenAI | 请求里标断点（GPT-5.6 及之后） | 30 分钟 | 输入 0.10，缓存写入 0.125，缓存读取 0.01，输出 0.50 |
| DeepSeek | 服务商自动认相同的开头，尽力而为 | 几小时到几天 | 输入 0.15，缓存命中 0.003，输出 0.60；周一到周五 UTC 01:00–04:00 和 06:00–10:00 加倍 |
| Gemini | 原生接口自动缓存；OpenAI 兼容端点官方没说 | | 输入 0.30，缓存 0.03，输出 2.50；有免费档 |

提示词太短时不进缓存（Anthropic 要 512 token 以上，OpenAI 1024）。

**看用量：**

- 鼠标停在状态栏的按钮上，看今天的请求数、各类 token 数和估算花费。
- 命令面板 → **Novel Helper: 查看用量和估算花费**，看今天和本月的明细，按服务商和模型分开，还有缓存读取占输入的比例。
- 「查看上次发给模型的内容」里有上一次请求的用量。

用量取自服务商对每次请求返回的数字。花费是 token 数乘单价，只是估算，以服务商的账单为准。几点说明：

- 被打字打断的请求会马上断开。这时服务商已经给了用量的照常计入（Anthropic 在流的开头就给输入用量，一般已经有了）；还没给的只算进请求数，用量记为「未知」。
- 灰字拿到一句就不再等后面的内容。Anthropic 在流的开头就给输入用量，所以马上断开，输出 token 按收到的文字估，页面上会标明是估的。OpenAI 兼容的接口在流的最后才给用量，所以拿到一句后连接会再留最多 2 秒等它；等不到就记为「未知」，不编数字。本地模型不等。
- 模型换成了默认以外的，扩展不知道单价，就只统计 token 数。要算花费，在 `novelHelper.usage.prices` 里填：

  ```json
  "novelHelper.usage.prices": {
    "claude-sonnet-5-5": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5 }
  }
  ```

- DeepSeek 的高峰时段按时间自动换算；中国法定节假日不算高峰，这一点没有处理。Gemini 按付费档算，用免费档时实际不花钱。
- 累计数存在扩展运行的那台机器上（用 Remote-SSH 时是远程机器），保留本月和上个月，所有窗口共用。

**日上限：** `novelHelper.usage.dailyLimitUsd` 填一个美元数，当天的估算花费到了就停止自动请求，状态栏会提示；按 **Alt+\\** 仍然可以手动要一条。默认 `0`，不限。没有单价的请求不计入。

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
| `novelHelper.usage.prices` | `{}` | 自己填的单价，按模型名，每百万 token 多少美元 |
| `novelHelper.usage.dailyLimitUsd` | `0` | 当天估算花费到这个数就停止自动请求；`0` 不限 |
| `novelHelper.files.lore` | `{设定,人物,角色,资料,世界观,lore,characters,worldbuilding}/**/*.{md,txt}` | glob，相对于工作区文件夹 |
| `novelHelper.files.chapters` | `{正文,章节,chapters,manuscript}/**/*.{md,txt}` | |
| `novelHelper.files.outlines` | `{大纲,细纲,outline,outlines}/**/*.{md,txt}` | |
| `novelHelper.files.summaries` | `{摘要,summary,summaries}/**/*.{md,txt}` | |
| `novelHelper.files.bookNames` | `全书`、`总纲`、`book` | 全书大纲的文件名（不含扩展名） |
| `novelHelper.context.beforeChars` | `6000` | 本章光标前的正文最多发多少；名字也在这段里找 |
| `novelHelper.context.afterChars` | `200` | 发给模型的光标后正文 |
| `novelHelper.context.alwaysChars` | `1500` | 常驻条目的预算 |
| `novelHelper.context.matchedChars` | `2500` | 命中条目的预算 |
| `novelHelper.context.entryChars` | `500` | 每条最多取多少 |
| `novelHelper.context.bookOutlineChars` | `1000` | 全书大纲最多取多少 |
| `novelHelper.context.levelOutlineChars` | `800` | 卷、大章这些中间层，每层的大纲最多取多少 |
| `novelHelper.context.outlineChars` | `800` | 本章大纲最多取多少 |
| `novelHelper.context.previousChapters` | `3` | 带前面几章 |
| `novelHelper.context.previousChapterChars` | `400` | 每个前面章节最多取多少 |

长度都按字算，一个汉字算一个。`files` 和 `context` 两组设置可以按工作区文件夹分别设。0.1.0 的 `novelHelper.context.scanChars` 已经去掉：名字现在在发出去的整段正文里找。

## 试一下示例

1. 把本仓库的 [`examples/`](examples) 文件夹当工作区打开，设好 key。
2. 打开 `正文/第一卷 雾港/第一幕 来信/第2章 灯塔.md`，光标放到最后一行末尾，等灰字出来。
3. 运行「查看上次发给模型的内容」看带了什么：全书大纲、「第一卷 雾港」和「第一幕 来信」的大纲、本章大纲各用了哪个文件；「陆青山」按自己命中，没有算成「陆青」；潮汐钟是因为本章大纲里提到才带上的。
4. 再要一条灰字，然后运行「查看用量和估算花费」，看第二次请求有多少输入是从缓存读的。

第1章 有摘要，第2章 没有：在同一个文件夹里新建 `第3章.md` 写几个字，它的请求里带的就是第2章 的结尾。

## 从源码构建

```sh
npm install
npm test
npx @vscode/vsce package
```

`npm test` 用 Node 自带的测试运行器跑单元测试，覆盖名字匹配、章节排序、各层大纲的对应、预算裁剪、提示词拼装和缓存断点、句末截断、用量和花费的计算，以及对着本地假服务测的模型客户端。

## 许可

[MIT](LICENSE)
