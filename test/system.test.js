'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectSystemMetrics, formatBytes, sampleCpuUsage } = require('../lib/system');

function fakeOs() {
    return {
        hostname: () => 'fixture-server',
        platform: () => 'linux',
        release: () => '6.8.0-fixture',
        arch: () => 'x64',
        uptime: () => 3601,
        totalmem: () => 1000,
        freemem: () => 250,
        loadavg: () => [0.25, 0.5, 0.75],
        networkInterfaces: () => ({
            lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
            eth0: [{ family: 'IPv4', address: '192.0.2.10', internal: false }],
            eth1: [{ family: 4, address: '192.0.2.10', internal: false }]
        })
    };
}

test('formats byte values with bounded precision and safe unknown values', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1024), '1.00 KB');
    assert.equal(formatBytes(1536), '1.50 KB');
    assert.equal(formatBytes(1024 ** 3), '1.00 GB');
    assert.equal(formatBytes(Number.NaN), '未知');
    assert.equal(formatBytes(-1), '未知');
});

test('collects a stable, non-sensitive system metrics shape from local OS APIs', () => {
    const metrics = collectSystemMetrics({
        osModule: {
            ...fakeOs(),
            cpus: () => [{ model: 'Fixture CPU', times: { user: 0, idle: 0 } }]
        },
        cpus: [{ model: 'Fixture CPU', times: { user: 0, idle: 0 } }],
        fsModule: { statfsSync: () => ({ blocks: 1000, bsize: 4096, bfree: 250 }) }
    });

    assert.deepEqual(Object.keys(metrics), [
        'hostname', 'platform', 'osRelease', 'architecture', 'uptimeSeconds',
        'ipv4Addresses', 'cpu', 'memory', 'disk'
    ]);
    assert.equal(metrics.hostname, 'fixture-server');
    assert.equal(metrics.osRelease, '6.8.0-fixture');
    assert.deepEqual(metrics.ipv4Addresses, ['192.0.2.10']);
    assert.deepEqual(metrics.cpu, {
        model: 'Fixture CPU',
        cores: 1,
        loadAverage: [0.25, 0.5, 0.75],
        usagePercent: null
    });
    assert.deepEqual(metrics.memory, {
        usedBytes: 750,
        totalBytes: 1000,
        percent: 75,
        used: '750 B',
        total: '1000 B'
    });
    assert.equal(metrics.disk.available, true);
    assert.equal(metrics.disk.usedBytes, 3_072_000);
    assert.equal(metrics.disk.totalBytes, 4_096_000);
    assert.equal(metrics.disk.percent, 75);
});

test('reports disk probe failures explicitly without fabricating measurements', () => {
    const metrics = collectSystemMetrics({
        osModule: {
            ...fakeOs(),
            cpus: () => [{ model: 'Fixture CPU', times: { user: 0, idle: 0 } }]
        },
        cpus: [{ model: 'Fixture CPU', times: { user: 0, idle: 0 } }],
        fsModule: { statfsSync: () => { throw new Error('fixture failure'); } }
    });
    assert.deepEqual(metrics.disk, {
        available: false,
        usedBytes: null,
        totalBytes: null,
        percent: null,
        used: '未知',
        total: '未知',
        error: '无法读取根目录磁盘信息'
    });
});

test('samples CPU utilization only when two valid cumulative samples exist', () => {
    const previous = [{ times: { user: 50, nice: 0, sys: 20, idle: 30, irq: 0 } }];
    const first = sampleCpuUsage(previous, null);
    assert.equal(first.percent, null);
    assert.deepEqual(first.snapshot, { user: 50, nice: 0, sys: 20, idle: 30, irq: 0 });

    const next = sampleCpuUsage([{ times: { user: 80, nice: 0, sys: 30, idle: 40, irq: 0 } }], first.snapshot);
    assert.equal(next.percent, 80);
});
