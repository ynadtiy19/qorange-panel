'use strict';

const MAX_RESOURCES = 200;
const RESOURCE_TIMEOUT_MS = 15000;
const SAFE_LABELS = [
    'com.qorange.panel',
    'com.qorange.service',
    'com.docker.compose.project',
    'com.docker.compose.service',
    'org.opencontainers.image.title',
    'org.opencontainers.image.version'
];

function resourceError(code, message, statusCode = 409) {
    const error = new Error(message);
    error.publicCode = code;
    error.statusCode = statusCode;
    return error;
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function parseSize(value) {
    const size = Number(value);
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function parseLabel(value) {
    const label = parseJson(value, '');
    return typeof label === 'string' ? label : '';
}

function isDockerId(value) {
    return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value);
}

function safeResourceName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
        !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-');
}

function labelArgs() {
    return SAFE_LABELS.map(key => `{{json (index .Config.Labels "${key}")}}`);
}

function containerTemplate() {
    return [
        '{{.Id}}', '{{.Name}}', '{{.State.Status}}', '{{.Config.Image}}', '{{.Image}}',
        '{{.State.Running}}', '{{.SizeRw}}', '{{.SizeRootFs}}',
        '{{json .NetworkSettings.Ports}}', '{{json .Mounts}}', ...labelArgs()
    ].join('\\t');
}

function imageTemplate() {
    return [
        '{{.Id}}', '{{json .RepoTags}}', '{{json .RepoDigests}}', '{{.Size}}',
        ...SAFE_LABELS.map(key => `{{json (index .Config.Labels "${key}")}}`)
    ].join('\\t');
}

function volumeTemplate() {
    return [
        '{{.Name}}', '{{.Driver}}', '{{.Scope}}', '{{.Mountpoint}}',
        ...SAFE_LABELS.map(key => `{{json (index .Labels "${key}")}}`),
        '{{if .UsageData}}{{.UsageData.Size}}{{else}}-1{{end}}',
        '{{if .UsageData}}{{.UsageData.RefCount}}{{else}}-1{{end}}'
    ].join('\\t');
}

