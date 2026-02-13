let selectedRole = {
    "system_prompt": "你将扮演如下角色：姓名：苏婉。身份：28岁，独立插画师，喜欢在午后晒太阳和喝手冲咖啡。\
            性格：温柔知性，情绪极其稳定，拥有一种让人静下来的魔力。不刻意讨好，但总能精准捕捉对方的情绪点。\
            语言风格：语速舒缓，喜欢用叠词或语气词（呢、呀、吧），但不过分卖萌。善于倾听，回复通常带有深意或安慰感。",
    "video_url": "https://matesx.oss-cn-beijing.aliyuncs.com/avatar/api/b4d284fa-d8a5-47f1-8365-1f0c2ed610b7/processed.webm",
    "video_asset_url": "https://matesx.oss-cn-beijing.aliyuncs.com/avatar/api/b4d284fa-d8a5-47f1-8365-1f0c2ed610b7/processed.gz",
};

localStorage.setItem('selectedRole', JSON.stringify(selectedRole));

characterVideo.addEventListener('loadedmetadata', () => {
                    console.log("loadedmetadata", characterVideo.videoWidth, characterVideo.videoHeight)
                    canvas_video.width = characterVideo.videoWidth;
                    canvas_video.height = characterVideo.videoHeight;
});

// 全局变量
let isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
// 初始化页面
document.addEventListener('DOMContentLoaded', function() {
    // 添加开始按钮事件
    document.getElementById('startMessage').addEventListener('click', async function() {
        this.style.display = 'none';
        document.getElementById('screen2').style.display = 'block';

        playCharacterVideo();
    });
});

async function loadSecret(secret) {
    try {
        let jsonString = secret;
        // 分配内存
        // 使用 TextEncoder 计算 UTF-8 字节长度
        function getUTF8Length(str) {
            const encoder = new TextEncoder();
            const encoded = encoder.encode(str);
            return encoded.length + 1; // +1 是为了包含 null 终止符
        }
        let lengthBytes = getUTF8Length(jsonString);
        let stringPointer = Module._malloc(lengthBytes);
        Module.stringToUTF8(jsonString, stringPointer, lengthBytes);
        Module._processSecret(stringPointer);
        Module._free(stringPointer);
    } catch (error) {
        console.error('Error loadSecret:', error);
        throw error;
    }
}
async function fetchVideoUtilData(gzipUrl) {
        // 从服务器加载 Gzip 压缩的 JSON 文件
        const response = await fetch(gzipUrl);
        const compressedData = await response.arrayBuffer();
        const decompressedData = pako.inflate(new Uint8Array(compressedData), { to: 'string' });
//        const combinedData = JSON.parse(decompressedData);
        return decompressedData;
}
async function newVideoTask() {
    try {
        console.log("selectedRole: ", selectedRole)

        const data_url = selectedRole.video_asset_url;
        let combinedData = await fetchVideoUtilData(data_url);
        await loadSecret(combinedData);
    } catch (error) {
        console.error('视频任务初始化失败:', error);
        alert(`操作失败: ${error.message}`);
    }
}

// 缓存已处理的视频URL
const videoURLCache = new Map();

// 播放角色视频
async function playCharacterVideo() {
    await newVideoTask();
    
    // 获取原始视频URL
    const originalVideoURL = selectedRole.video_url;
    let finalVideoURL = originalVideoURL;

    if (isiOS) {
        try {
             // 检查缓存中是否有处理过的URL
             if (!videoURLCache.has(originalVideoURL)) {
                 // 获取视频数据并创建同源URL
                 const response = await fetch(originalVideoURL, {
                     mode: 'cors',
                     credentials: 'omit'
                 });

                 if (!response.ok) throw new Error('视频获取失败');

                 // 将响应转为Blob
                 const blob = await response.blob();
                 // 创建同源对象URL
                 const blobURL = URL.createObjectURL(blob);

                 // 缓存结果
                 videoURLCache.set(originalVideoURL, blobURL);
             }

             // 使用缓存的同源URL
            finalVideoURL = videoURLCache.get(originalVideoURL);
        } catch (error) {
             console.warn('视频中转失败，使用原始URL:', error);
             // 失败时添加时间戳绕过缓存
             finalVideoURL = originalVideoURL + '?ts=' + Date.now();
        }
    }

    // 设置视频源（使用同源URL或带时间戳的原始URL）
    characterVideo.src = finalVideoURL;
    characterVideo.loop = true;
    characterVideo.muted = true;
    characterVideo.playsInline = true;

    characterVideo.load();
    console.log("characterVideo.load finished.");
    try {
        await characterVideo.play();
    } catch (e) {
        console.error('视频播放失败:', e);
    }
}
