// pcm-player-worklet.js

class ChunkedAudioBuffer {
  constructor() {
    this.chunks = []; // Array of Int16Array
    this.totalSamples = 0;
  }

  write(data) {
    if (data.length === 0) return;
    this.chunks.push(new Int16Array(data)); // 复制一份（postMessage 已转移 buffer，但 data 是视图）
    this.totalSamples += data.length;
  }

  read(output, numSamples) {
    let read = 0;
    while (read < numSamples && this.chunks.length > 0) {
      const first = this.chunks[0];
      const toCopy = Math.min(first.length, numSamples - read);
      output.set(first.subarray(0, toCopy), read);
      read += toCopy;

      if (toCopy === first.length) {
        this.chunks.shift(); // 整块消费完
        this.totalSamples -= first.length;
      } else {
        // 剩余部分保留
        this.chunks[0] = first.subarray(toCopy);
        this.totalSamples -= toCopy;
      }
    }
    return read;
  }

  clear() {
    this.chunks = [];
    this.totalSamples = 0;
  }

  get availableRead() {
    return this.totalSamples;
  }
}

class PCMPlayerWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = null;
    this.sampleRate = 16000;
    this.isInitialized = false;
    this.isTaskFinished = false; // TTS已完成，等待播放结束

    this.port.onmessage = (event) => {
      const { type, data, sampleRate } = event.data;
      if (type === 'init') {
        this.sampleRate = sampleRate || 16000;
        this.buffer = new ChunkedAudioBuffer();
        this.isInitialized = true;
        this.isTaskFinished = false;
      } else if (type === 'audio') {
        if (this.buffer && data) {
          this.buffer.write(data);
        }
      } else if (type === 'clear') {
        this.buffer?.clear();
      } else if (type === 'task-finished') {
        // ✅ 接收到TTS任务结束信号
        this.isTaskFinished = true;
        console.log('[Worklet] 收到 task-finished，停止写入新音频');
        // 可选：通知主进程“播放也结束了”（当 buffer 被耗尽时）
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0]; // 单声道

    if (!this.isInitialized || !this.buffer) {
      channel.fill(0);
      return true;
    }

    const numFrames = channel.length;
    const tempBuffer = new Int16Array(numFrames);
    const readCount = this.buffer.read(tempBuffer, numFrames);

//    console.log("process", numFrames)
    // 转换为 float32 并填充
    for (let i = 0; i < numFrames; i++) {
      if (i < readCount) {
        channel[i] = tempBuffer[i] / 32768.0;
      } else {
        channel[i] = 0; // 静音
      }
    }

    const nowEmpty = this.buffer.availableRead === 0;
    if (this.isTaskFinished && nowEmpty) {
      // TTS已完成且音频缓存已空，则通知主线程：播放完成
      this.port.postMessage({ type: 'playbackComplete' });
      this.wasNotEmpty = false; // 避免重复发送
    }

    return true;
  }
}

registerProcessor('pcm-player-worklet', PCMPlayerWorklet);