let urlPrefix = "";
let serverUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
let apiKey = "";

let isVoiceMode = true;                   // 默认使用语音模式

// 录音+vad+asr阶段
let asrAudioRecorder = new PCMAudioRecorder();
let isRecording = false;                  // 标记当前录音是否向ws传输
let asrText = "";                         // 从ws接收到的ASR识别后的文本
const VAD_SILENCE_DURATION = 800;         // 800ms不说话判定为讲话结束
let isAsrReady = false;                   // 标记ASR是否准备就绪
let pendingAudioData = [];                // 新增：缓存等待发送的语音数据
let asrWorker = null;

// SSE 阶段（申请流式传输LLM+TTS的阶段）
let sseStartpoint = true;                 // SSE传输开始标志
let sseController = null;                 // SSE网络中断控制器，可用于打断传输

// TTS 阶段
let cosyvoice = null;

// 播放音频阶段
let player = null;

const toggleButton = document.getElementById('toggle-button');
const inputArea = document.getElementById('input-area');
const chatContainer = document.getElementById('chat-container');
const sendButton = document.getElementById('send-button');
const textInput = document.getElementById('text-input');
const voiceInputArea = document.getElementById('voice-input-area');
const voiceInputText = voiceInputArea.querySelector('span');

document.addEventListener('DOMContentLoaded', function() {
    if (!window.isSecureContext) {
        alert('本项目使用了 WebCodecs API，该 API 仅在安全上下文（HTTPS 或 localhost）中可用。' +
              '因此，在部署或测试时，请确保您的网页在 HTTPS 环境下运行，或者使用 localhost 进行本地测试。');
    }
    // 初始设置为语音模式
    setVoiceMode();
});

// 语音模式
function setVoiceMode() {
    isVoiceMode = true;
    toggleButton.innerHTML = '<i class="material-icons">keyboard</i>';
    textInput.style.display = 'none';
    sendButton.style.display = 'none';
    voiceInputArea.style.display = 'flex';
    voiceInputText.textContent = '点击开始聊天'; // 恢复文字
    user_abort();
}

