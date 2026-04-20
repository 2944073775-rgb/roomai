process.on('unhandledRejection', (e) => console.error('UNHANDLED:', e));

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { Jimp, ResizeStrategy } = require('jimp');

// ========== OpenRouter 配置 ==========
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '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';

// ========== DeepSeek 配置 ==========
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || 'sk-ac712750f2114584b79c0e6c79511ee7';

// ========== OpenAI DALL-E 2 配置 (备用) ==========
const OPENAI_KEY = process.env.OPENAI_KEY || '';

// 火山引擎 API 签名
function volcSign(method, path, query, body, date) {
    const secretKey = Buffer.from(VOLC_SECRET_KEY, 'base64');
    const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
    const signedHeaders = 'content-type;host;x-date';
    const host = 'imagex.volcengineapi.com';
    
    const strToSign = method + '\n' + path + '\n' + query + '\n' + 
        'content-type:application/json\n' +
        'host:' + host + '\n' +
        'x-date:' + date + '\n' +
        bodyHash;
    
    const signature = crypto.createHmac('sha256', secretKey).update(strToSign).digest('base64');
    
    const credential = VOLC_ACCESS_KEY + '/' + date.substring(0, 8) + '/cn-north-1/imagex/vpce_request';
    
    return 'HMAC-SHA256 Credential=' + credential + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
}

// 读取本地文件
function readFileBuffer(filepath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filepath, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

// 下载图片
function downloadImage(imageUrl) {
    return new Promise((resolve, reject) => {
        try {
            const parsedUrl = new URL(imageUrl);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET'
            };

            const imgReq = https.request(options, (imgRes) => {
                if (imgRes.statusCode >= 300 && imgRes.statusCode < 400 && imgRes.headers.location) {
                    downloadImage(imgRes.headers.location).then(resolve).catch(reject);
                    return;
                }
                const chunks = [];
                imgRes.on('data', chunk => chunks.push(chunk));
                imgRes.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const contentType = imgRes.headers['content-type'] || 'image/png';
                    resolve({ buffer, contentType });
                });
            });

            imgReq.on('error', reject);
            imgReq.end();
        } catch (e) {
            reject(e);
        }
    });
}

// 调用 OpenAI DALL-E 2 图像编辑
function callDalle2Edit(imageBuffer, maskBuffer, prompt, size) {
    return new Promise((resolve, reject) => {
        const boundary = '----DalleBoundary' + Date.now();
        const CRLF = '\r\n';
        
        // size 必须是 DALL-E 支持的: 256x256, 512x512, 1024x1024
        const dallESize = size && ['256x256', '512x512', '1024x1024'].includes(size) ? size : '1024x1024';

        const bodyParts = [
            Buffer.from('--' + boundary + CRLF +
                'Content-Disposition: form-data; name="image"; filename="image.png"' + CRLF +
                'Content-Type: image/png' + CRLF + CRLF),
            imageBuffer,
            Buffer.from(CRLF + '--' + boundary + CRLF +
                'Content-Disposition: form-data; name="mask"; filename="mask.png"' + CRLF +
                'Content-Type: image/png' + CRLF + CRLF),
            maskBuffer,
            Buffer.from(CRLF + '--' + boundary + CRLF +
                'Content-Disposition: form-data; name="prompt"' + CRLF + CRLF +
                prompt),
            Buffer.from(CRLF + '--' + boundary + CRLF +
                'Content-Disposition: form-data; name="n"' + CRLF + CRLF + '1'),
            Buffer.from(CRLF + '--' + boundary + CRLF +
                'Content-Disposition: form-data; name="size"' + CRLF + CRLF + dallESize),
            Buffer.from(CRLF + '--' + boundary + CRLF +
                'Content-Disposition: form-data; name="model"' + CRLF + CRLF + 'dall-e-2'),
            Buffer.from(CRLF + '--' + boundary + '--' + CRLF)
        ];

        const body = Buffer.concat(bodyParts);

        const options = {
            hostname: 'api.openai.com',
            path: '/v1/images/edits',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + OPENAI_KEY,
                'Content-Type': 'multipart/form-data; boundary=' + boundary
            }
        };

        console.log('Calling DALL-E 2...');
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                try {
                    const json = JSON.parse(buf.toString('utf8'));
                    if (json.error) {
                        reject(new Error('DALL-E 2: ' + json.error.message));
                    } else if (json.data && json.data[0] && json.data[0].url) {
                        // 下载 DALL-E 返回的图片并转为 base64
                        const imageUrl = json.data[0].url;
                        console.log('Downloading from:', imageUrl.substring(0, 80) + '...');
                        return downloadImage(imageUrl).then(imgData => {
                            resolve(imgData.buffer.toString('base64'));
                        }).catch(e => reject(e));
                    } else {
                        reject(new Error('DALL-E 2: unknown response'));
                    }
                } catch(e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('DALL-E 2 超时')); });
        req.write(body);
        req.end();
    });
}

