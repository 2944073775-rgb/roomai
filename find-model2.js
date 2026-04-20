const https = require('https');
const fs = require('fs');
const apiKey = 'sk-mwzdhaxchaaacmouykpemqitpejpsxvcnyfxlbfmtnywboyw';

function api(path, method, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const opts = {
            hostname: 'api.siliconflow.cn',
            path,
            method,
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const req = https.request(opts, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
                catch { resolve({ status: res.statusCode, body: d.substring(0, 300) }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function test() {
    // Try Qwen with different approaches
    console.log('=== Qwen/Qwen-Image-Edit via chat ===');
    const imgBuffer = fs.readFileSync('C:/Users/wlc58/.openclaw/workspace/roomai/uploads/1776362271708.7014.jpeg');
    const imgB64 = imgBuffer.toString('base64');

    // Approach 1: vision-style message
    const r1 = await api('/v1/chat/completions', 'POST', {
        model: 'Qwen/Qwen-Image-Edit',
        messages: [
            { role: 'user', content: [
                { type: 'text', text: 'Remove the trash from this image' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imgB64 } }
            ] }
        ]
    });
    console.log('Vision approach:', r1.status, r1.body.error || (r1.body.choices && r1.body.choices[0].message.content ? 'OK' : JSON.stringify(r1.body).substring(0, 200)));

    // Approach 2: just prompt
    const r2 = await api('/v1/chat/completions', 'POST', {
        model: 'Qwen/Qwen-Image-Edit',
        messages: [{ role: 'user', content: 'Edit this image to remove the trash: https://example.com/image.jpg' }]
    });
    console.log('Text-only approach:', r2.status, r2.body.error ? r2.body.error.message || JSON.stringify(r2.body.error).substring(0, 100) : JSON.stringify(r2.body).substring(0, 200));

    // Approach 3: check if there are other image models
    const models = await api('/v1/models', 'GET');
    if (models.body && models.body.data) {
        console.log('\n=== All available models ===');
        models.body.data.forEach(m => {
            console.log(m.id);
        });
    }
}

test().catch(console.error);
