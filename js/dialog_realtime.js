let server_url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
let api_key = "";
let isVoiceMode = true;                 // 默认使用语音模式
let llm_answer = "";
let cosyvoice = null;


// 录音阶段
let asr_audio_recorder = new PCMAudioRecorder();
let isRecording = false;     // 标记当前录音是否向ws传输
let asr_input_text = "";     // 从ws接收到的ASR识别后的文本
let isNewASR = true;          // 开启新一轮的ASR,ASR返回文本要重新单独显示
let last_voice_time = null;   // 上一次检测到人声的时间
let last_3_voice_samples = [];
const VAD_SILENCE_DURATION = 800;  // 800ms不说话判定为讲话结束
const asrVoiceQueue = []; // 人声数据队列
let isAsrProcessingQueue = false; // 队列处理状态
let isAsrRoundActive = false; // 控制ASR轮次活动的状态
let paraformer = null;
let isParaformerConnecting = false; // WebSocket连接状态


// SSE 阶段（申请流式传输LLM+TTS的阶段）
let sse_startpoint = true;                // SSE传输开始标志
let sse_endpoint = false;                 // SSE传输结束标志
let sse_controller = null;                // SSE网络中断控制器，可用于打断传输
let sse_data_buffer = "";                 // SSE网络传输数据缓存区，用于存储不完整的 JSON 块

// 播放音频阶段
let isPlaying = false; // 标记是否正在播放音频
let audioContext; // 定义在全局以便在用户交互后创建或恢复


const toggleButton = document.getElementById('toggle-button');
const inputArea = document.getElementById('input-area');
const chatContainer = document.getElementById('chat-container');
const sendButton = document.getElementById('send-button');
const textInput = document.getElementById('text-input');
const voiceInputArea = document.getElementById('voice-input-area');
const voiceInputText = voiceInputArea.querySelector('span'); // 获取显示文字的 span 元素

document.addEventListener('DOMContentLoaded', function() {
  if (!window.isSecureContext) {
    alert('本项目使用了 WebCodecs API，该 API 仅在安全上下文（HTTPS 或 localhost）中可用。因此，在部署或测试时，请确保您的网页在 HTTPS 环境下运行，或者使用 localhost 进行本地测试。');
  }
});

// 初始设置为语音模式
function setVoiceMode() {
    isVoiceMode = true;
    toggleButton.innerHTML = '<i class="material-icons">keyboard</i>';
    textInput.style.display = 'none';
    sendButton.style.display = 'none';
    voiceInputArea.style.display = 'flex';
    voiceInputText.textContent = '点击重新开始对话'; // 恢复文字
}

// 初始设置为文字模式
function setTextMode() {
    isVoiceMode = false;
    toggleButton.innerHTML = '<i class="material-icons">mic</i>';
    textInput.style.display = 'block';
    sendButton.style.display = 'block';
    voiceInputArea.style.display = 'none';
}

// 切换输入模式
toggleButton.addEventListener('click', () => {
    console.log("toggleButton", isVoiceMode)
    if (isVoiceMode) {
        setTextMode();
    } else {
        setVoiceMode();
    }
});

async function getTempToken(model_name, voice_id) {
    const apiKeyInput = window.parent.document.getElementById('api-key');
    api_key = apiKeyInput ? apiKeyInput.value.trim() : null;
    if (!api_key)
    {
        alert("尚未配置api key");
    }
    return api_key;
}

async function running_audio_recorder() {
    await asr_audio_recorder.connect(async (pcmData) => {
            last_3_voice_samples.push(pcmData);
            if (last_3_voice_samples.length > 3) {
                last_3_voice_samples = last_3_voice_samples.slice(-3);
            }

            console.log('recording and send audio', pcmData.length, isRecording);

            // PCM数据处理,只取前 512 个 int16 数据
            const uint8Data = new Uint8Array(pcmData.buffer, 0, 512 * 2);
            const arrayBufferPtr = parent.Module._malloc(uint8Data.byteLength);
            parent.Module.HEAPU8.set(uint8Data, arrayBufferPtr);

            // VAD检测,speech_score(0-1)代表检测到人声的置信度
            const speech_score = parent.Module._getAudioVad(arrayBufferPtr, uint8Data.byteLength);
            parent.Module._free(arrayBufferPtr); // 确保内存释放

            // console.log('VAD Result:', speech_score);
            let current_time = Date.now();
            if (speech_score > 0.5 && last_3_voice_samples.length > 1)
            {
                if (!isRecording)
                {
                    isRecording = true;
                    // 先发送两个历史语音，保证ASR不会遗漏首字符
                    if (last_3_voice_samples && last_3_voice_samples.length >= 2) {
                        asrVoiceQueue.push(last_3_voice_samples[0]);
                        asrVoiceQueue.push(last_3_voice_samples[1]);
                    }
                }
                asrVoiceQueue.push(pcmData);
                last_voice_time = current_time;
            }
            else {
                if (isRecording) {
                    if (last_voice_time && (current_time - last_voice_time) > VAD_SILENCE_DURATION) {
                        isRecording = false;
                        last_voice_time = null;
                        console.log("Voice activity ended");
                        asrVoiceQueue.push("vad");
                        // 先停止录音
                        await asr_audio_recorder.stop();
                    } else {
                        asrVoiceQueue.push(pcmData);
                    }
                }
            }
        });
}

