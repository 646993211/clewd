/**
 * SET YOUR COOKIE HERE
 */
const Cookie = '';



/**
 * Experimental
 * OPTION: (DEFAULT)
 * 
 * AntiStall: (false|2|1) - 2 returns the second reply by the assistant (the first is usually an apology), 1 sends whatever was last when exceeding size
 * StripPrompt: (false) - might combo well with RecycleChats, avoids sending the whole prompt history to each claude message
 * StripAssistant: (false) - might be good if your prompt/jailbreak itself ends with Assistant: 
 * RecycleChats: (false) - false is less likely to get caught in a censorship loop
 * ClearFlags: (false) - possibly snake-oil
 */
const Settings = {
    'AntiStall': false,
    'ClearFlags': true,
    'RecycleChats': false,
    'StripAssistant': false,
    'StripPrompt': false
};

const Ip = '127.0.0.1';
const Port = 8444;






/**
 * Don't touch StallTriggerMax.
 * If you know what you're doing, change the 2 MB on StallTrigger to what you want
 */
const StallTriggerMax = 5242880;
const StallTrigger = 2097152;






const {'createServer': Server} = require('node:http');
const {'createHash': Hash} = require('node:crypto');
const {'v4': genUUID} = require('uuid');
const Decoder = new TextDecoder;
const Encoder = new TextEncoder;

const UUIDMap = {
    'SHA1': 'uuid'
};

const cookies = {};

let uuidTemp;

let uuidOrg;

const getCookies = () => Object.keys(cookies).map((name => `${name}=${cookies[name]};`)).join(' ').replace(/(\s+)$/gi, '');

const bytesToSize = (bytes = 0) => {
    const b = [ 'Bytes', 'KB', 'MB', 'GB', 'TB' ];
    if (0 === bytes) {
        return '0 B';
    }
    const c = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return 0 === c ? `${bytes} ${b[c]}` : `${(bytes / 1024 ** c).toFixed(1)} ${b[c]}`;
};

const updateCookies = (cookieInfo, initial = false) => {
    let cookieNew = initial ? cookieInfo : cookieInfo.headers?.get('set-cookie');
    if (!cookieNew) {
        return;
    }
    let cookieArr = cookieNew.split(/;\s?/gi).filter((prop => false === /^(path|expires|domain|HttpOnly|Secure|SameSite)[=;]*/i.test(prop)));
    for (const cookie of cookieArr) {
        const divide = cookie.split(/^(.*?)=\s*(.*)/);
        const cookieName = divide[1];
        const cookieVal = divide[2];
        cookies[cookieName] = cookieVal;
    }
};

const setTitle = title => {
    process.title = 'clewd v1.0 - ' + title;
};

