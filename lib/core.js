'use strict';

const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMPOSE_FILE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

function validateServiceId(id) {
    if (typeof id !== 'string' || !SERVICE_ID.test(id)) {
        throw new Error('服务 ID 必须以小写字母或数字开头，且只能包含小写字母、数字、连字符或下划线');
    }
    return id;
}

function validateBranch(branch) {
    if (typeof branch !== 'string' || branch.length < 1 || branch.length > 255 ||
        branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') ||
        branch.endsWith('.') || branch.includes('..') || branch.includes('//') ||
        branch.includes('@{') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) ||
        !/^[A-Za-z0-9._/-]+$/.test(branch)) {
        throw new Error('分支名称无效');
    }
    return branch;
}

function parseEnv(text) {
    if (typeof text !== 'string') throw new Error('环境变量必须是文本');
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('环境变量必须小于 64 KB');
    const result = {};
    for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const separator = rawLine.indexOf('=');
        if (separator < 1) throw new Error(`第 ${index + 1} 行的环境变量无效；请使用 KEY=VALUE 格式`);
        const key = rawLine.slice(0, separator).trim();
        if (!ENV_KEY.test(key)) throw new Error(`第 ${index + 1} 行的环境变量名称无效`);
        if (Object.hasOwn(result, key)) throw new Error(`第 ${index + 1} 行的环境变量名称重复`);
        Object.defineProperty(result, key, {
            value: rawLine.slice(separator + 1),
            enumerable: true,
            configurable: true,
            writable: true
        });
    }
    return result;
}

function validateService(input) {
    const id = validateServiceId(input.id);
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!REPOSITORY.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
        throw new Error('请从已登录的 GitHub 账户中选择一个仓库');
    }
    const branch = validateBranch((typeof input.branch === 'string' && input.branch.trim()) || 'main');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error('服务名称长度必须为 1–120 个可打印字符');
    }
    let port = '';
    if (input.port !== undefined && input.port !== null && input.port !== '') {
        if (typeof input.port !== 'string' && typeof input.port !== 'number') throw new Error('端口必须为数字或主机端口:容器端口映射');
        port = String(input.port).trim();
        const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(port);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 ||
            (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
            throw new Error('端口必须在 1 到 65535 之间，也可以使用主机端口:容器端口映射');
        }
        port = match[2] ? `${Number(match[1])}:${Number(match[2])}` : `${Number(match[1])}:${Number(match[1])}`;
    }
    return { id, name, repo, branch, port };
}

function containerName(id) {
    return `qorange-${validateServiceId(id)}`;
}

function resolveServiceStatus(containerStatus, deploymentStatus, operationInProgress) {
    if (deploymentStatus === 'deploying' && operationInProgress) return 'deploying';
    if (containerStatus) return containerStatus.startsWith('Up') ? 'running' : 'stopped';
    if (deploymentStatus === 'failed') return 'failed';
    if (deploymentStatus === 'succeeded') return 'missing';
    return 'uninstalled';
}

function redactSecrets(text, secrets) {
    let output = String(text);
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
        output = output.split(secret).join('[REDACTED]');
    }
    return output;
}

function normalizePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/').trim();
}

function asFileMap(files) {
    const map = new Map();
    if (!files) return map;
    if (Array.isArray(files)) {
        for (const file of files) {
            if (!file || typeof file !== 'string') continue;
            const normalized = normalizePath(file);
            if (!normalized) continue;
            map.set(normalized.toLowerCase(), normalized);
        }
        return map;
    }
    if (typeof files === 'object') {
        for (const [key, value] of Object.entries(files)) {
            if (typeof key !== 'string') continue;
            const normalized = normalizePath(key);
            if (!normalized) continue;
            map.set(normalized.toLowerCase(), normalized);
            if (typeof value === 'string' && value.trim()) {
                map.set(`${normalized.toLowerCase()}:content`, value);
            }
        }
    }
    return map;
}

