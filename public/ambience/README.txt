通话环境音 · 音源放置说明
========================

把音频放在本目录，文件名与下面一致（30~60 秒无缝循环）：

  rain      雨夜窗边：雨声 + 隐约车流
  cafe      咖啡厅：低嘈人声 + 杯碟轻响
  street    夜晚街道：人流 + 远处车声
  car       车内：引擎低鸣 + 路噪
  beach     海边：浪声 + 风
  bedroom   安静卧室：风扇/空调底噪（近似无声）
  station   车站/机场：广播 + 脚步人流

后缀支持 .wav / .mp3 / .ogg，按此顺序探测第一个存在的文件：
  - .wav（PCM）首选：没有编码器填充，配合 Web Audio 循环是采样级无缝；
  - .mp3 次选：有编码填充，现代浏览器解码时一般能吃掉；
  - .ogg 仅兜底：iOS Safari 不支持 Ogg，iPhone 上会静音。
体积参考：WAV 30 秒单声道 22.05kHz ≈ 1.3MB；MP3 128k 30 秒 ≈ 480KB。

说明：
- 想改场景名，改 lib/call-ambience.ts 里的 label。
- 文件缺失时该场景静音，不会报错、不影响通话。
- 播放走 Web Audio（decodeAudioData + AudioBufferSourceNode.loop），起停有 0.6s 淡入淡出；
  按住说话时自动压到 20%，避免被麦克风收进识别。
- 仍建议首尾电平接近（峰值 -12dB 左右），默认音量 35% 才不至于盖住人声。
- 用户选择与音量存在浏览器 localStorage（ai_phone_call_ambience_v1），跨通话记住。
