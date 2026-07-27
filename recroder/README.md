
# Recroder UI

一个独立的复古 Mac 风格录音翻译机 UI 原型。

<img width="1412" height="1496" alt="SCR-20260728-epum" src="https://github.com/user-attachments/assets/bac7d53f-9669-481c-8d78-a49a9c377581" />

<img width="904" height="1650" alt="SCR-20260728-eqaj" src="https://github.com/user-attachments/assets/3be6794a-9eb8-4211-93c8-3e1e90d07606" />


## 预览

在仓库根目录运行：

```bash
node recroder/server.mjs
```

然后打开终端中显示的本地地址。

## 交互

- **REC / PAUSE**：开始或暂停模拟录音。原文与 AI 翻译会同时流式显示。
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

Canvas 文字由浏览器端的 `pcf-font.js` 解析并绘制
`fonts/wenquanyi-bitmap-song.wqbm`。字体许可证副本保存在
`fonts/wenquanyi-bitmap-song-COPYING.txt`。

## 重新生成紧凑字体包

字体包可以从原始 PCF 可重复生成。默认会保留 13px 字体中的全部字形，
同时只从 9pt 装饰字体中提取本界面实际使用的字符：

```bash
node recroder/scripts/build-font-bundle.mjs
```

也可以指定输入和输出：

```bash
node recroder/scripts/build-font-bundle.mjs \
  --body path/to/body.pcf \
  --decor path/to/decor.pcf \
  --out recroder/fonts/custom.wqbm
```

如果需要自定义装饰字体字符集合：

```bash
node recroder/scripts/build-font-bundle.mjs \
  --decor-chars "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-/"
```

## License

StepFun Recorder is distributed under the GNU General Public License version 3
(`GPL-3.0-only`). The UI includes WenQuanYi Bitmap Song font data under the
GNU General Public License version 2 or any later version (`GPL-2.0-or-later`). The original license text is preserved
in `fonts/wenquanyi-bitmap-song-COPYING.txt`, and the compact bundle can be
reproduced with the build script above.