// ========== 火山引擎 veImageX 图像消除 ==========
async function callVolcImageErase(imageBuffer, maskBuffer, maskBounds) {
    return new Promise((resolve, reject) => {
        if (!VOLC_SERVICE_ID) {
            reject(new Error('请先配置 VOLC_SERVICE_ID'));
            return;
        }
        
        // 如果有遮罩，需要先上传图片获取 URI
        // 这里简化处理：假设图片已经是公网可访问的 URL 或者通过其他方式上传
        // 实际使用时需要先上传图片到 veImageX 获取 StoreUri
        
        const body = {
            ServiceId: VOLC_SERVICE_ID,
            StoreUri: 'uploads/temp_' + Date.now() + '.png',
            Model: 'eraser_model_imagex_0.1.0'
        };
        
        // 如果有遮罩 bounds，添加到请求中
        if (maskBounds) {
            body.BBox = maskBounds;
        }
        
        const bodyStr = JSON.stringify(body);
        const date = new Date().toUTCString();
        
        // 简化签名（实际生产应该用完整的签名算法）
        const options = {
            hostname: 'imagex.volcengineapi.com',
            path: '/?Action=GetImageEraseResult&Version=2023-05-01',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                'X-Date': date,
                'Authorization': 'HMAC-SHA256 Credential=' + VOLC_ACCESS_KEY
            }
        };
        
        console.log('Calling Volcanic Engine ImageErase...');
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ResponseMetadata && json.ResponseMetadata.Error) {
                        reject(new Error('VeImageX: ' + json.ResponseMetadata.Error.Message));
                    } else if (json.Result && json.Result.ResUri) {
                        resolve(json.Result.ResUri);
                    } else {
                        reject(new Error('VeImageX: unknown response'));
                    }
                } catch(e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('VeImageX 超时')); });
        req.write(bodyStr);
        req.end();
    });
}

// ========== OpenRouter 图像编辑 ==========
function callOpenRouterEdit(imageBuffer, prompt) {
    return new Promise((resolve, reject) => {
        const imgBase64 = imageBuffer.toString('base64');
        
        const body = JSON.stringify({
            model: 'sourceful/riverflow-v2-fast',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: {
                                url: 'data:image/png;base64,' + imgBase64,
                                detail: 'high'
                            }
                        },
                        {
                            type: 'text',
                            text: prompt
                        }
                    ]
                }
            ]
        });

        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + OPENROUTER_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        console.log('Calling OpenRouter for image editing...');
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error('OpenRouter: ' + json.error.message));
                    } else if (json.choices && json.choices[0].message) {
                        const msg = json.choices[0].message;
                        if (msg.images && msg.images.length > 0) {
                            const imgUrl = msg.images[0].image_url.url;
                            const base64Data = imgUrl.replace(/^data:image\/\w+;base64,/, '');
                            resolve(base64Data);
                        } else {
                            reject(new Error('OpenRouter: no image in response'));
                        }
                    } else {
                        reject(new Error('OpenRouter: unknown response'));
                    }
                } catch(e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('OpenRouter 超时')); });
        req.write(body);
        req.end();
    });
}