async function readKind(runDocker, listArgs, inspectArgs, parseLine) {
    try {
        const listed = await runDocker(listArgs);
        const allIds = [...new Set(listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
        const truncated = allIds.length > MAX_RESOURCES;
        const ids = allIds.slice(0, MAX_RESOURCES);
        if (ids.some(id => !safeResourceName(id))) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned an invalid resource identifier.', 502);
        if (!ids.length) return { available: true, truncated: false, totalCount: 0, items: [] };
        const inspected = await runDocker([...inspectArgs(ids)]);
        const lines = inspected.stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length !== ids.length) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned an incomplete resource inventory.', 502);
        return { available: true, truncated, totalCount: allIds.length, items: lines.map(parseLine) };
    } catch (error) {
        return {
            available: false,
            truncated: false,
            totalCount: null,
            items: [],
            error: String(error.stderr || error.message || 'Docker query failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
        };
    }
}

function parseContainer(line) {
    const [
        id, rawName, state, image, imageId, running, writable, rootFs, rawPorts, rawMounts,
        panelLabel, serviceLabel, composeProject, composeService, imageTitle, imageVersion
    ] = line.split('\t');
    if (!isDockerId(id) || !isDockerId(imageId)) {
        throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned an invalid container identity.', 502);
    }
    const mounts = parseJson(rawMounts, []);
    const labels = {};
    for (const [key, value] of Object.entries({
        'com.qorange.panel': panelLabel,
        'com.qorange.service': serviceLabel,
        'com.docker.compose.project': composeProject,
        'com.docker.compose.service': composeService,
        'org.opencontainers.image.title': imageTitle,
        'org.opencontainers.image.version': imageVersion
    })) {
        const label = parseLabel(value);
        if (label) labels[key] = label;
    }
    const name = String(rawName || '').replace(/^\//, '');
    return {
        id,
        shortId: id.slice(0, 12),
        name,
        state: state || 'unknown',
        running: running === 'true',
        image: image || '',
        imageId,
        ports: parseJson(rawPorts, {}),
        mounts: Array.isArray(mounts) ? mounts.map(mount => ({
            type: mount.Type || 'unknown',
            name: mount.Name || null,
            source: mount.Source || null,
            destination: mount.Destination || null,
            readWrite: typeof mount.RW === 'boolean' ? mount.RW : null
        })) : [],
        labels,
        ownership: labels['com.qorange.panel'] === 'true' ? 'qorange' : 'external',
        size: { writableBytes: parseSize(writable), rootFilesystemBytes: parseSize(rootFs) }
    };
}

function parseImage(line) {
    const [id, rawTags, rawDigests, rawSize, ...labelValues] = line.split('\t');
    if (!isDockerId(id)) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned an invalid image identity.', 502);
    const tags = parseJson(rawTags, []);
    const digests = parseJson(rawDigests, []);
    const labels = {};
    SAFE_LABELS.forEach((key, index) => {
        const value = parseLabel(labelValues[index]);
        if (value) labels[key] = value;
    });
    return {
        id,
        shortId: id.replace(/^sha256:/, '').slice(0, 12),
        tags: (Array.isArray(tags) ? tags : []).filter(tag => tag && tag !== '<none>:<none>'),
        digests: (Array.isArray(digests) ? digests : []).filter(Boolean),
        sizeBytes: parseSize(rawSize),
        labels,
        ownership: labels['com.qorange.panel'] === 'true' ? 'qorange' : 'external',
        referencedBy: []
    };
}

function parseVolume(line) {
    const fields = line.split('\t');
    const [name, driver, scope, mountpoint, ...tail] = fields;
    const sizeBytes = parseSize(tail[SAFE_LABELS.length]);
    const refCount = parseSize(tail[SAFE_LABELS.length + 1]);
    const labels = {};
    SAFE_LABELS.forEach((key, index) => {
        const value = parseLabel(tail[index]);
        if (value) labels[key] = value;
    });
    if (!safeResourceName(name)) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned an invalid volume identity.', 502);
    return {
        name,
        driver: driver || 'unknown',
        scope: scope || 'unknown',
        mountpoint: mountpoint || null,
        sizeBytes,
        refCount,
        labels,
        ownership: labels['com.qorange.panel'] === 'true' ? 'qorange' : 'external',
        usedBy: []
    };
}

async function collectDockerResources(runDocker) {
    const [containers, images, volumes] = await Promise.all([
        readKind(runDocker,
            ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'],
            ids => ['container', 'inspect', '--size', '--format', containerTemplate(), ...ids],
            parseContainer),
        readKind(runDocker,
            ['image', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}'],
            ids => ['image', 'inspect', '--format', imageTemplate(), ...ids],
            parseImage),
        readKind(runDocker,
            ['volume', 'ls', '--format', '{{.Name}}'],
            ids => ['volume', 'inspect', '--format', volumeTemplate(), ...ids],
            parseVolume)
    ]);

    if (containers.available && images.available) {
        const imagesById = new Map(images.items.map(image => [image.id, image]));
        const imagesByTag = new Map(images.items.flatMap(image => image.tags.map(tag => [tag, image])));
        for (const container of containers.items) {
            const image = imagesById.get(container.imageId) || imagesByTag.get(container.image);
            if (image) image.referencedBy.push({ id: container.id, name: container.name, state: container.state });
        }
    }
    if (containers.available && volumes.available) {
        const volumesByName = new Map(volumes.items.map(volume => [volume.name, volume]));
        for (const container of containers.items) {
            for (const mount of container.mounts) {
                if (mount.type !== 'volume' || !mount.name) continue;
                const volume = volumesByName.get(mount.name);
                if (volume) volume.usedBy.push({
                    id: container.id,
                    name: container.name,
                    state: container.state,
                    source: mount.source,
                    destination: mount.destination,
                    readWrite: mount.readWrite
                });
            }
        }
    }
    const failures = [containers, images, volumes].filter(result => !result.available);
    return {
        status: failures.length ? 'unavailable' : 'available',
        error: failures.length ? 'One or more Docker resource queries failed; unavailable sections are not shown as empty.' : null,
        containers,
        images,
        volumes
    };
}

async function inspectContainer(runDocker, id) {
    if (!isDockerId(id)) throw resourceError('INVALID_RESOURCE_ID', 'A full container ID is required.', 400);
    const result = await runDocker(['container', 'inspect', '--size', '--format', containerTemplate(), id]);
    const line = result.stdout.split(/\r?\n/).filter(Boolean)[0];
    if (!line) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned no container identity.', 502);
    return parseContainer(line);
}

async function inspectImage(runDocker, id) {
    if (!isDockerId(id)) throw resourceError('INVALID_RESOURCE_ID', 'A full image ID is required.', 400);
    const result = await runDocker(['image', 'inspect', '--format', imageTemplate(), id]);
    const line = result.stdout.split(/\r?\n/).filter(Boolean)[0];
    if (!line) throw resourceError('DOCKER_INVALID_RESPONSE', 'Docker returned no image identity.', 502);
    return parseImage(line);
}

function assertSameContainer(original, latest) {
    if (original.id !== latest.id || original.ownership !== latest.ownership ||
        original.labels['com.qorange.service'] !== latest.labels['com.qorange.service']) {
        throw resourceError('RESOURCE_CHANGED', 'Container identity or ownership changed; no further action was taken.');
    }
}

async function actOnContainer(runDocker, id, action, confirmation) {
    if (!['stop', 'remove'].includes(action)) throw resourceError('INVALID_ACTION', 'Unsupported container action.', 400);
    if (confirmation !== id) throw resourceError('CONFIRMATION_REQUIRED', 'Type the full container ID to confirm this action.', 400);
    const inventory = await collectDockerResources(runDocker);
    if (!inventory.containers.available) throw resourceError('DOCKER_UNAVAILABLE', inventory.containers.error, 503);
    const original = inventory.containers.items.find(container => container.id === id);
    if (!original) throw resourceError('RESOURCE_NOT_FOUND', 'Container was not found in the latest inventory.', 404);
    const latest = await inspectContainer(runDocker, id);
    assertSameContainer(original, latest);
    if (action === 'stop') {
        if (latest.running) await runDocker(['container', 'stop', id], { timeout: RESOURCE_TIMEOUT_MS });
        return { action, containerId: id, stopped: latest.running };
    }
    if (latest.running) await runDocker(['container', 'stop', id], { timeout: RESOURCE_TIMEOUT_MS });
    const beforeRemove = await inspectContainer(runDocker, id);
    assertSameContainer(original, beforeRemove);
    await runDocker(['container', 'rm', id], { timeout: RESOURCE_TIMEOUT_MS });
    return { action, containerId: id, stopped: latest.running, volumesPreserved: true };
}

async function actOnImage(runDocker, id, action, confirmation) {
    if (action !== 'remove') throw resourceError('INVALID_ACTION', 'Unsupported image action.', 400);
    if (confirmation !== id) throw resourceError('CONFIRMATION_REQUIRED', 'Type the full image ID to confirm this action.', 400);
    const inventory = await collectDockerResources(runDocker);
    if (!inventory.images.available || !inventory.containers.available) {
        throw resourceError('DOCKER_UNAVAILABLE', 'Image and container inventory must be available before removing an image.', 503);
    }
    const original = inventory.images.items.find(image => image.id === id);
    if (!original) throw resourceError('RESOURCE_NOT_FOUND', 'Image was not found in the latest inventory.', 404);
    if (original.referencedBy.length) {
        throw resourceError('IMAGE_IN_USE', 'Image removal refused: one or more containers reference this image, including stopped containers.');
    }
    const latest = await inspectImage(runDocker, id);
    if (latest.id !== original.id || JSON.stringify(latest.tags) !== JSON.stringify(original.tags)) {
        throw resourceError('RESOURCE_CHANGED', 'Image identity or tags changed; no action was taken.');
    }
    const latestInventory = await collectDockerResources(runDocker);
    if (!latestInventory.containers.available) throw resourceError('DOCKER_UNAVAILABLE', 'Container inventory is unavailable; image references cannot be checked.', 503);
    if (latestInventory.containers.items.some(container => container.imageId === id)) {
        throw resourceError('IMAGE_IN_USE', 'Image removal refused: a container now references this image.');
    }
    await runDocker(['image', 'rm', id], { timeout: RESOURCE_TIMEOUT_MS });
    return { action, imageId: id, removedTags: latest.tags };
}

module.exports = {
    collectDockerResources,
    actOnContainer,
    actOnImage,
    inspectContainer,
    inspectImage,
    resourceError,
    isDockerId,
    MAX_RESOURCES,
    RESOURCE_TIMEOUT_MS
};