function getFileContentFromTree(files, fileName) {
    if (!files || typeof files !== 'object' || Array.isArray(files)) return '';
    const candidates = [fileName, fileName.toLowerCase(), fileName.toUpperCase()];
    for (const [key, value] of Object.entries(files)) {
        const normalized = normalizePath(key);
        const lower = normalized.toLowerCase();
        if (candidates.includes(normalized) || candidates.includes(lower) || normalized.endsWith('/' + fileName) || lower.endsWith('/' + fileName.toLowerCase())) {
            return typeof value === 'string' ? value : '';
        }
    }
    return '';
}

function getComposeText(files) {
    for (const name of COMPOSE_FILE_NAMES) {
        const text = getFileContentFromTree(files, name);
        if (text) return text;
    }
    return '';
}

function parseDockerfileEnv(lines) {
    const env = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('ENV ')) continue;
        const rest = trimmed.slice(4).trim();
        const equalsIndex = rest.indexOf('=');
        if (equalsIndex >= 0) {
            const key = rest.slice(0, equalsIndex).trim();
            if (key && ENV_KEY.test(key)) env[key] = rest.slice(equalsIndex + 1).trim();
            continue;
        }
        const parts = rest.split(/\s+/);
        if (parts.length >= 2 && ENV_KEY.test(parts[0])) {
            env[parts[0]] = parts.slice(1).join(' ');
        }
    }
    return env;
}

function parseDockerfilePort(lines) {
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('EXPOSE ')) continue;
        const values = trimmed.slice(7).split(/\s+/).filter(Boolean);
        for (const value of values) {
            const match = /^(\d{1,5})(?:\/\w+)?$/.exec(value);
            if (match) return Number(match[1]);
        }
    }
    return null;
}

function parseDockerfileCommand(lines) {
    const cmdLines = lines.filter(line => /^CMD\s+/i.test(line.trim()) || /^ENTRYPOINT\s+/i.test(line.trim()));
    const command = cmdLines.map(line => line.trim().replace(/^CMD\s+/i, '').replace(/^ENTRYPOINT\s+/i, '').trim()).filter(Boolean);
    return command.length ? command.join(' ') : null;
}

function pickComposeService(compose) {
    const services = compose && typeof compose === 'object' && compose.services && typeof compose.services === 'object'
        ? compose.services
        : {};
    const names = Object.keys(services);
    if (!names.length) return null;
    const candidate = names.find(name => services[name] && typeof services[name] === 'object' && (services[name].build || services[name].image));
    return candidate ? { name: candidate, service: services[candidate] } : { name: names[0], service: services[names[0]] };
}

function parseComposeSectionValue(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map(item => String(item));
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return value;
    return undefined;
}

function safeComposePreview(composeDocument) {
    const services = composeDocument && composeDocument.services && typeof composeDocument.services === 'object' ? composeDocument.services : {};
    const warnings = [];
    const unsupported = [];
    for (const name of Object.keys(services)) {
        const service = services[name];
        if (!service || typeof service !== 'object') continue;
        const blocked = [
            'privileged', 'devices', 'volumes', 'volumes_from', 'network_mode', 'pid', 'ipc', 'cap_add',
            'security_opt', 'pids_limit', 'cgroupns', 'userns_mode', 'sysctls'
        ].filter(key => Object.hasOwn(service, key));
        if (blocked.length) {
            unsupported.push(`${name}: ${blocked.join(', ')}`);
        }
        if (service.network_mode === 'host' || service.pid === 'host' || service.ipc === 'host') {
            warnings.push(`${name} uses host networking, which is unsafe to preview automatically.`);
        }
        if (service.volumes || service.devices) {
            warnings.push(`${name} mounts host paths or devices; QOrange only supports explicit, reviewed Compose previews without automatic host mutation.`);
        }
    }
    return { safe: unsupported.length === 0, warnings, unsupported };
}

