// ═══════════════════════════════════════════════════════════════
// serial.js — 鱼竿 Arduino 通信模块
// 功能：WebSerial 双向通信（发送鱼种指令 + 接收FSR张力读值）
// 使用：import { rod } from './serial.js';
// ═══════════════════════════════════════════════════════════════

export class FishingRod {
  constructor() {
    this.port = null;
    this.connected = false;
    this._buf = '';
  }

  /**
   * 请求并连接 Arduino 串口
   * 需要在用户手势事件（如点击按钮）内调用
   */
  async connect() {
    if (!('serial' in navigator)) {
      console.warn('[FishingRod] WebSerial 不支持，请使用 Chrome 89+ 并开启 experimental web platform features');
      return false;
    }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600 });
      this.connected = true;
      console.log('[FishingRod] 已连接 Arduino');
      this._readLoop();
      return true;
    } catch (e) {
      console.warn('[FishingRod] 连接失败:', e.message);
      return false;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (this.port) {
      await this.port.close();
      this.port = null;
      this.connected = false;
    }
  }

  /**
   * 发送指令到 Arduino
   * @param {string} cmd  例如 'FISH:carp' / 'CATCH' / 'STOP'
   */
  async send(cmd) {
    if (!this.connected || !this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(cmd + '\n'));
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * 触发某种鱼的震动序列
   * @param {'carp'|'grass'|'goldfish'|'mandarin'|'crab'|'dragon'|'bass'|'nian'|'shrimp'} fishType
   */
  async vibrateFish(fishType) {
    await this.send(`FISH:${fishType}`);
  }

  /**
   * 触发钓到鱼的庆祝震动
   */
  async vibrateCatch() {
    await this.send('CATCH');
  }

  /**
   * 停止所有震动
   */
  async stop() {
    await this.send('STOP');
  }

  // ─── 内部：持续读取 Arduino 上报的 FSR 值 ───────────────────
  async _readLoop() {
    if (!this.port?.readable) return;
    const decoder = new TextDecoderStream();
    this.port.readable.pipeTo(decoder.writable);
    const reader = decoder.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this._buf += value;
        const lines = this._buf.split('\n');
        this._buf = lines.pop(); // 保留不完整的行
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('FSR:')) {
            const val = parseInt(trimmed.slice(4), 10);
            if (!isNaN(val)) {
              // 派发 fsr-update 事件，外部通过 window.addEventListener('fsr-update', e => ...) 监听
              // e.detail: 0-50 无张力 / 50-200 轻触 / 200-600 遛鱼中 / 600+ 快断线
              window.dispatchEvent(new CustomEvent('fsr-update', { detail: val }));
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('[FishingRod] 读取中断:', e.message);
    } finally {
      reader.releaseLock();
      this.connected = false;
    }
  }
}

// ─── 单例导出 ────────────────────────────────────────────────
export const rod = new FishingRod();

/*
──────────────────────────────────────────────────────────────
使用示例（在 app.js 中）：

  import { rod } from './serial.js';

  // 1. 在页面某个按钮点击事件内连接（必须有用户手势）
  document.getElementById('connect-btn').onclick = async () => {
    const ok = await rod.connect();
    if (ok) console.log('鱼竿已连接');
  };

  // 2. 进入 FISHING 状态时，根据鱼种触发震动
  rod.vibrateFish('carp');   // 锦鲤：强冲击逐渐衰减

  // 3. 钓到鱼时
  rod.vibrateCatch();

  // 4. 离开 FISHING 状态时
  rod.stop();

  // 5. 监听张力数据（用于调整UI张力计、鱼线动画）
  window.addEventListener('fsr-update', (e) => {
    const tension = e.detail; // 0-1023
    if (tension > 600) showLineBreakWarning();
    updateTensionMeter(tension / 1023);
  });

──────────────────────────────────────────────────────────────
启用 WebSerial（如报错）：
  地址栏输入: chrome://flags/#enable-experimental-web-platform-features
  → 开启 → 重启 Chrome
  Chrome 89+ 已默认支持，无需额外设置。
──────────────────────────────────────────────────────────────
*/
