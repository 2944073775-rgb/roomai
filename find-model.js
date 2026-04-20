const https = require('https');
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
                try { resolve(JSON.parse(d)); }
                catch { resolve(d.substring(0, 500)); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function test() {
    const r = await api('/v1/models', 'GET');
    if (r.data) {
        console.log('All models with image/edit/inpaint keywords:');
        r.data.forEach(m => {
            const id = m.id.toLowerCase();
            if (id.includes('image') || id.includes('edit') || id.includes('inpaint') || id.includes('flux') || id.includes('sd-') || id.includes('stable') || id.includes('dalle') || id.includes('sdxl') || id.includes('playground') || id.includes('removebg') || id.includes('segmind') || id.includes('replicate') || id.includes('paint')) {
                console.log(' -', m.id);
            }
        });
    } else {
        console.log('Response:', JSON.stringify(r).substring(0, 500));
    }
}
test().catch(console.error);
