// ═══════════════════════════════════════════════════════════════
// 《钓一盏鱼灯》Arduino Nano 端
// 功能：接收网页 WebSerial 指令 → 播放震动序列
//       上报 FSR 张力读值 → 网页更新鱼线张力 UI
//
// 上传方式：Arduino IDE → 工具→开发板选"Arduino Nano"
//           处理器选"ATmega328P (Old Bootloader)"（CH340版本）
//           端口选对应 COM 口 → 上传
// ═══════════════════════════════════════════════════════════════

#define FSR_PIN   A0   // FSR402 分压输出
#define MOTOR_PIN  9   // 震动马达（PWM，接S8050基极驱动）

String inputBuffer = "";

void setup() {
  Serial.begin(9600);
  pinMode(MOTOR_PIN, OUTPUT);
  analogWrite(MOTOR_PIN, 0);
  // 启动自检：短震表示已就绪
  pulse(150, 100, 0, 1);
}

void loop() {
  // 每 50ms 向网页上报一次 FSR 张力值
  static unsigned long lastFSR = 0;
  if (millis() - lastFSR >= 50) {
    Serial.println("FSR:" + String(analogRead(FSR_PIN)));
    lastFSR = millis();
  }

  // 接收来自网页的换行结尾指令
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(inputBuffer);
      inputBuffer = "";
    } else if (c != '\r') {
      inputBuffer += c;
    }
  }
}

// ─── 指令分发 ────────────────────────────────────────────────
void handleCommand(String cmd) {
  cmd.trim();
  if      (cmd == "FISH:shrimp")   vibrate_shrimp();
  else if (cmd == "FISH:carp")     vibrate_carp();
  else if (cmd == "FISH:goldfish") vibrate_goldfish();
  else if (cmd == "FISH:grass")    vibrate_grass();
  else if (cmd == "FISH:crab")     vibrate_crab();
  else if (cmd == "FISH:mandarin") vibrate_mandarin();
  else if (cmd == "FISH:dragon")   vibrate_dragon();
  else if (cmd == "FISH:bass")     vibrate_bass();
  else if (cmd == "FISH:nian")     vibrate_nian();
  else if (cmd == "CATCH")         vibrate_catch();
  else if (cmd == "STOP")          analogWrite(MOTOR_PIN, 0);
}

// ─── 基础震动原语 ────────────────────────────────────────────
// strength: 0-255 (PWM占空比)
// onMs: 震动持续毫秒, offMs: 停顿毫秒, times: 重复次数
void pulse(int strength, int onMs, int offMs, int times) {
  for (int i = 0; i < times; i++) {
    analogWrite(MOTOR_PIN, strength);
    delay(onMs);
    analogWrite(MOTOR_PIN, 0);
    if (offMs > 0) delay(offMs);
  }
}

// ─── 各鱼种震动序列 ─────────────────────────────────────────
// 小虾：短促快速，轻盈
void vibrate_shrimp() {
  pulse(100, 20, 80, 8);
}

// 草鱼：缓慢沉稳，有分量
void vibrate_grass() {
  pulse(153, 600, 400, 3);
}

// 金鱼：中等节奏，优雅
void vibrate_goldfish() {
  pulse(120, 300, 200, 5);
}

// 鳜鱼：均匀密集，犟劲十足
void vibrate_mandarin() {
  pulse(140, 150, 150, 6);
}

// 螃蟹：不规律横冲，难以预判
void vibrate_crab() {
  for (int i = 0; i < 5; i++) {
    int on  = random(100, 500);
    int off = random(100, 300);
    pulse(165, on, off, 1);
  }
}

// 龙鱼：三次强冲 + 长震压制，威压感
void vibrate_dragon() {
  pulse(255, 100, 50, 3);
  delay(300);
  pulse(200, 800, 0, 1);
}

// 鲈鱼：一次猛冲 + 持续消耗
void vibrate_bass() {
  pulse(200, 800, 0, 1);
  pulse(150, 1500, 0, 1);
}

// 锦鲤：强冲击逐渐衰减，最具挑战
void vibrate_carp() {
  for (int s = 217; s > 80; s -= 30) {
    pulse(s, 200, 50, 1);
  }
}

// 鲢鱼：轻快多节奏，年年有余的喜气
void vibrate_nian() {
  pulse(130, 80, 120, 4);
  delay(200);
  pulse(180, 300, 100, 2);
}

// 钓到！庆祝震动（三连 + 长尾）
void vibrate_catch() {
  pulse(255, 100, 50, 3);
  delay(200);
  pulse(200, 500, 0, 1);
}