// ========== DeepSeek 文案生成 ==========
function callDeepSeek(community, layout, price, payment, location, style) {
    const styleMap = {
        '1': { name: '简洁专业型', desc: '客观描述房源信息，突出核心卖点，适合专业中介推广' },
        '2': { name: '煽情种草型', desc: '有感染力，突出稀缺性和紧迫感，适合发朋友圈引发关注' },
        '3': { name: '接地气型', desc: '像跟朋友聊天一样，亲切自然，像朋友推荐的口吻' },
        '4': { name: '学区房专用型', desc: '强调教育资源和孩子的未来，精准击中家长心理' },
        '5': { name: '投资型', desc: '突出回报率、涨幅预期、稀缺性，适合投资客' },
        '6': { name: '豪宅 Luxury 型', desc: '高端大气，突出身份地位和品质生活，奢华感' },
        '7': { name: '刚需上车型', desc: '强调安家梦想、首付压力小、上车门槛低' },
        '8': { name: '地铁沿线型', desc: '突出交通便利、通勤时间短、出行方便' }
    };
    const s = styleMap[style] || styleMap['1'];
    const locStr = location ? `，位于${location}` : '';
    
    return new Promise((resolve, reject) => {
        const prompt = `你是一个房产文案专家。请根据以下信息生成一段房产推广文案。

小区：${community}
户型：${layout}
价格：${price}
付款方式：${payment}${locStr}
风格：${s.name}
要求：${s.desc}
50字以内，结尾带emoji，直接输出正文不加标题。`;

        const body = JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 150
        });

        const options = {
            hostname: 'api.deepseek.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + DEEPSEEK_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        console.log('Calling DeepSeek, style:', s.name);
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) reject(new Error('DeepSeek: ' + json.error.message));
                    else if (json.choices && json.choices[0].message) resolve(json.choices[0].message.content.trim());
                    else reject(new Error('DeepSeek: unknown response'));
                } catch(e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('DeepSeek 超时')); });
        req.write(body);
        req.end();
    });
}

// Store uploaded images temporarily
let uploadedImages = [];
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const PORT = process.env.PORT || 3000;

const mimeTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json'
};