async function new_asr_ws() {
    // 清理旧实例 - 仅在连接存在时关闭
    if (paraformer && paraformer.isConnected) {
        try {
            await paraformer.close();
        } catch (e) {
            console.warn("关闭旧ASR连接时出错:", e);
        }
    }

    paraformer = null;
    const token = await getTempToken("ali", "");
    paraformer = new ParaformerRealtime(`wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=${token}`);
    await paraformer.connect(async (payload, end_tag) => {
        if (end_tag) {
            // 先停止paraformer
            try {
                if (paraformer && paraformer.isConnected) {
                    await paraformer.close();
                }
            } catch (e) {
                console.warn("关闭ASR连接时出错:", e);
            } finally {
                paraformer = null;
            }
            if (asr_input_text) {
                addMessage(asr_input_text, true, true);
            }
            sendTextMessage(asr_input_text);
            // 停止本轮ASR处理
            isAsrRoundActive = false;
            return;
        }
        asr_input_text = payload.output.sentence.text;
        console.log("ASR Result:", asr_input_text);
    });
}

// 消费者循环 - 处理人声队列
async function processInputVoiceQueue() {
    isAsrProcessingQueue = true;

    while (isAsrRoundActive) {
        if (asrVoiceQueue.length === 0) {
            // 队列为空时短暂等待
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
        }
        const data = asrVoiceQueue.shift();

        // 确保WebSocket连接已建立
        if (!paraformer || !paraformer.isConnected) {
            if (!isParaformerConnecting) {
                isParaformerConnecting = true;
                try {
                    await new_asr_ws();
                } catch (error) {
                    console.error('ASR连接失败:', error);
                    isAsrRoundActive = false; // 出错时停止循环
                }
                isParaformerConnecting = false;
            }
            // 等待连接就绪
            await new Promise(resolve => setTimeout(resolve, 50));
            continue;
        }
        if (data === "vad") {
            // 发送停止信号
            await paraformer.stop();
            asrVoiceQueue.length = 0;
            // 停止本轮ASR处理
            // 不立即关闭连接，等待服务端结束信号
        } else {
            // 发送音频数据
            paraformer.sendAudio(data);
        }
    }

    isAsrProcessingQueue = false;
}


async function start_new_round() {
    // 停止可能存在的旧轮次
    isAsrRoundActive = false;
    // 等待旧轮次完全停止
    while (isAsrProcessingQueue) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    // 重置状态
    isRecording = false;
    isNewASR = true;
    asr_input_text = "";
    last_voice_time = null;

    // 清空队列
    asrVoiceQueue.length = 0;



    // TTS部分保持不变
    if (cosyvoice && cosyvoice.socket) {
        await cosyvoice.close();
    }

    if (isVoiceMode) {
        // 设置本轮ASR活动状态
        isAsrRoundActive = true;
        console.log("start_new_round")
        // 确保语音消费者循环已启动
        if (!isAsrProcessingQueue) {
            console.log("processInputVoiceQueue")
            processInputVoiceQueue();
        }
        await running_audio_recorder();
    }
}

// 语音输入逻辑
voiceInputArea.addEventListener('click', async (event) => {
    event.preventDefault(); // 阻止默认行为
    console.log("voiceInputArea click")
    await user_abort();
    voiceInputText.textContent = '点击重新开始对话'; // 恢复文字
    await start_new_round();
});

// 文字输入逻辑
sendButton.addEventListener('click', (e) => {
    const icon = sendButton.querySelector('i.material-icons');
    // 检查是否存在图标且图标内容为 'stop'
    if (icon && icon.textContent.trim() === 'stop') {
        user_abort();
        return;
    }
    const inputValue = textInput.value.trim();
    if (inputValue) {
        addMessage(inputValue, true, true);
        sendTextMessage(inputValue);
    }
});
textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const inputValue = textInput.value.trim();
        if (inputValue) {
            addMessage(inputValue, true, true);
            sendTextMessage(inputValue);
        }
    }
});