// 文字模式
function setTextMode() {
    isVoiceMode = false;
    toggleButton.innerHTML = '<i class="material-icons">mic</i>';
    textInput.style.display = 'block';
    sendButton.style.display = 'block';
    voiceInputArea.style.display = 'none';
    user_abort();
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

async function getTempToken() {
    const apiKeyInput = window.parent.document.getElementById('api-key');
    let key_ = apiKeyInput ? apiKeyInput.value.trim() : null;
    if (!key_)
    {
        alert("尚未配置api key");
    }
    return key_;
}

// 创建Web Worker
asrWorker = new Worker('js/workerAsr.js');

// 处理来自Worker的消息
asrWorker.onmessage = function(event) {
    const data = event.data;
    console.log("asrWorker.onmessage", data, data.type)
    if (data.type === 'status') {
        if (data.message === "识别任务已完成")
        {
            if (asrText) {
                addMessage(asrText, true, true);
                sendTextMessage(asrText);
            }
            else {
                user_abort();
                start_new_round();
            }
        }
        else if (data.message === "已连接到ASR服务器") {
            isAsrReady = true;

            // 发送所有缓存数据
            while (pendingAudioData.length > 0) {
                const data = pendingAudioData.shift();
                asrWorker.postMessage(
                    { type: 'audio', data: data },
                    [data.buffer]  // 转移所有权
                );
            }
        }
    }
    else if (data.type === 'partial_result') {
        asrText = data.text;
    }
    else if (data.type === 'final_result') {
        asrText = data.text;
    }
    else if (data.type === 'error') {
        console.error('ASR Worker Error:', data.message);
    }
};

async function running_audio_recorder() {
    let last_3_voice_samples = [];
    let last_voice_time = null;               // 上一次检测到人声的时间
    if (!asrAudioRecorder || !asrAudioRecorder.audioContext) {
        if (asrAudioRecorder.isConnecting) {
            return;
        }
        await asrAudioRecorder.connect(async (pcmData) => {
            const pcmCopy = new Int16Array(pcmData);
            last_3_voice_samples.push(pcmCopy);
            if (last_3_voice_samples.length > 3) {
                last_3_voice_samples = last_3_voice_samples.slice(-3);
            }

            // PCM数据处理,只取前 512 个 int16 数据
            const uint8Data = new Uint8Array(pcmData.buffer, 0, 512 * 2);
            const arrayBufferPtr = parent.Module._malloc(uint8Data.byteLength);
            parent.Module.HEAPU8.set(uint8Data, arrayBufferPtr);

            // VAD检测,speech_score(0-1)代表检测到人声的置信度
            const speech_score = parent.Module._getAudioVad(arrayBufferPtr, uint8Data.byteLength);
            parent.Module._free(arrayBufferPtr); // 确保内存释放
            let current_time = Date.now();

            if (speech_score > 0.5 && last_3_voice_samples.length > 1) {
                if (!isRecording) {
                    isRecording = true;
                    isAsrReady = false; // 重置准备状态
                    pendingAudioData.length = 0; // 清空缓存

                    // 1. 先缓存历史语音
                    if (last_3_voice_samples.length >= 2) {
                        pendingAudioData.push(last_3_voice_samples[0]);
                        pendingAudioData.push(last_3_voice_samples[1]);
                    }
                    apiKey = await getTempToken();
                    asrWorker.postMessage({ type: 'start', apiKey: apiKey });
                }
                if (isAsrReady) {
                    asrWorker.postMessage(
                        { type: 'audio', data: pcmData },
                        [pcmData.buffer] // 转移所有权
                    );
                }
                else {
                    pendingAudioData.push(pcmCopy);
                }
                last_voice_time = current_time;
            }
            else {
                if (isRecording) {
                    if (last_voice_time && (current_time - last_voice_time) > VAD_SILENCE_DURATION && isAsrReady) {
                        isRecording = false;
                        last_voice_time = null;
                        console.log("Voice activity ended");
                        asrWorker.postMessage({ type: 'stop' });
                        await asrAudioRecorder.stop();
                    } else {
                        asrWorker.postMessage({
                            type: 'audio',
                            data: pcmData
                        }, [pcmData.buffer]); // 转移ArrayBuffer所有权
                    }
                }
            }
        });
    }
}

async function start_new_round() {

    // 停止可能存在的旧轮次
    asrWorker.postMessage({ type: 'stop' });

    // 重置状态
    isRecording = false;

    asrText = "";
    parent.Module._clearAudio();

    // TTS部分保持不变
    if (cosyvoice && cosyvoice.socket) {
        await cosyvoice.close();
    }


    if (isVoiceMode) {
        console.log("start_new_round")
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

let isSendProcessing = false;

// 提取的共同处理函数
async function handleUserMessage() {
    if (isSendProcessing) return false;
    isSendProcessing = true;
    sendButton.disabled = true;
    textInput.disabled = true;

    const icon = sendButton.querySelector('i.material-icons');
    try {
    // 检查停止状态
    if (icon && icon.textContent.trim() === 'stop') {
        user_abort();
        return false; // 表示未发送消息
    }

    const inputValue = textInput.value.trim();
    if (inputValue) {
        await start_new_round();
        addMessage(inputValue, true, true);
        await sendTextMessage(inputValue);
        return true; // 表示已发送消息
    }
    return false; // 表示未发送消息
    } finally {
        isSendProcessing = false;
        sendButton.disabled = false;
        textInput.disabled = false;
        textInput.focus(); // 重新聚焦到输入框
    }
}

// 修改后的事件监听器
sendButton.addEventListener('click', async (event) => {
    await handleUserMessage();
});

textInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
        const shouldPreventDefault = await handleUserMessage();
        if (shouldPreventDefault) {
            e.preventDefault(); // 仅在发送消息时阻止默认换行行为
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

async function handleResponseStream(responseBody, signal) {
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let sseDataBuffer = "";  // SSE网络传输数据缓存区，用于存储不完整的 JSON 块
    try {
        while (true) {
            if (signal.aborted) {
                reader.cancel(); // 主动取消流读取
                break;
            }
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            const chunk = decoder.decode(value, { stream: true });
            sseDataBuffer += chunk; // 将新数据追加到缓存区

            // 根据换行符拆分缓存区中的数据
            const chunks = sseDataBuffer.split("\n");
            for (let i = 0; i < chunks.length - 1; i++) {
                try {
                    const line = chunks[i].trim();
                    if (!line || line === 'data: [DONE]') continue;

                    if (line.startsWith('data: ')) {
                        const data = JSON.parse(line.substring(6));
                        if (data.choices?.[0]?.delta?.content) {
                            const text = data.choices[0].delta.content;
                            console.log("Received text:", text, sseStartpoint, sendButton.disabled);
                            addMessage(text, false, sseStartpoint);
                            cosyvoice.sendText(text);
                            sseStartpoint = false;
                        }
                        if (data.usage) {
                            console.log('Stream completed');
                            await cosyvoice.stop();
                        }
                    }
                } catch (error) {
                    console.error("Error parsing chunk:", error);
                }
            }
            // 将最后一个不完整的块保留在缓存区中
            sseDataBuffer = chunks[chunks.length - 1];
        }
    } catch (error) {
        console.error('流处理异常:', error);
    }
}

async function tts_realtime_ws(voice_id, model_name) {
    try {
        let cosyvoice_model = "cosyvoice-v2";
        apiKey = await getTempToken();
        const wssUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=${apiKey}`;
        cosyvoice = new Cosyvoice(wssUrl, voice_id, cosyvoice_model);

        await cosyvoice.connect(
            (pcmData) => {
                player.pushPCM(pcmData);
            },
            () => {
                console.log('✅ 语音合成任务已结束！');
                // 可以在这里：停止 loading 动画、提示播放完成、释放资源等
                player.sendTtsFinishedMsg();
            }
        );

        console.log('cosyvoice connected');
    } catch (error) {
        console.error('语音服务连接失败:', error);
        alert('语音服务连接失败，请检查网络后重试');
    }
}

// 发送文字消息
async function sendTextMessage(inputValue) {
    console.log("sendTextMessage", inputValue)

    let selectedRole = JSON.parse(localStorage.getItem('selectedRole'));
    let system_prompt = selectedRole.system_prompt;
    if (!system_prompt)
    {
        system_prompt = "你是一个乐于助人的AI助手。";
    }

    const requestBody = {
        model: "qwen-plus", // 可按需更换模型
        messages: [
            { role: "system", content: system_prompt },
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
    sendButton.disabled = false;
    console.log("sendButton.disabled", sendButton.disabled)
    if (inputValue) {
        try {
            if (sseController) {
                console.log("sseController abort!");
                sseController.abort();
            }

            if (!player) {
                player = new PCMAudioPlayer(16000);
            }
            await player.connect();

            await tts_realtime_ws(voice_id, tts_model);
            sseController = new AbortController();
            sseStartpoint = true;
            textInput.value = "";
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(requestBody),
                signal: sseController.signal
            });

            if (!response.ok) throw new Error(`HTTP错误 ${response.status}`);
            await handleResponseStream(response.body, sseController.signal);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('请求中止');
            } else {
                console.error('请求错误:', error);
            }
            await start_new_round();
        }
    }
    else {
        await start_new_round();
    }
}

// 用户中断操作
async function user_abort() {
    console.log("user_abort")
    // 停止ASR轮次
    asrWorker.postMessage({ type: 'stop' });
    // 停止录音
    if (isVoiceMode) {
        if (asrAudioRecorder?.audioContext) {
            asrAudioRecorder.stop();
        }
    }
    // 停止llm sse传输
    if (sseController) {
        console.log("sseController abort");
        sseController.abort();
    }
    // 停止tts
    if (cosyvoice && cosyvoice.socket) {
        await cosyvoice.close();
    }
    // 停止播放音频
    if (player) {
        await player.stop();
        parent.Module._clearAudio();
    }
    sendButton.innerHTML = '<i class="material-icons">send</i>'; // 发送图标
}