function parseMultipart(buffer, boundary) {
    const parts = [];
    const boundaryBuffer = Buffer.from('--' + boundary);
    let start = 0;
    while (start < buffer.length) {
        const idx = buffer.indexOf(boundaryBuffer, start);
        if (idx === -1) break;
        const partStart = idx + boundaryBuffer.length;
        const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
        if (nextBoundary === -1) break;
        const partData = buffer.slice(partStart, nextBoundary - 2);
        start = nextBoundary;
        const headerEnd = partData.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = partData.slice(0, headerEnd).toString();
        const body = partData.slice(headerEnd + 4);
        const contentDisposition = headers.match(/Content-Disposition: form-data; name="(.+?)"/);
        const filenameMatch = headers.match(/filename="(.+?)"/);
        if (contentDisposition) {
            const fieldName = contentDisposition[1];
            if (filenameMatch) {
                parts.push({ fieldName, filename: filenameMatch[1], data: body });
            } else {
                parts.push({ fieldName, value: body.toString() });
            }
        }
    }
    return parts;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    console.log('REQUEST:', req.method, req.url);

    if (req.method === 'GET' && !url.pathname.startsWith('/api')) {
        let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
        filePath = path.join(__dirname, filePath);
        if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
        const ext = path.extname(filePath);
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); return; }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(body);
            const contentType = req.headers['content-type'] || '';
            const boundary = contentType.split('boundary=')[1];
            if (!boundary) { res.writeHead(400); res.end(JSON.stringify({ error: 'No boundary' })); return; }
            const parts = parseMultipart(buffer, boundary);
            const newImages = [];
            for (const part of parts) {
                if (part.filename && part.data.length > 0) {
                    const ext = path.extname(part.filename).toLowerCase();
                    const id = Date.now() + Math.random();
                    const filename = id + ext;
                    fs.writeFileSync(path.join(UPLOADS_DIR, filename), part.data);
                    const imageData = { id, filename, original: `/uploads/${filename}`, name: part.filename, timestamp: Date.now(), fromMobile: true };
                    newImages.push(imageData);
                    uploadedImages.push(imageData);
                    console.log('Saved image:', filename);
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, images: newImages }));
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/images') {
        const since = parseInt(url.searchParams.get('since') || '0');
        const newImages = uploadedImages.filter(img => img.timestamp > since);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ images: newImages, serverTime: Date.now() }));
        return;
    }

    if (url.pathname.startsWith('/uploads/')) {
        const filepath = path.join(__dirname, url.pathname.slice(1));
        if (!filepath.startsWith(UPLOADS_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
        fs.readFile(filepath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); return; }
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(data);
        });
        return;
    }

    // API: Server info
    if (req.method === 'GET' && url.pathname === '/serverInfo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'standalone' }));
        return;
    }

    // ========== AI 修图 API ==========
    if (req.method === 'POST' && url.pathname === '/api/ai-enhance') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            const contentType = req.headers['content-type'] || '';
            
            let imagePath, maskPath, prompt;
            
            if (contentType.includes('multipart/form-data')) {
                // 处理 multipart 格式（发送了 mask）
                const boundary = contentType.split('boundary=')[1];
                const buffer = Buffer.concat(body);
                const parts = parseMultipart(buffer, boundary);
                
                for (const part of parts) {
                    if (part.fieldName === 'image') imagePath = part.filename;
                    if (part.fieldName === 'mask') maskPath = part.filename;
                    if (part.fieldName === 'prompt') prompt = part.value;
                }
            } else {
                // 处理 JSON 格式
                try { 
                    const data = JSON.parse(Buffer.concat(body).toString()); 
                    imagePath = data.image;
                    prompt = data.prompt;
                    maskPath = data.mask || null; // 修复：读取 mask 字段
                } catch (e) { 
                    res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); 
                    return; 
                }
            }

            if (!imagePath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少图片' })); return; }
            console.log('AI enhance request, prompt:', prompt);

            let responseSent = false;
            const sendResponse = (statusCode, responseBody) => {
                if (responseSent) return;
                responseSent = true;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responseBody));
            };

            try {
                // 处理图片数据 - 可能是 data URL 或文件路径
                let imageBuffer;
                let imgWidth, imgHeight;
                
                if (imagePath.startsWith('data:')) {
                    // data URL - 直接转换
                    const base64Data = imagePath.replace(/^data:image\/\w+;base64,/, '');
                    const imgBuffer = Buffer.from(base64Data, 'base64');
                    const jimpImg = await Jimp.read(imgBuffer);
                    imgWidth = jimpImg.width;
                    imgHeight = jimpImg.height;
                    // 缩小到 1024
                    // 保持比例 resize 到 1024 以内
                    const ratio = Math.min(1024 / jimpImg.width, 1024 / jimpImg.height);
                    const newW = Math.round(jimpImg.width * ratio);
                    const newH = Math.round(jimpImg.height * ratio);
                    jimpImg.resize({ w: newW, h: newH });
                    imgWidth = newW;
                    imgHeight = newH;
                    imageBuffer = await jimpImg.getBuffer('image/png');
                } else {
                    // 文件路径 - 读取并转换
                    const imgFilepath = path.join(UPLOADS_DIR, path.basename(imagePath));
                    const jimpImg = await Jimp.read(imgFilepath);
                    const ratio = Math.min(1024 / jimpImg.width, 1024 / jimpImg.height);
                    const newW = Math.round(jimpImg.width * ratio);
                    const newH = Math.round(jimpImg.height * ratio);
                    jimpImg.resize({ w: newW, h: newH });
                    imgWidth = newW;
                    imgHeight = newH;
                    imageBuffer = await jimpImg.getBuffer('image/png');
                }
                
                // DEBUG: 保存发送的图片
                const debugDir = path.join(__dirname, 'debug');
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
                const ts = Date.now();
                fs.writeFileSync(path.join(debugDir, `debug_img_${ts}.png`), imageBuffer);
                console.log('DEBUG: saved image', imgWidth, 'x', imgHeight);
                
                // 处理遮罩 - 与图片尺寸一致，并转换颜色
                // 方案：不用遮罩，直接用提示词引导编辑
                // DALL-E 会根据 prompt 在原图基础上生成
                let maskBuffer = null;
                if (maskPath && maskPath.startsWith('data:')) {
                    const base64Data = maskPath.replace(/^data:image\/\w+;base64,/, '');
                    const maskImgBuffer = Buffer.from(base64Data, 'base64');
                    const maskImg = await Jimp.read(maskImgBuffer);
                    console.log('DEBUG: mask original size:', maskImg.width, 'x', maskImg.height);
                    // 缩放到与图片一致
                    maskImg.resize({ w: imgWidth, h: imgHeight });
                    
                    // 检查是否有红色遮罩（用户是否画了遮罩）
                    let hasRedMask = false;
                    maskImg.scan(0, 0, maskImg.width, maskImg.height, function (x, y, idx) {
                        const r = this.bitmap.data[idx + 0];
                        const g = this.bitmap.data[idx + 1];
                        const b = this.bitmap.data[idx + 2];
                        if (r > 150 && g < 100 && b < 100) {
                            hasRedMask = true;
                        }
                    });
                    
                    if (hasRedMask) {
                        // 逆向思维：红色 = 要保留的区域 → 白色
                        // 非红色 = 要消除的区域 → 黑色
                        maskImg.scan(0, 0, maskImg.width, maskImg.height, function (x, y, idx) {
                            const r = this.bitmap.data[idx + 0];
                            const g = this.bitmap.data[idx + 1];
                            const b = this.bitmap.data[idx + 2];
                            if (r > 150 && g < 100 && b < 100) {
                                // 红色 → 白色（保留）
                                this.bitmap.data[idx + 0] = 255;
                                this.bitmap.data[idx + 1] = 255;
                                this.bitmap.data[idx + 2] = 255;
                            } else {
                                // 非红色 → 黑色（消除/重新生成）
                                this.bitmap.data[idx + 0] = 0;
                                this.bitmap.data[idx + 1] = 0;
                                this.bitmap.data[idx + 2] = 0;
                            }
                        });
                        maskBuffer = await maskImg.getBuffer('image/png');
                        fs.writeFileSync(path.join(debugDir, `debug_mask_${ts}.png`), maskBuffer);
                        console.log('DEBUG: saved mask (inverted - red=keep)');
                    } else {
                        console.log('DEBUG: no red mask drawn');
                    }
                }
                
                // 调用 OpenRouter 图像编辑
                // 提示词：告诉AI要做什么编辑
                const editPrompt = prompt + ' (Keep the original image structure and content unchanged, only modify what is specified)';
                const base64Result = await callOpenRouterEdit(imageBuffer, editPrompt);
                
                sendResponse(200, { result: 'data:image/png;base64,' + base64Result });
            } catch (e) {
                console.error('AI error:', e);
                sendResponse(200, { error: e.message });
            }
        });
        return;
    }

    // ========== DeepSeek ==========
    if (req.method === 'POST' && url.pathname === '/api/generate-text') {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', async () => {
            try {
                const data = JSON.parse(Buffer.concat(body).toString());
                const { community, layout, price, payment, location, style } = data;
                if (!community || !layout || !price || !payment) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'missing params' }));
                    return;
                }
                const text = await callDeepSeek(community, layout, price, payment, location || '', style || '1');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, text }));
            } catch (e) {
                console.error('DeepSeek error:', e);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}/`);
});
