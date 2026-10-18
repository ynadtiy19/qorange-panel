'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    collectDockerResources,
    actOnContainer,
    actOnImage
} = require('../lib/docker-resources');

const containerId = 'a'.repeat(64);
const imageId = 'b'.repeat(64);
const volumeName = 'mongo_data';
function containerLine(options = {}) {
    const {
        id = containerId,
        name = '/qorange-app',
        state = 'running',
        running = 'true',
        panel = 'true',
        service = 'app',
        mounts = [{ Type: 'volume', Name: volumeName, Source: '/var/lib/docker/volumes/mongo_data/_data', Destination: '/data/mongo_data', RW: true }]
    } = options;
    return [
        id, name, state, 'qorange-app:latest', imageId, running, '12', '1024',
        JSON.stringify({ '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }),
        JSON.stringify(mounts), ...[panel, service, 'project', 'api', '', ''].map(value => JSON.stringify(value))
    ].join('\t');
}

function imageLine(options = {}) {
    const { id = imageId, tags = ['qorange-app:latest'], size = '4096' } = options;
    return [
        id, JSON.stringify(tags), JSON.stringify(['example/app@sha256:' + 'c'.repeat(64)]), size,
        ...['true', 'app', '', '', '', ''].map(value => JSON.stringify(value))
    ].join('\t');
}

function volumeLine(options = {}) {
    const { name = volumeName, size = '2048', refs = '1' } = options;
    return [
        name, 'local', 'local', '/var/lib/docker/volumes/mongo_data/_data',
        ...['true', 'mongo', '', '', '', ''].map(value => JSON.stringify(value)), size, refs
    ].join('\t');
}

function inventoryRunner(options = {}) {
    return async args => {
        const command = args.slice(0, 2).join(' ');
        if (command === 'container ls') {
            if (options.containerListError) throw Object.assign(new Error('Docker daemon unavailable'), { stderr: 'daemon unavailable' });
            return { stdout: options.containerIds === false ? '' : `${containerId}\n` };
        }
        if (command === 'image ls') return { stdout: `${imageId}\n` };
        if (command === 'volume ls') return { stdout: `${volumeName}\n` };
        if (command === 'container inspect') {
            assert.ok(!args.join(' ').includes('.Config.Env'));
            assert.ok(!args.join(' ').includes('.Config}}'));
            return { stdout: `${containerLine(options.container || {})}\n` };
        }
        if (command === 'image inspect') return { stdout: `${imageLine(options.image || {})}\n` };
        if (command === 'volume inspect') return { stdout: `${volumeLine(options.volume || {})}\n` };
        return { stdout: '' };
    };
}

test('inventory maps container-image-volume relationships and reports only Docker-provided sizes', async () => {
    const inventory = await collectDockerResources(inventoryRunner({ volume: { size: '-1', refs: '-1' } }));
    assert.equal(inventory.status, 'available');
    assert.equal(inventory.containers.items[0].ownership, 'qorange');
    assert.equal(inventory.containers.items[0].imageId, imageId);
    assert.equal(inventory.containers.items[0].mounts[0].name, volumeName);
    assert.equal(inventory.images.items[0].referencedBy[0].id, containerId);
    assert.equal(inventory.volumes.items[0].usedBy[0].destination, '/data/mongo_data');
    assert.equal(inventory.containers.items[0].size.writableBytes, 12);
    assert.equal(inventory.images.items[0].sizeBytes, 4096);
    assert.equal(inventory.volumes.items[0].sizeBytes, null);
    assert.equal(inventory.volumes.items[0].refCount, null);
});

test('inventory identifies external resources and reports Docker query failures as unavailable', async () => {
    const external = await collectDockerResources(inventoryRunner({ container: { panel: '' } }));
    assert.equal(external.containers.items[0].ownership, 'external');
    const unavailable = await collectDockerResources(inventoryRunner({ containerListError: true }));
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.containers.available, false);
    assert.match(unavailable.containers.error, /daemon unavailable/);
    assert.equal(unavailable.containers.items.length, 0);
});

test('inventory does not request or return container environment variables', async () => {
    const inventory = await collectDockerResources(inventoryRunner());
    assert.equal(JSON.stringify(inventory).includes('Config.Env'), false);
    assert.equal(JSON.stringify(inventory).includes('SECRET_VALUE'), false);
});

test('container deletion stops first, revalidates ownership, and never removes mounted volumes', async () => {
    const calls = [];
    let inspectCount = 0;
    const runner = async args => {
        calls.push(args);
        const command = args.slice(0, 2).join(' ');
        if (command === 'container ls') return { stdout: `${containerId}\n` };
        if (command === 'image ls') return { stdout: `${imageId}\n` };
        if (command === 'volume ls') return { stdout: `${volumeName}\n` };
        if (command === 'container inspect') {
            inspectCount += 1;
            return { stdout: `${containerLine({ panel: inspectCount === 3 ? 'false' : 'true' })}\n` };
        }
        if (command === 'image inspect') return { stdout: `${imageLine()}\n` };
        if (command === 'volume inspect') return { stdout: `${volumeLine()}\n` };
        return { stdout: '' };
    };
    await assert.rejects(actOnContainer(runner, containerId, 'remove', containerId), error => error.publicCode === 'RESOURCE_CHANGED');
    assert.ok(calls.some(args => args[0] === 'container' && args[1] === 'stop'));
    assert.equal(calls.some(args => args[0] === 'container' && args[1] === 'rm'), false);
    assert.equal(calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
    assert.equal(calls.some(args => args[0] === 'container' && args[1] === 'rm' && args.includes('-v')), false);
});

test('container action requires an exact target confirmation before querying Docker', async () => {
    let calls = 0;
    await assert.rejects(actOnContainer(async () => { calls += 1; }, containerId, 'stop', 'wrong'),
        error => error.publicCode === 'CONFIRMATION_REQUIRED');
    assert.equal(calls, 0);
});

test('image removal refuses referenced images and deletes unreferenced image by stable ID', async () => {
    const referencedCalls = [];
    await assert.rejects(actOnImage(async args => {
        referencedCalls.push(args);
        return inventoryRunner()(args);
    }, imageId, 'remove', imageId), error => error.publicCode === 'IMAGE_IN_USE');
    assert.equal(referencedCalls.some(args => args[0] === 'image' && args[1] === 'rm'), false);

    const calls = [];
    const runner = async args => {
        calls.push(args);
        if (args[0] === 'container' && args[1] === 'ls') return { stdout: '' };
        if (args[0] === 'image' && args[1] === 'ls') return { stdout: `${imageId}\n` };
        if (args[0] === 'volume' && args[1] === 'ls') return { stdout: '' };
        if (args[0] === 'image' && args[1] === 'inspect') return { stdout: `${imageLine({ tags: ['one:latest', 'two:stable'] })}\n` };
        return { stdout: '' };
    };
    const result = await actOnImage(runner, imageId, 'remove', imageId);
    assert.deepEqual(result.removedTags, ['one:latest', 'two:stable']);
    assert.ok(calls.some(args => args[0] === 'image' && args[1] === 'rm' && args[2] === imageId));
    assert.equal(calls.some(args => args[0] === 'image' && args[1] === 'rm' && args.includes('--force')), false);
});
