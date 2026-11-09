通话环境音 · 音源放置说明
========================

把音频放在本目录，文件名与下面一致（30~60 秒无缝循环）：

  rain      雨夜窗边：雨声 + 隐约车流      [rain.wav 已有]
  cafe      咖啡厅：低嘈人声 + 杯碟轻响     [cafe.mp3 已有]
  street    夜晚街道：人流 + 远处车声       [street.mp3 已有]
  car       车内：引擎低鸣 + 路噪           [car.mp3 已有]
  beach     海边：浪声 + 风                 [beach.mp3 已有]
  bedroom   安静卧室：风扇/空调底噪         [bedroom.mp3 已有]
  station   车站：站台人流 + 广播 + 列车     [station.mp3 已有]

现有 mp3 均由源视频切 45 秒生成（1.5s 首尾交叉淡化 + loudnorm -20 LUFS / -3 dBTP，
单声道 22.05kHz 80kbps ≈ 440KB）。

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