// 添加消息到聊天记录
function addMessage(message, isUser, isNew, replace=false) {
    if (isNew) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');
        messageElement.classList.add(isUser ? 'user' : 'ai');
        messageElement.innerHTML = `
            <div class="message-content">${message}</div>
        `;
        chatContainer.appendChild(messageElement);
    } else {
        // 直接操作 innerHTML 或使用 append 方法
        const lastMessageContent = chatContainer.lastElementChild.querySelector('.message-content');
        if (replace)
        {
            lastMessageContent.innerHTML = message;
        }
        else
        {
            lastMessageContent.innerHTML += message;
        }
    }
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// 初始设置为语音模式
setVoiceMode();

function initAudioContext() {
    if (!audioContext || audioContext.state === 'closed') {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

async function handleResponseStream(responseBody, isNewSession) {
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            const chunk = decoder.decode(value, { stream: true });
            sse_data_buffer += chunk; // 将新数据追加到缓存区

            // 根据换行符拆分缓存区中的数据
            const lines = sse_data_buffer.split("\n");
            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (!line || line === 'data: [DONE]') continue;

                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        if (data.choices?.[0]?.delta?.content) {
                            const text = data.choices[0].delta.content;
                            console.log("Received text:", text, sse_startpoint);
                            addMessage(text, false, sse_startpoint);
                            cosyvoice.sendText(text);
                            sse_startpoint = false;
                        }
                        // 处理结束标记
                        if (data.usage) {
                            console.log('Stream completed');
                            sse_endpoint = true;
                            await cosyvoice.stop();
                        }
                    } catch (error) {
                        console.error("Error parsing chunk:", error);
                    }
                }
            }
            // 将最后一个不完整的块保留在缓存区中
            sse_data_buffer = lines[lines.length - 1];
        }
    } catch (error) {
        console.error('流处理异常:', error);
    }
}

async function tts_realtime_ws(voice_id, model_name) {
    try {
        const token = await getTempToken(model_name, voice_id);
        cosyvoice = new Cosyvoice(`wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=${token}`, voice_id, "cosyvoice-v1");

        await cosyvoice.connect((pcmData) => {
            player.pushPCM(pcmData);
        });

        console.log('cosyvoice connected');
    } catch (error) {
        console.error('语音服务连接失败:', error);
        alert('语音服务连接失败，请检查网络后重试');
    }
}

// 发送文字消息
async function sendTextMessage(inputValue) {
    console.log("sendTextMessage", inputValue)

    const requestBody = {
        model: "qwen-plus", // 可按需更换模型
        messages: [
            { role: "system", content: "你是一个乐于助人的AI助手。" },
            { role: "user", content: inputValue }
        ],
        stream: true,
        stream_options: { include_usage: true }
    };

    let voice_id = "longwan";
    const voiceSelect = window.parent.document.getElementById('voice-select');
    if (voiceSelect) {
        voice_id = voiceSelect.value;
    }

    let tts_model = "ali";
    const token = await getTempToken("", voice_id);
    
    sendButton.innerHTML = '<i class="material-icons">stop</i>';
    initAudioContext();
    if (inputValue) {

        try {
            await tts_realtime_ws(voice_id, tts_model);
            player.connect()
            player.stop()

            sse_controller = new AbortController();
            sse_startpoint = true;
            sse_endpoint = false;
            textInput.value = "";
            const response = await fetch(server_url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(requestBody),
                signal: sse_controller.signal
            });

            if (!response.ok) throw new Error(`HTTP错误 ${response.status}`);
            await handleResponseStream(response.body, true);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('请求中止');
            } else {
                console.error('请求错误:', error);
            }
            await start_new_round();
        }
    }
    else
    {
        await start_new_round();
    }
}

// 用户中断操作
async function user_abort() {
    console.log("user_abort")
    // 停止ASR轮次
    isAsrRoundActive = false;
    if (isVoiceMode) {
        await asr_audio_recorder.stop();
        // 安全关闭ASR连接
        if (paraformer) {
            try {
                if (paraformer.isConnected) {
                    await paraformer.close();
                }
            } catch (e) {
                console.warn("中断时关闭ASR连接出错:", e);
            } finally {
                paraformer = null;
            }
        }
    }

    if (sse_controller)
    {
        sse_controller.abort();
    }
    player.stop();
    player.finished = true;
    parent.Module._clearAudio();
    isPlaying = false; // 标记音频播放结束
    sendButton.innerHTML = '<i class="material-icons">send</i>'; // 发送图标
}

