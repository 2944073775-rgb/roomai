// 生成一个指定尺寸的PNG mask (黑底白块)
// 使用纯Node.js实现,无需第三方库
const fs = require('fs');
const zlib = require('zlib');

function createPNG(width, height, drawCallback) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    
    // IHDR chunk
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData.writeUInt8(8, 8);  // bit depth
    ihdrData.writeUInt8(2, 9);  // color type (RGB)
    ihdrData.writeUInt8(0, 10); // compression
    ihdrData.writeUInt8(0, 11); // filter
    ihdrData.writeUInt8(0, 12); // interlace
    
    const ihdrChunk = makeChunk('IHDR', ihdrData);
    
    // IDAT chunk (image data)
    // Create raw pixel data with filter bytes
    const rowSize = width * 3 + 1; // RGB + filter byte per row
    const rawData = Buffer.alloc(height * rowSize);
    
    for (let y = 0; y < height; y++) {
        rawData[y * rowSize] = 0; // filter byte (none)
        for (let x = 0; x < width; x++) {
            const pixel = drawCallback(x, y);
            const offset = y * rowSize + 1 + x * 3;
            rawData[offset] = pixel.r;
            rawData[offset + 1] = pixel.g;
            rawData[offset + 2] = pixel.b;
        }
    }
    
    const compressed = zlib.deflateSync(rawData, { level: 9 });
    const idatChunk = makeChunk('IDAT', compressed);
    
    // IEND chunk
    const iendChunk = makeChunk('IEND', Buffer.alloc(0));
    
    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    
    const typeBuffer = Buffer.from(type);
    const crcData = Buffer.concat([typeBuffer, data]);
    const crc = crc32(crcData);
    
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc >>> 0, 0);
    
    return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = makeCRCTable();
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return crc ^ 0xFFFFFFFF;
}

function makeCRCTable() {
    const table = new Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }
    return table;
}

// 测试: 创建一个100x100的PNG, 黑底白块
const maskPng = createPNG(100, 100, (x, y) => {
    // 白块区域
    if (x >= 20 && x <= 80 && y >= 20 && y <= 80) {
        return { r: 255, g: 255, b: 255 }; // 白色
    }
    return { r: 0, g: 0, b: 0 }; // 黑色
});

const maskBase64 = maskPng.toString('base64');
console.log('PNG size:', maskPng.length, 'bytes');
console.log('Base64 length:', maskBase64.length);

// 保存测试
fs.writeFileSync('mask-test.png', maskPng);
console.log('Saved mask-test.png');

// 测试 Baidu API
const https = require('https');

function getToken() {
    return new Promise((resolve, reject) => {
        const pd = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: 'FqD3UC6RC6XuU4gyRPsDZRV5',
            client_secret: 'Cx1dxjBoYmRmRzHX6vjVrYfeiDijvFJg'
        }).toString();
        const opts = { hostname: 'aip.baidubce.com', path: '/oauth/2.0/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(pd) } };
        const req = https.request(opts, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d).access_token));
        });
        req.on('error', reject); req.write(pd); req.end();
    });
}

async function test() {
    const token = await getToken();
    const imgBuffer = fs.readFileSync('C:/Users/wlc58/.openclaw/workspace/roomai/uploads/1776362271708.7014.jpeg');
    const imgBase64 = imgBuffer.toString('base64');
    
    // 测试1: 发送完整图片 + 刚才创建的mask PNG base64
    const params = new URLSearchParams();
    params.append('image', imgBase64);
    params.append('mask', maskBase64);
    const pd = params.toString();
    
    const apiOpts = {
        hostname: 'aip.baidubce.com',
        path: '/rest/2.0/image-process/v1/inpainting?access_token=' + token,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(pd) }
    };
    
    const result = await new Promise((resolve) => {
        const req = https.request(apiOpts, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.substring(0, 500)));
        });
        req.on('error', e => resolve('error: ' + e.message));
        req.write(pd); req.end();
    });
    
    console.log('Result:', result);
}

test().catch(console.error);
