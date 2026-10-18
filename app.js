const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

if (!fs.existsSync(CONFIG_PATH)) {
    if (fs.existsSync(EXAMPLE_PATH)) {
        fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
    } else {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ authSecret: "qorange2026", services: [] }, null, 2));
    }
}

function getConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
            if (err) return reject(stderr || err.message);
            resolve(stdout);
        });
    });
}

// 1. 获取 GitHub 用户状态与名下所有仓库 (私密+公开)
app.get('/api/github/info', async (req, res) => {
    try {
        const userStr = await runCommand("gh api user --jq '{login: .login, avatar_url: .avatar_url, name: .name}'");
        const reposStr = await runCommand("gh repo list --limit 100 --json name,nameWithOwner,url,isPrivate,defaultBranchRef");
        res.json({
            user: JSON.parse(userStr.trim()),
            repos: JSON.parse(reposStr.trim())
        });
    } catch (e) {
        res.status(500).json({ error: "未检测到 GitHub 登录态，请在服务器运行 gh auth login" });
    }
});

// 2. 动态添加新服务
app.post('/api/services/add', async (req, res) => {
    const { id, name, repo, branch, port, env } = req.body;
    if (!id || !repo) return res.status(400).json({ error: "缺少必要字段" });

    const cfg = getConfig();
    if (cfg.services.some(s => s.id === id)) {
        return res.status(400).json({ error: "该服务标识已存在" });
    }

    const newService = {
        id: id.trim(),
        name: name.trim() || id.trim(),
        type: "app",
        repo: repo.trim(),
        branch: branch.trim() || "main",
        port: port ? port.toString().trim() : "",
        env: env ? env.trim() : ""
    };

    cfg.services.push(newService);
    saveConfig(cfg);

    res.json({ success: true, service: newService });
});

// 3. 删除服务
app.post('/api/services/delete', async (req, res) => {
    const { serviceId } = req.body;
    const cfg = getConfig();
    cfg.services = cfg.services.filter(s => s.id !== serviceId);
    saveConfig(cfg);

    try {
        await runCommand(`docker stop ${serviceId} || true`);
        await runCommand(`docker rm ${serviceId} || true`);
    } catch (e) {}

    res.json({ success: true });
});

// 4. 系统状态
app.get('/api/system', async (req, res) => {
    try {
        const memOut = await runCommand("free -m | awk 'NR==2{printf \"%s/%sMB (%.1f%%)\", $3,$2,$3*100/$2 }'");
        const diskOut = await runCommand("df -h / | awk 'NR==2{printf \"%s/%s (%s)\", $3,$2,$5}'");
        const cpuOut = await runCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2 + $4\"%\"}'");
        const containers = await runCommand("docker ps -a --format '{{.Names}}|{{.Status}}'");
        
        const containerMap = {};
        containers.trim().split('\n').forEach(line => {
            if (line) {
                const [name, stat] = line.split('|');
                containerMap[name] = stat;
            }
        });

        const cfg = getConfig();
        const services = (cfg.services || []).map(s => ({
            ...s,
            status: containerMap[s.id] ? (containerMap[s.id].includes('Up') ? 'running' : 'stopped') : 'uninstalled',
            statusRaw: containerMap[s.id] || '未部署'
        }));

        res.json({ cpu: cpuOut.trim(), memory: memOut.trim(), disk: diskOut.trim(), services });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

// 5. 核心构建流程 (拉取 -> 构建 -> 重启 -> 清理旧镜像)
async function buildAndDeploy(service) {
    const dir = `/data/apps/${service.id}`;
    let logs = `[${new Date().toLocaleTimeString()}] 开始构建部署: ${service.name}\n`;
    
    if (!fs.existsSync(dir)) {
        logs += `正在克隆私有仓库 ${service.repo} ...\n`;
        logs += await runCommand(`git clone -b ${service.branch || 'main'} ${service.repo} ${dir}`);
    } else {
        logs += `正在拉取最新代码...\n`;
        logs += await runCommand(`cd ${dir} && git fetch --all && git reset --hard origin/${service.branch || 'main'}`);
    }

    logs += `正在本地构建镜像 (Docker Build) ...\n`;
    logs += await runCommand(`cd ${dir} && docker build -t ${service.id}:latest .`);

    logs += `正在切换并启动新实例...\n`;
    await runCommand(`docker stop ${service.id} || true`);
    await runCommand(`docker rm ${service.id} || true`);

    const envFlags = (service.env || "").split(' ').filter(Boolean).map(e => `-e "${e}"`).join(' ');
    const portMap = service.port ? `-p ${service.port}:${service.port}` : '';
    await runCommand(`docker run -d --name ${service.id} --restart always ${portMap} ${envFlags} ${service.id}:latest`);

    logs += `正在清理废弃构建缓存 (保卫磁盘) ...\n`;
    await runCommand(`docker image prune -f`);
    logs += `🎉 部署成功且缓存已清理完毕！\n`;
    return logs;
}

// 6. Webhook
app.post('/api/webhook/:serviceId', async (req, res) => {
    const { serviceId } = req.params;
    const token = req.query.token;
    const cfg = getConfig();

    if (token !== cfg.authSecret) return res.status(403).send('Forbidden');
    const service = (cfg.services || []).find(s => s.id === serviceId);
    if (!service) return res.status(404).send('Not Found');

    res.send({ status: 'Triggered' });
    try {
        await buildAndDeploy(service);
    } catch (e) {
        console.error('Build Error:', e);
    }
});

// 7. 操作接口
app.post('/api/action', async (req, res) => {
    const { action, serviceId } = req.body;
    const cfg = getConfig();
    const service = (cfg.services || []).find(s => s.id === serviceId);

    try {
        if (action === 'start') {
            if (service && service.type === 'database') await runCommand(service.runCmd);
            else await runCommand(`docker start ${serviceId}`);
            return res.json({ success: true });
        }
        if (action === 'stop') {
            await runCommand(`docker stop ${serviceId}`);
            return res.json({ success: true });
        }
        if (action === 'restart') {
            await runCommand(`docker restart ${serviceId}`);
            return res.json({ success: true });
        }
        if (action === 'build') {
            const logs = await buildAndDeploy(service);
            return res.json({ success: true, logs });
        }
        if (action === 'logs') {
            const logs = await runCommand(`docker logs --tail 100 ${serviceId}`);
            return res.json({ logs });
        }
        if (action === 'cleanDisk') {
            const cleanOut = await runCommand(`docker system prune -af`);
            return res.json({ logs: cleanOut });
        }
        if (action === 'selfUpdate') {
            const updateLogs = await runCommand('git fetch --all && git reset --hard origin/main && npm install');
            exec("nohup sh -c 'sleep 1 && systemctl restart qorange-panel' > /dev/null 2>&1 &");
            return res.json({ success: true, logs: updateLogs + '\n✓ 控制台正在平滑重启，2秒后刷新页面生效！' });
        }
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    }
});

const PORT = process.env.PORT || 8888;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`QOrange Panel is running on port ${PORT}`);
});
