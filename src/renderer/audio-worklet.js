// Собирает моно-поток в блоки по 100 мс и отдаёт их в основной поток.
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 1600; // 100 мс при 16 кГц
    this.buf = new Float32Array(this.blockSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;

    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      this.buf[this.filled++] = sample / channels;
      if (this.filled === this.blockSize) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-collector', PcmCollector);
