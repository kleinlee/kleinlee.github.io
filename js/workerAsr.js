// 导入ParaformerRealtime类
importScripts('../js/paraformerRealtimeApi.js');

let paraformer = null;
let isConnected = false;
let audioQueue = [];

// 处理主线程发送的消息
self.onmessage = async function(event) {
    const data = event.data;
    
    if (data.type === 'start') {
        const token = data.apiKey;
        const wssUrl = `wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=${token}`;
        startASR(wssUrl);
    } 
    else if (data.type === 'audio') {
        handleAudioData(data.data);
    } 
    else if (data.type === 'stop') {
        stopASR();
    }
};

// 开始ASR识别
async function startASR(wssUrl) {
    paraformer = new ParaformerRealtime(wssUrl);
    
    try {
        postStatus('正在连接到ASR服务器...');
        await paraformer.connect(handleASRResult);
        isConnected = true;
        postStatus('已连接到ASR服务器');
        
        // 发送缓存的音频数据
        while (audioQueue.length > 0 && isConnected) {
            const audioData = audioQueue.shift();
            paraformer.sendAudio(audioData);
        }
    } catch (error) {
        isConnected = false;
        postError('连接ASR服务器失败: ' + error.message);
    }
}

// 处理音频数据
function handleAudioData(audioData) {
    if (isConnected) {
        paraformer.sendAudio(audioData);
    } else {
        // 如果尚未连接，将音频数据加入队列
        audioQueue.push(audioData);
    }
}

// 停止ASR识别
async function stopASR() {
    if (!isConnected || !paraformer) return;
    
    try {
        postStatus('正在结束识别任务...');
        await paraformer.stop();
        postStatus('识别任务已完成');
        isConnected = false;
    } catch (error) {
        postError('停止识别任务失败: ' + error.message);
    } finally {
        // 清理资源
        paraformer.close();
        audioQueue = [];
    }
}

// 处理ASR识别结果
function handleASRResult(payload, isFinal) {
    if (payload && payload.output.sentence) {
        const resultText = payload.output.sentence.text || '';
        
        if (isFinal) {
            self.postMessage({
                type: 'final_result',
                text: resultText
            });
        } else {
            self.postMessage({
                type: 'partial_result',
                text: resultText
            });
        }
    }
}

// 发送状态更新
function postStatus(message) {
    self.postMessage({
        type: 'status',
        message: message
    });
}

// 发送错误信息
function postError(message) {
    self.postMessage({
        type: 'error',
        message: message
    });
}