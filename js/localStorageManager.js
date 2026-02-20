let urlPrefix = "";
let serverUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
function getRoleList(avatar_mode) {
    if (avatar_mode === "public") {
        return JSON.parse(localStorage.getItem('public_roles_list')) || [];
    }
    else {
        return JSON.parse(localStorage.getItem('roles_list')) || [];
    }
}

// 存储临时token及其获取时间
let tempTokenCache = {
    model: null,
    token: null,
    timestamp: null
};

async function getTempToken(model_name, voice_id) {
    const apiKeyInput = window.parent.document.getElementById('api-key');
    let key_ = apiKeyInput ? apiKeyInput.value.trim() : null;
    if (!key_)
    {
        alert("尚未配置api key");
    }
    return key_;
}

function checkUnionid() {
    const unionid = localStorage.getItem('unionid');
    if (!unionid)
    {
        alert('用户未登录');
        return false;
    }
    return true;
}

function getRoleByID(avatar_mode, selectedRoleID) {
    let rolesList = [];
    if (avatar_mode === "public") {
        rolesList = JSON.parse(localStorage.getItem('public_roles_list')) || [];
    }
    else {
        rolesList = JSON.parse(localStorage.getItem('roles_list')) || [];
    }

    const selectedRole = rolesList.find(role => role.avatar_id === selectedRoleID);
    if (!selectedRole) {
        XSAlert('角色列表中未找到角色');
        return;
    }
    return selectedRole;
}

function getVoiceIDByID(cosyvoice_id) {
    let voice_id = "longwan";
    const voiceSelect = window.parent.document.getElementById('voice-select');
    if (voiceSelect) {
        voice_id = voiceSelect.value;
    }

    let tts_model = "ali";
    return [tts_model, voice_id];
}

async function sendChatRequest(requestBody, signal) {
    const token = await getTempToken("", "");
    const response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(requestBody),
        signal: signal
    });

    if (!response.ok) throw new Error(`HTTP错误 ${response.status}`);
    await handleResponseStream(response.body, signal);
}
