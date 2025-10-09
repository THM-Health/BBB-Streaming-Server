var recorder: MediaRecorder;
var stream: MediaStream;

export type BrowserMimeType =
	| "video/webm"
	| "video/webm;codecs=h264"
	| "video/webm;codecs=H264"
	| "video/webm;codecs=vp8"
	| "video/webm;codecs=vp9"
	| "video/webm;codecs=vp8.0"
	| "video/webm;codecs=vp9.0"
	| "video/webm;codecs=vp8,opus"
	| "video/webm;codecs=vp8,pcm"
	| "video/WEBM;codecs=VP8,OPUS"
	| "video/webm;codecs=vp9,opus"
	| "video/webm;codecs=vp8,vp9,opus"
	| "audio/webm"
	| "audio/webm;codecs=opus"
	| "audio/webm;codecs=pcm";

interface recordingOptions {
	audio: boolean;
	video: boolean;
	videoConstraints?: chrome.tabCapture.MediaStreamConstraint;
	audioConstraints?: chrome.tabCapture.MediaStreamConstraint;
	mimeType?: BrowserMimeType;
	audioBitsPerSecond?: number;
	videoBitsPerSecond?: number;
	bitsPerSecond?: number;
	frameSize?: number;
	delay?: number;
	tabId: number;
}

async function START_RECORDING(opts: recordingOptions) {
	console.log(
		"[PUPPETEER_STREAM] START_RECORDING",
		JSON.stringify({
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
		})
	);

	try {
		const client = new WebSocket(`ws://localhost:${window.location.hash.substring(1)}`, []);

		await new Promise<void>((resolve, reject) => {
			if (client.readyState === WebSocket.OPEN) resolve();
			client.addEventListener("open", () => {
				console.log("[PUPPETEER_STREAM] WebSocket connected");
				resolve();
			});
			client.addEventListener("error", (error) => {
				console.error("[PUPPETEER_STREAM] WebSocket connection error:", error);
				reject(new Error("WebSocket connection failed"));
			});
			// Add timeout
			setTimeout(() => reject(new Error("WebSocket connection timeout")), 10000);
		});

		console.log("[PUPPETEER_STREAM] Capturing tab with id:", opts.tabId);

		stream = await new Promise<MediaStream>((resolve, reject) => {
			chrome.tabCapture.capture(
				{
					audio: opts.audio,
					video: opts.video,
					audioConstraints: opts.audioConstraints,
					videoConstraints: opts.videoConstraints,
				},
				(stream) => {
					if (chrome.runtime.lastError || !stream) {
						console.error("[PUPPETEER_STREAM] Tab capture error:", chrome.runtime.lastError?.message);
						reject(chrome.runtime.lastError?.message);
					} else {
						console.log("[PUPPETEER_STREAM] Tab captured successfully");
						resolve(stream);
					}
				}
			);
		});

		/*var constraints = { frameRate: 30 };
		stream.getVideoTracks()[0].applyConstraints(constraints).catch((e: any) => console.log(e));
	*/

		// somtimes needed to sync audio and video
		if (opts.delay) {
			console.log(`[PUPPETEER_STREAM] Applying delay: ${opts.delay}ms`);
			await new Promise((resolve) => setTimeout(resolve, opts.delay));
		}

		console.log("[PUPPETEER_STREAM] Creating MediaRecorder with mimeType:", opts.mimeType);

		recorder = new MediaRecorder(stream, {
			audioBitsPerSecond: opts.audioBitsPerSecond,
			videoBitsPerSecond: opts.videoBitsPerSecond,
			bitsPerSecond: opts.bitsPerSecond,
			mimeType: opts.mimeType,
		});

		recorder.ondataavailable = async (e) => {
			if (!e.data.size) return;

			const buffer = await e.data.arrayBuffer();

			client.send(buffer);
		};

		recorder.onerror = (event: any) => {
			console.error("[PUPPETEER_STREAM] MediaRecorder error:", event);
			recorder.stop();
		};

		recorder.onstop = function () {
			console.log("[PUPPETEER_STREAM] MediaRecorder stopped");
			try {
				const tracks = stream.getTracks();

				tracks.forEach(function (track) {
					track.stop();
				});

				if (client.readyState === WebSocket.OPEN) client.close();
			} catch (error) {
				console.error("[PUPPETEER_STREAM] Error in recorder.onstop:", error);
			}
		};
		stream.onremovetrack = () => {
			console.log("[PUPPETEER_STREAM] Stream track removed");
			try {
				recorder.stop();
			} catch (error) {
				console.error("[PUPPETEER_STREAM] Error stopping recorder on track removal:", error);
			}
		};

		recorder.start(opts.frameSize);
		console.log("[PUPPETEER_STREAM] Recording started with frameSize:", opts.frameSize);
	} catch (error) {
		console.error("[PUPPETEER_STREAM] START_RECORDING failed:", error);
		throw error;
	}
}

function MUTE() {
	if(stream){
		stream.getAudioTracks()[0].enabled = false;
	}
}

function UNMUTE() {
	if(stream){
		stream.getAudioTracks()[0].enabled = true;
	}
}

function STOP_RECORDING() {
	console.log("[PUPPETEER_STREAM] STOP_RECORDING");
	if (!recorder) return;
	if (recorder.state === "inactive") return;

	recorder.stop();
}