function readComposeFile(fileText) {
    if (typeof fileText !== 'string' || !fileText.trim()) return {};
    try {
        const parsed = JSON.parse(fileText);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch {
        // fallback to minimal YAML parser
    }
    const result = {};
    const lines = fileText.split(/\r?\n/);
    let currentSection = null;
    let currentService = null;
    let currentListKey = null;
    for (const rawLine of lines) {
        const line = rawLine.replace(/\t/g, '    ');
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.match(/^\s*/)[0].length;
        if (indent === 0 && line.trim().endsWith(':') && !line.trim().startsWith('-')) {
            currentSection = line.trim().slice(0, -1);
            currentService = null;
            currentListKey = null;
            if (!Object.hasOwn(result, currentSection)) result[currentSection] = {};
            continue;
        }
        if (indent === 2 && line.trim().endsWith(':') && currentSection === 'services') {
            const name = line.trim().slice(0, -1).trim();
            currentService = { name };
            if (!result.services) result.services = {};
            result.services[name] = currentService;
            currentListKey = null;
            continue;
        }
        if (currentSection === 'services' && currentService && indent >= 4 && /^[A-Za-z0-9_.-]+\s*:/.test(line.trim())) {
            const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
            if (!match) continue;
            currentListKey = match[1];
            const value = match[2].trim();
            if (!value) {
                currentService[currentListKey] = {};
            } else {
                currentService[currentListKey] = parseComposeSectionValue(value);
            }
            continue;
        }
        if (currentService && currentListKey && indent >= 6 && line.trim().startsWith('-')) {
            const item = line.trim().slice(1).trim();
            if (!Array.isArray(currentService[currentListKey])) currentService[currentListKey] = [];
            currentService[currentListKey].push(item.replace(/^['"]|['"]$/g, ''));
            continue;
        }
    }
    return result;
}

function detectComposeRecipe(fileText) {
    const compose = readComposeFile(fileText);
    const chosen = pickComposeService(compose);
    if (!chosen) {
        return {
            source: 'compose',
            supported: false,
            reason: 'Compose services block is empty or unsupported.'
        };
    }
    const preview = safeComposePreview(compose);
    if (!preview.safe) {
        return {
            source: 'compose',
            supported: false,
            reason: `Compose preview rejected because it contains unsupported or unsafe features: ${preview.unsupported.join('; ')}`,
            warnings: preview.warnings,
            composeFile: 'docker-compose.yml'
        };
    }
    const service = chosen.service;
    const ports = [];
    const portValues = Array.isArray(service.ports) ? service.ports : (service.ports ? [service.ports] : []);
    for (const value of portValues) {
        if (typeof value === 'string') {
            const match = /^(?:\d{1,5}:)?(\d{1,5})(?:\/\w+)?$/.exec(value.trim());
            if (match) ports.push(Number(match[1]));
        }
    }
    const port = ports[0] || null;
    const env = {};
    if (Array.isArray(service.environment)) {
        for (const item of service.environment) {
            if (typeof item === 'string') {
                const separator = item.indexOf('=');
                if (separator >= 0) env[item.slice(0, separator)] = item.slice(separator + 1);
            }
        }
    } else if (service.environment && typeof service.environment === 'object') {
        Object.assign(env, service.environment);
    }
    const buildCommand = service.build ? `docker build -t ${chosen.name}:preview ${String(service.build).replace(/['"]/g, '')}` : null;
    const runCommand = service.image ? `docker run --rm -p ${port || 8080}:${port || 8080} ${service.image}` : null;
    return {
        source: 'compose',
        supported: true,
        buildCommand,
        runCommand,
        port,
        env,
        serviceName: chosen.name,
        warnings: preview.warnings,
        preview: {
            image: service.image || null,
            build: service.build || null,
            command: service.command || null,
            ports: portValues,
            environment: env
        }
    };
}

function detectDockerfileRecipe(fileText) {
    const lines = String(fileText || '').split(/\r?\n/);
    const port = parseDockerfilePort(lines);
    const env = parseDockerfileEnv(lines);
    const command = parseDockerfileCommand(lines);
    return {
        source: 'dockerfile',
        supported: true,
        buildCommand: 'docker build -t app:preview .',
        runCommand: port ? `docker run --rm -p ${port}:${port} app:preview` : 'docker run --rm app:preview',
        port,
        env,
        preview: {
            expose: port,
            env,
            command
        }
    };
}

function detectManifestRecipe(files) {
    const map = asFileMap(files);
    const packagePath = map.get('package.json') || Array.from(map.keys()).find(name => name.endsWith('/package.json'));
    const requirementsPath = map.get('requirements.txt') || Array.from(map.keys()).find(name => name.endsWith('/requirements.txt'));
    const pyprojectPath = map.get('pyproject.toml') || Array.from(map.keys()).find(name => name.endsWith('/pyproject.toml'));
    const goModPath = map.get('go.mod') || Array.from(map.keys()).find(name => name.endsWith('/go.mod'));

    if (packagePath) {
        const content = map.get(`${packagePath}:content`);
        try {
            const json = content ? JSON.parse(content) : {};
            const startScript = json.scripts && typeof json.scripts.start === 'string' ? json.scripts.start : '';
            const port = (() => {
                const match = /PORT\s*[:=]\s*(\d{2,5})/i.exec(startScript || '');
                return match ? Number(match[1]) : 3000;
            })();
            return {
                source: 'node',
                supported: true,
                buildCommand: 'npm ci',
                runCommand: startScript || 'npm start',
                port,
                env: { PORT: String(port), NODE_ENV: 'production' },
                preview: { engine: 'node', startScript, packageName: json.name || null }
            };
        } catch {
            // ignore parse errors and fall through to next checks
        }
    }
    if (requirementsPath || pyprojectPath) {
        return {
            source: 'python',
            supported: true,
            buildCommand: requirementsPath ? 'python -m pip install -r requirements.txt' : 'python -m pip install .',
            runCommand: 'python -m gunicorn app:app --bind 0.0.0.0:8000',
            port: 8000,
            env: { PORT: '8000' },
            preview: { engine: 'python', requirements: Boolean(requirementsPath), pyproject: Boolean(pyprojectPath) }
        };
    }
    if (goModPath) {
        return {
            source: 'go',
            supported: true,
            buildCommand: 'go build -o app .',
            runCommand: './app',
            port: 8080,
            env: { PORT: '8080' },
            preview: { engine: 'go' }
        };
    }
    return {
        supported: false,
        reason: 'No supported Dockerfile, compose file, or common language manifest was found.'
    };
}

function detectRepositoryRecipe(files, options = {}) {
    const map = asFileMap(files);
    const seen = Array.from(map.keys()).filter(key => !key.endsWith(':content'));
    const hasDockerfile = seen.some(name => name === 'dockerfile' || name.endsWith('/dockerfile'));
    const composeFile = COMPOSE_FILE_NAMES.find(name => seen.includes(name) || seen.some(path => path.endsWith(`/${name}`)));
    const priority = [
        hasDockerfile ? 'dockerfile' : null,
        composeFile ? 'compose' : null,
        map.has('package.json') || seen.some(name => name.endsWith('/package.json')) ? 'node' : null,
        map.has('requirements.txt') || seen.some(name => name.endsWith('/requirements.txt')) || map.has('pyproject.toml') || seen.some(name => name.endsWith('/pyproject.toml')) ? 'python' : null,
        map.has('go.mod') || seen.some(name => name.endsWith('/go.mod')) ? 'go' : null
    ].filter(Boolean);

    const dockerText = getFileContentFromTree((files && typeof files === 'object' && !Array.isArray(files)) ? files : {}, 'Dockerfile') || getFileContentFromTree((files && typeof files === 'object' && !Array.isArray(files)) ? files : {}, 'dockerfile') || '';
    const composeText = getComposeText(files);
    const recipe = priority[0] === 'dockerfile' ? detectDockerfileRecipe(dockerText) : (priority[0] === 'compose' ? detectComposeRecipe(composeText) : detectManifestRecipe(files));
    const resolved = recipe || {
        supported: false,
        reason: 'No supported build recipe found for the selected branch.',
        warnings: options.warnings || []
    };
    return {
        ...resolved,
        supported: Boolean(resolved && resolved.supported),
        requiresConfirmation: true,
        sourcePriority: priority,
        branch: options.branch || null,
        repo: options.repo || null,
        port: resolved && resolved.port !== undefined && resolved.port !== null ? resolved.port : null,
        envDefaults: resolved && resolved.env ? { ...resolved.env } : {},
        message: resolved && !resolved.supported ? resolved.reason : 'Detected build recipe requires review before deployment.'
    };
}

function allocatePublicPort(preferredPort, usedPorts = []) {
    const preferred = Number(preferredPort);
    const used = new Set((Array.isArray(usedPorts) ? usedPorts : []).filter(value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535).map(value => Number(value)));
    const candidates = [];
    if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535) candidates.push(preferred);
    for (let port = Math.max(1024, preferred + 1); port <= 65535; port += 1) {
        if (!candidates.includes(port)) candidates.push(port);
    }
    for (let port = 1; port < 1024; port += 1) {
        if (!candidates.includes(port)) candidates.push(port);
    }
    for (const port of candidates) {
        if (!used.has(port)) return port;
    }
    throw new Error('No available public port was found in the allowed range.');
}

function detectPublicAddress() {
    const interfaces = typeof require === 'function' && require('os').networkInterfaces ? require('os').networkInterfaces() : {};
    const preferred = ['en0', 'eth0', 'ens3', 'ens4', 'wlan0', 'wlp2s0'];
    for (const name of preferred) {
        const addresses = interfaces[name] || [];
        for (const entry of addresses) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
    }
    return '127.0.0.1';
}

function buildMongoUri(options = {}) {
    const host = options.host || 'mongodb';
    const port = Number(options.port || 27017);
    const dbName = options.dbName || 'app';
    const username = options.username || '';
    const password = options.password || '';
    const authSegment = username && password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const normalizedDb = String(dbName).trim() || 'app';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('MongoDB port must be a valid TCP port.');
    }
    return `mongodb://${authSegment}${host}:${port}/${encodeURIComponent(normalizedDb)}`;
}

function normalizeMongoEnv(env = {}) {
    const result = { ...env };
    if (!result.MONGODB_URI && !result.DATABASE_URL) {
        result.MONGODB_URI = buildMongoUri({
            host: result.MONGO_HOST || 'mongodb',
            port: result.MONGO_PORT || 27017,
            dbName: result.MONGO_DB || result.DB_NAME || 'app',
            username: result.MONGO_USER || '',
            password: result.MONGO_PASSWORD || ''
        });
    }
    return result;
}

function containsDangerousShellInterpolation(text) {
    return /\$\(|`|;\s*(rm|mkfs|curl|wget|bash|sh)|\|\s*sh/.test(String(text || ''));
}

function previewDeploymentPlan(recipe) {
    if (!recipe || typeof recipe !== 'object') {
        throw new Error('A deployment recipe preview needs a valid recipe object.');
    }
    if (!recipe.supported) {
        return {
            supported: false,
            review: 'The selected repository does not expose a supported or safe deployment recipe.',
            warnings: recipe.warnings || []
        };
    }
    if (containsDangerousShellInterpolation(recipe.runCommand || '') || containsDangerousShellInterpolation(recipe.buildCommand || '')) {
        return {
            supported: false,
            review: 'The inferred build/run command contains shell interpolation or unsafe command chaining; preview is blocked.',
            warnings: ['Unsafe shell interpolation detected in recipe commands.']
        };
    }
    const port = recipe.port || 3000;
    return {
        supported: true,
        requiresConfirmation: true,
        review: 'Build and run commands are preview-only and must be approved before any Docker action is taken.',
        commands: {
            build: recipe.buildCommand || null,
            run: recipe.runCommand || null
        },
        port,
        publicAddress: `http://${detectPublicAddress()}:${allocatePublicPort(port, [])}`,
        envDefaults: recipe.envDefaults || recipe.env || {},
        warnings: recipe.warnings || []
    };
}

module.exports = {
    parseEnv,
    validateService,
    validateServiceId,
    validateBranch,
    containerName,
    resolveServiceStatus,
    redactSecrets,
    detectRepositoryRecipe,
    detectComposeRecipe,
    detectDockerfileRecipe,
    detectManifestRecipe,
    allocatePublicPort,
    detectPublicAddress,
    buildMongoUri,
    normalizeMongoEnv,
    previewDeploymentPlan,
    containsDangerousShellInterpolation
};