class PCMAudioPlayer {
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.audioContext = null;
        this.audioQueue = [];
        this.isPlaying = false;
        this.currentSource = null;
        const bufferThreshold = 2;
        this.finished = true;
    }

    connect() {
        console.log("BBBB22");
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        this.finished = false;
    }

    pushPCM(arrayBuffer) {
        this.audioQueue.push(arrayBuffer);
        this._playNextAudio();
    }

    /**
     * 将arrayBuffer转为audioBuffer
     */
    _bufferPCMData(pcmData) {
        const sampleRate = this.sampleRate; // 设置为 PCM 数据的采样率
        const length = pcmData.byteLength / 2; // 假设 PCM 数据为 16 位，需除以 2
        const audioBuffer = this.audioContext.createBuffer(1, length, sampleRate);
        const channelData = audioBuffer.getChannelData(0);
        const int16Array = new Int16Array(pcmData); // 将 PCM 数据转换为 Int16Array

        for (let i = 0; i < length; i++) {
            // 将 16 位 PCM 转换为浮点数 (-1.0 到 1.0)
            channelData[i] = int16Array[i] / 32768; // 16 位数据转换范围
        }
        let audioLength = length/sampleRate*1000;
        console.log(`prepare audio: ${length} samples, ${audioLength} ms`)

        return audioBuffer;
    }

    async _playAudio(arrayBuffer) {
        if (this.finished)
        {
            return;
        }

        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        const view = new Uint8Array(arrayBuffer);
        const arrayBufferPtr = parent.Module._malloc(arrayBuffer.byteLength);
        parent.Module.HEAPU8.set(view, arrayBufferPtr);
        console.log("buffer.byteLength", arrayBuffer.byteLength);
        parent.Module._setAudioBuffer(arrayBufferPtr, arrayBuffer.byteLength);
        parent.Module._free(arrayBufferPtr);


        const audioBuffer = this._bufferPCMData(arrayBuffer);

        this.currentSource = this.audioContext.createBufferSource();
        this.currentSource.buffer = audioBuffer;
        this.currentSource.connect(this.audioContext.destination);

        this.currentSource.onended = () => {
            console.log('Audio playback ended.');
            this.isPlaying = false;
            this.currentSource = null;
            this._playNextAudio(); // Play the next audio in the queue
        };
        this.currentSource.start();
        this.isPlaying = true;
    }

    async _playNextAudio() {
        if (this.audioQueue.length > 0 && !this.isPlaying) {
            // 设置最大缓冲区大小（例如：10秒的音频）
            const maxBufferSize = 16000 * 10 * 2; // 16KHz × 10秒 × 2字节(16位)
            
            let combinedBuffer = new Uint8Array(0);
            let buffersToPlay = [];
        
            // 分批处理音频队列
            while (this.audioQueue.length > 0) {
                const buffer = this.audioQueue[0];
            
                // 如果添加这个缓冲区会超过最大大小，先播放当前的
                if (combinedBuffer.length + buffer.byteLength > maxBufferSize && combinedBuffer.length > 0) {
                    this._playAudio(combinedBuffer.buffer);
                    combinedBuffer = new Uint8Array(0);
                    // await this.delay(100); // 短暂延迟避免阻塞
                }
            
                // 将缓冲区添加到当前批次
                const newBuffer = new Uint8Array(combinedBuffer.length + buffer.byteLength);
                newBuffer.set(combinedBuffer, 0);
                newBuffer.set(new Uint8Array(buffer), combinedBuffer.length);
                combinedBuffer = newBuffer;
            
                buffersToPlay.push(this.audioQueue.shift());
            }
        
            // 播放剩余的音频
            if (combinedBuffer.length > 0) {
                this._playAudio(combinedBuffer.buffer);
            }
        } else {
            if (sse_endpoint && cosyvoice.isTaskFinished) {
                sendButton.innerHTML = '<i class="material-icons">send</i>';
                console.log("_playAudio Done!!!!");
                await start_new_round();
            }
        }
    }
    stop() {
        if (this.currentSource) {
            this.currentSource.stop(); // 停止当前音频播放
            this.currentSource = null; // 清除音频源引用
            this.isPlaying = false; // 更新播放状态
        }

        this.audioQueue = []; // 清空音频队列
        console.log('Playback stopped and queue cleared.');
    }
}

let player = new PCMAudioPlayer(16000);