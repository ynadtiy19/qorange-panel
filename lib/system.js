'use strict';

const fs = require('node:fs');
const os = require('node:os');

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function sampleCpuUsage(cpus, previousSnapshot) {
    const current = cpus.reduce((totals, cpu) => {
        for (const [state, milliseconds] of Object.entries(cpu.times)) {
            totals[state] = (totals[state] || 0) + milliseconds;
        }
        return totals;
    }, {});
    if (!previousSnapshot) return { snapshot: current, percent: null };
    const elapsed = Object.keys(current).reduce((total, state) =>
        total + Math.max(0, current[state] - (previousSnapshot[state] || 0)), 0);
    const idle = Math.max(0, (current.idle || 0) - (previousSnapshot.idle || 0));
    return {
        snapshot: current,
        percent: elapsed > 0 ? Math.min(100, Math.max(0, Math.round((1 - idle / elapsed) * 100))) : null
    };
}

function ipv4Addresses(networkInterfaces) {
    return Object.values(networkInterfaces).flatMap(addresses => addresses || [])
        .filter(address => (address.family === 'IPv4' || address.family === 4) && !address.internal)
        .map(address => address.address)
        .filter((address, index, all) => address && all.indexOf(address) === index);
}

function collectSystemMetrics(options = {}) {
    const osModule = options.osModule || os;
    const fsModule = options.fsModule || fs;
    const cpus = options.cpus || osModule.cpus();
    const firstCpu = cpus[0];
    const memoryTotal = osModule.totalmem();
    const memoryFree = osModule.freemem();
    const memoryUsed = Math.max(0, memoryTotal - memoryFree);
    const memoryPercent = memoryTotal > 0 ? Math.round(memoryUsed / memoryTotal * 100) : null;
    let disk;
    try {
        const stats = fsModule.statfsSync('/');
        const totalBytes = stats.blocks * stats.bsize;
        const usedBytes = Math.max(0, (stats.blocks - stats.bfree) * stats.bsize);
        disk = {
            available: totalBytes > 0,
            usedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : null,
            used: formatBytes(usedBytes),
            total: formatBytes(totalBytes)
        };
        if (!disk.available) disk.error = '根目录磁盘容量暂不可用';
    } catch {
        disk = {
            available: false,
            usedBytes: null,
            totalBytes: null,
            percent: null,
            used: '未知',
            total: '未知',
            error: '无法读取根目录磁盘信息'
        };
    }

    return {
        hostname: osModule.hostname(),
        platform: osModule.platform(),
        osRelease: osModule.release(),
        architecture: osModule.arch(),
        uptimeSeconds: osModule.uptime(),
        ipv4Addresses: ipv4Addresses(osModule.networkInterfaces()),
        cpu: {
            model: firstCpu && firstCpu.model ? firstCpu.model.trim() : '未知',
            cores: cpus.length,
            loadAverage: osModule.loadavg().map(value => Number(value.toFixed(2))),
            usagePercent: null
        },
        memory: {
            usedBytes: memoryUsed,
            totalBytes: memoryTotal,
            percent: memoryPercent,
            used: formatBytes(memoryUsed),
            total: formatBytes(memoryTotal)
        },
        disk
    };
}

module.exports = { collectSystemMetrics, formatBytes, sampleCpuUsage };
