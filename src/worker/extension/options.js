"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var recorder;
var stream;
async function START_RECORDING(opts) {
    console.log("[PUPPETEER_STREAM] START_RECORDING", JSON.stringify({
        video: opts.video,
        audio: opts.audio,
        frameSize: opts.frameSize,
        audioBitsPerSecond: opts.audioBitsPerSecond,
        videoBitsPerSecond: opts.videoBitsPerSecond,
        bitsPerSecond: opts.bitsPerSecond,
        mimeType: opts.mimeType,
        videoConstraints: opts.videoConstraints,
        audioConstraints: opts.audioConstraints,
        tabId: opts.tabId,
    }));
    const client = new WebSocket(`ws://localhost:${window.location.hash.substring(1)}`, []);
    await new Promise((resolve) => {
        if (client.readyState === WebSocket.OPEN)
            resolve();
        client.addEventListener("open", () => resolve());
    });
    stream = await new Promise((resolve, reject) => {
        chrome.tabCapture.capture({
            audio: opts.audio,
            video: opts.video,
            audioConstraints: opts.audioConstraints,
            videoConstraints: opts.videoConstraints,
        }, (stream) => {
            var _a, _b;
            if (chrome.runtime.lastError || !stream) {
                console.error((_a = chrome.runtime.lastError) === null || _a === void 0 ? void 0 : _a.message);
                reject((_b = chrome.runtime.lastError) === null || _b === void 0 ? void 0 : _b.message);
            }
            else {
                resolve(stream);
            }
        });
    });
    // somtimes needed to sync audio and video
    if (opts.delay)
        await new Promise((resolve) => setTimeout(resolve, opts.delay));
    recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: opts.audioBitsPerSecond,
        videoBitsPerSecond: opts.videoBitsPerSecond,
        bitsPerSecond: opts.bitsPerSecond,
        mimeType: opts.mimeType,
    });
    recorder.ondataavailable = async (e) => {
        if (!e.data.size)
            return;
        const buffer = await e.data.arrayBuffer();
        client.send(buffer);
    };
    // TODO: recorder onerror
    recorder.onerror = () => recorder.stop();
    recorder.onstop = function () {
        try {
            const tracks = stream.getTracks();
            tracks.forEach(function (track) {
                track.stop();
            });
            if (client.readyState === WebSocket.OPEN)
                client.close();
        }
        catch (error) { }
    };
    stream.onremovetrack = () => {
        try {
            recorder.stop();
        }
        catch (error) { }
    };
    recorder.start(opts.frameSize);
}
function MUTE() {
    if (stream) {
        stream.getAudioTracks()[0].enabled = false;
    }
}
function UN_MUTE() {
    if (stream) {
        stream.getAudioTracks()[0].enabled = true;
    }
}
function STOP_RECORDING() {
    console.log("[PUPPETEER_STREAM] STOP_RECORDING");
    if (!recorder)
        return;
    if (recorder.state === "inactive")
        return;
    recorder.stop();
}
//# sourceMappingURL=options.js.map