Server(((req, res) => {
    if ('/v1/complete' !== req.url) {
        console.error(`Error: ${req.url} is unsupported`);
        return res.end();
    }
    setTitle('recv prompt...');
    const buffer = [];
    req.on('data', (chunk => {
        buffer.push(chunk);
    }));
    req.on('end', (async () => {
        try {
            const body = JSON.parse(Buffer.concat(buffer).toString());
            let {'prompt': prompt} = body;
            /**
             * https://docs.anthropic.com/claude/reference/selecting-a-model
             */
			const model = /claude-v?2.*/.test(body.model) ? 'claude-2' : 'claude-instant-1';
            /**
             * Ideally SillyTavern would expose a unique frontend conversation_uuid prop to localhost proxies
             * could set the name to a hash of it
             * then fetch /chat_conversations with 'GET' and find it
             */
			const firstAssistantIdx = prompt.indexOf('\n\nAssistant: ');
            const lastAssistantIdx = prompt.lastIndexOf('\n\nAssistant: ');
            const lastHumanIdx = prompt.lastIndexOf('\n\nHuman: ');
            const hash = Hash('sha1');
            hash.update(prompt.substring(0, firstAssistantIdx));
            const sha = Settings.RecycleChats ? hash.digest('hex') : '';
            const uuidOld = UUIDMap[sha];
            Settings.RecycleChats && Settings.StripPrompt && uuidOld && lastHumanIdx > -1 && (prompt = prompt.substring(lastHumanIdx, prompt.length));
            Settings.StripAssistant && lastAssistantIdx > -1 && (prompt = prompt.substring(0, lastAssistantIdx));
            if (Settings.RecycleChats && uuidOld) {
                uuidTemp = uuidOld;
                console.log(model + ' r');
            } else {
                uuidTemp = genUUID().toString();
                const claude = await fetch(`https://claude.ai/api/organizations/${uuidOrg}/chat_conversations`, {
                    'headers': {
                        'Cookie': getCookies(),
                        'Content-Type': 'application/json'
                    },
                    'method': 'POST',
                    'body': JSON.stringify({
                        'uuid': uuidTemp,
                        'name': sha
                    })
                });
                updateCookies(claude);
                console.log('' + model);
                UUIDMap[sha] = uuidTemp;
            }
            const claude = await fetch('https://claude.ai/api/append_message', {
                'headers': {
                    'Cookie': getCookies(),
                    'Content-Type': 'application/json'
                },
                'method': 'POST',
                'body': JSON.stringify({
                    'completion': {
                        'prompt': prompt,
                        'timezone': 'America/New_York',
                        'model': model
                    },
                    'organization_uuid': uuidOrg,
                    'conversation_uuid': uuidTemp,
                    'text': prompt,
                    'attachments': []
                })
            });
            updateCookies(claude);
            let recvLength = 0;
            let lastChunk;
            for await (const chunk of claude.body) {
                recvLength += chunk?.length || 0;
                lastChunk = chunk;
                const decodedChunk = Decoder.decode(chunk);
                setTitle('recv ' + bytesToSize(recvLength));
                if (Settings.AntiStall && recvLength >= StallTrigger) {
                    try {
                        const triggerExceeded = recvLength >= Math.min(StallTriggerMax, 2 * StallTrigger);
                        if (Settings.AntiStall < 2 || triggerExceeded) {
                            console.log(`[31mstall: ${triggerExceeded ? 'max' : '1'}[0m`);
                            break;
                        }
                        const chunkFixed = decodedChunk.replace(/^data: {/gi, '{').replace(/\s+$/, '');
                        const chunkParsed = JSON.parse(chunkFixed);
                        chunkParsed.completion = chunkParsed.completion.replace(/\n{2}A:[ ]{1}/gi, '\n\nAssistant: ').replace(/\n{2}H:[ ]{1}/gi, '\n\nHuman: ');
                        const secondCompletionAssistantIdx = chunkParsed.completion.indexOf('\n\nAssistant: ', chunkParsed.completion.indexOf('\n\nAssistant: ') + 1);
                        if (secondCompletionAssistantIdx < 0) {
                            throw Error('Invalid completion');
                        }
                        chunkParsed.completion = chunkParsed.completion.substring(secondCompletionAssistantIdx, chunkParsed.completion.length);
                        const completionHumanIdx = chunkParsed.completion.indexOf('\n\nHuman: ');
                        if (completionHumanIdx < 0) {
                            throw Error('Invalid completion');
                        }
                        chunkParsed.completion = chunkParsed.completion.substring(13, completionHumanIdx);
                        chunkParsed.stop || (chunkParsed.stop = '\n\nHuman:');
                        lastChunk = Encoder.encode(`data: ${JSON.stringify(chunkParsed)}\n\n`);
                        console.log('[31mstall: 2[0m');
                        break;
                    } catch (err) {}
                }
            }
            setTitle('ok ' + bytesToSize(recvLength));
            console.log(`${200 == claude.status ? '[32m' : '[33m'}${claude.status}![0m ${Math.round((lastChunk?.length || 0) / recvLength * 100)}%\n`);
            res.end(lastChunk);
        } catch (err) {
            console.error('Claude error: ' + err.message);
            console.error(err.stack);
            res.writeHead(500, {
                'Content-Type': 'application/json'
            });
            res.end(JSON.stringify({
                'error': {
                    'message': err.message,
                    'type': err.code,
                    'param': null,
                    'code': 500
                }
            }));
        }
    }));
})).listen(Port, Ip, (async () => {
    console.log(`[33mhttp://${Ip}:${Port}/v1[0m\n\n${Object.keys(Settings).map(((setting, idx) => `${setting}: ${Settings[setting]}`)).sort().join('\n')}\n`);
    const accReq = await fetch('https://claude.ai/api/organizations', {
        'method': 'GET',
        'headers': {
            'Cookie': Cookie
        }
    });
    const accInfo = (await accReq.json())?.[0];
    if (accInfo?.error) {
        throw Error('Couldn\'t get account info: ' + accInfo.error.message);
    }
    if (!accInfo?.uuid) {
        throw Error('Invalid account id');
    }
    setTitle('ok');
    updateCookies(Cookie, true);
    updateCookies(accReq);
    console.log('Logged in %o', {
        'name': accInfo.name?.split('@')?.[0],
        'capabilities': accInfo.capabilities
    });
    uuidOrg = accInfo?.uuid;
    if (accInfo?.active_flags.length > 0) {
        const flagNames = accInfo.active_flags.map((flag => flag.type));
        console.warn('[31mYour account has warnings[0m %o', flagNames);
        Settings.ClearFlags && await Promise.all(flagNames.map((flag => (async flag => {
            if ('consumer_restricted_mode' === flag) {
                return;
            }
            const req = await fetch(`https://claude.ai/api/organizations/${uuidOrg}/flags/${flag}/dismiss`, {
                'headers': {
                    'Cookie': getCookies(),
                    'Content-Type': 'application/json'
                },
                'method': 'POST'
            });
            updateCookies(req);
            const json = await req.json();
            console.log(`${flag}: ${json.error ? json.error.message || json.error.type || json.detail : 'OK'}`);
        })(flag))));
    }
    if (Settings.RecycleChats) {
        const convReq = await fetch(`https://claude.ai/api/organizations/${uuidOrg}/chat_conversations`, {
            'method': 'GET',
            'headers': {
                'Cookie': getCookies()
            }
        });
        (await convReq.json()).filter((chat => chat.name.length > 0)).forEach((chat => UUIDMap[chat.name] = chat.uuid));
        updateCookies(convReq);
    }
}));