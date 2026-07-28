
# StepFun Recorder

一个独立的复古 Mac 风格录音翻译机 UI 原型。

<img width="360" alt="StepFun Recorder desktop preview" src="https://github.com/user-attachments/assets/da835bc0-93c6-4d1e-a47d-71a830a56358" />

<img width="360" alt="StepFun Recorder mobile preview" src="https://github.com/user-attachments/assets/3be6794a-9eb8-4211-93c8-3e1e90d07606" />


## 预览

在仓库根目录运行：

```bash
node server.mjs
```

然后打开终端中显示的本地地址。

## 交互

- **REC / PAUSE**：连接 Realtime API，并开始或暂停麦克风录音。中文原文与英文翻译会同时显示。
- **STOP**：停止并保留当前屏幕内容。
- **REC 左右箭头**：停止后向前或向后查看已保存的对话轮次。
- **MENU**：在点阵屏中打开 Endpoint 与 API Key 设置。
- **Space**：快捷开始/暂停。
- **← / →**：停止后切换历史轮次。
- **Esc**：关闭设置菜单。

Endpoint 与 API Key 仅保存在浏览器的 `localStorage` 中。点击 REC 后，页面会
使用 Realtime API beta 的浏览器 WebSocket 子协议直接连接配置的 Endpoint
`/v1/realtime`，使用 `stepaudio-2.5-realtime`、文本模态、`server_vad`、
`interrupt: false` 和 `create_response: true`。

## Realtime API 如何实现 Recorder + Translator

这个产品不是“录完再上传”，而是在录音期间持续向 Realtime API 发送麦克风
音频。服务端判断每轮讲话的开始和结束，自动完成中文转写并生成英文译文：

```text
麦克风
  → PCM16 / 24 kHz / Mono
  → input_audio_buffer.append
  → StepFun Realtime API
  ├─ 中文转写：conversation.item.input_audio_transcription.*
  └─ 英文翻译：response.audio_transcript.*
  → Canvas 同时显示原文与译文
```

### 1. 连接和 Session 配置

页面连接：

```text
wss://api.stepfun.com/v1/realtime?model=stepaudio-2.5-realtime
```

连接成功后发送：

```js
{
  type: "session.update",
  session: {
    modalities: ["text"],
    instructions: "你是一名专业的中译英同声传译员……只输出英文译文。",
    input_audio_format: "pcm16",
    turn_detection: {
      type: "server_vad",
      interrupt: false,
      create_response: true
    }
  }
}
```

关键配置的含义：

- **`modalities: ["text"]`**：只接收文字翻译，不生成或播放模型语音。
- **`server_vad`**：由服务端判断用户何时开始和停止讲话，前端不需要自行切句。
- **`interrupt: false`**：下一段人声不会取消正在生成的上一轮翻译，确保每轮译文完整。
- **`create_response: true`**：VAD 检测到讲话结束后自动创建翻译响应，无需前端再发送 `response.create`。

这三个 VAD 配置组合后的行为是：

```text
检测到讲话 → 记录本轮 → 检测到静音 → 自动生成完整翻译 → 保存为一个 Round
```

### 2. 音频、原文和译文

浏览器把麦克风音频转换为 24 kHz 单声道 PCM16，并持续发送：

```js
{
  type: "input_audio_buffer.append",
  audio: "<Base64 PCM16>"
}
```

页面同时监听：

```text
conversation.item.input_audio_transcription.delta
conversation.item.input_audio_transcription.completed
response.audio_transcript.delta
response.audio_transcript.done
response.done
```

转写事件更新中文，`response.audio_transcript` 事件流式追加英文。两部分均完成后，
才一起保存为历史 `Round`，避免事件到达顺序不同导致其中一部分丢失。

### 3. INPUT LEVEL 与 VOICE 灯

- INPUT LEVEL 使用真实麦克风采样的 RMS 音量驱动。
- `input_audio_buffer.speech_started` 让 VOICE 绿灯亮起。
- `input_audio_buffer.speech_stopped` 让 VOICE 绿灯熄灭。

所以 VOICE 灯表示 **Server VAD 已确认当前输入为有效人声**，并不只是本地检测
到了较大的声音。

> 浏览器直连会让 API Key 存在于前端环境，适用于个人工具、原型或受控环境。
> 面向不可信用户公开部署时，应使用短期凭证或服务端中转。

Canvas 文字由浏览器端的 `pcf-font.js` 解析并绘制
`fonts/wenquanyi-bitmap-song.wqbm`。字体许可证副本保存在
`fonts/wenquanyi-bitmap-song-COPYING.txt`。

## 重新生成紧凑字体包

字体包可以从原始 PCF 可重复生成。默认会保留 13px 字体中的全部字形，
同时只从 9pt 装饰字体中提取本界面实际使用的字符：

```bash
node scripts/build-font-bundle.mjs
```

也可以指定输入和输出：

```bash
node scripts/build-font-bundle.mjs \
  --body path/to/body.pcf \
  --decor path/to/decor.pcf \
  --out fonts/custom.wqbm
```

如果需要自定义装饰字体字符集合：

```bash
node scripts/build-font-bundle.mjs \
  --decor-chars "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-/"
```

## License

StepFun Recorder is distributed under the GNU General Public License version 3
(`GPL-3.0-only`). The UI includes WenQuanYi Bitmap Song font data under the
GNU General Public License version 2 or any later version (`GPL-2.0-or-later`). The original license text is preserved
in `fonts/wenquanyi-bitmap-song-COPYING.txt`, and the compact bundle can be
reproduced with the build script above.
