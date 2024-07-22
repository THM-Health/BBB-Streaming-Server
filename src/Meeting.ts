// @ts-ignore
import Xvfb from "xvfb";
import { launch, getStream } from "puppeteer-stream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";

export default class Meeting {
    joinUrl: string;
    callbackUrl: string;
    pauseImageUrl: string;
    rtmpUrl: string;

    constructor(joinUrl: string, callbackUrl: string, pauseImageUrl: string, rtmpUrl: string) {
        this.joinUrl = joinUrl;
        this.callbackUrl = callbackUrl;
        this.pauseImageUrl = pauseImageUrl;
        this.rtmpUrl = rtmpUrl;
    }

    async startStreaming( width: number, height: number) {
        let xvfb = new Xvfb({
            displayNum: null,
            silent: true,
            xvfb_args: [
                "-screen",
                "0",
                `${width}x${height}x24`,
                "-ac",
                "-nolisten",
                "tcp",
                "-dpi",
                "96",
                "+extension",
                "RANDR",
            ],
        });

        const command = `xvfb-run -a --server-args="-screen 0 ${width}x${height}x24 -ac -nolisten tcp -dpi 96 +extension RANDR" /usr/bin/google-chrome`;

        const options = {
            headless: false,
            executablePath: "/usr/bin/google-chrome",
            args: [
                "--disable-infobars",
                "--no-sandbox",
                "--shm-size=2gb",
                "--disable-dev-shm-usage",
                "--start-fullscreen",
                "--app="+this.joinUrl,
                `--window-size=${width},${height}`,
            ],
        };


        try {
            // Start streaming
            console.log('Started streaming');

            xvfb.startSync();
            const browser = await launch(options);
            const pages = await browser.pages();
            const page = pages[0];

            console.log("The streaming bot has joined the BBB session");
            console.log("Streaming has started...");

            const bbbStreamOptions = {
                audio: true,
                video: true,
                audioBitsPerSecond: 128000,
                videoBitsPerSecond: 2500000,
                frameSize: 30,
                ignoreMutedMedia: true,
                mimeType: 'video/webm;codecs=h264'
            }

            // @ts-ignore
            const bbbStream = await getStream(page, bbbStreamOptions);

            let ffmpeg: ChildProcessWithoutNullStreams;

            // On stream data  write it to ffmpeg stdin
            bbbStream.on('data', (chunk) => {
                if (ffmpeg) {
                    ffmpeg.stdin.write(chunk);
                }
            });

            // on stream data write it to ffmpeg stdin

            ffmpeg = spawn('ffmpeg', [
                "-y", "-nostats",
                "-thread_queue_size", "4096",

                // FFmpeg will read input video from STDIN
                '-i', '-',

                // If we're encoding H.264 in-browser, we can set the video codec to 'copy'
                // so that we don't waste any CPU and quality with unnecessary transcoding.
                '-vcodec', 'copy',

                // use if you need for smooth youtube publishing. Note: will use more CPU
                // '-vcodec', 'libx264',
                // '-x264-params', 'keyint=120:scenecut=0',

                //No browser currently supports encoding AAC, so we must transcode the audio to AAC here on the server.
                '-acodec', 'aac',
                "-b:a", "160k",

                // remove background noise. You can adjust this values according to your need
                //'-af', 'highpass=f=200, lowpass=f=3000',

                // This option sets the size of this buffer, in packets, for the matching output stream
                "-max_muxing_queue_size", '99999',
                "-ar", "48000",
                "-threads", "0",
                "-b:v", "4000k",
                "-maxrate", "4000k",
                "-minrate", "2000k",
                "-bufsize", "8000k",
                "-g", "60",
                "-preset", "ultrafast",
                "-tune", "zerolatency",

                // FLV is the container format used in conjunction with RTMP
                "-f", "flv",
                "-flvflags", "no_duration_filesize",
                this.rtmpUrl
            ])


            ffmpeg.on('close', (code, signal) => {
                console.log('FFmpeg child process closed, code ' + code + ', signal ' + signal);
            });

            ffmpeg.stdin.on('error', (e) => {
                console.log('FFmpeg STDIN Error', e);
            });

            ffmpeg.stderr.on('data', (data) => {
                console.log('FFmpeg STDERR:', data.toString());
            });
        }
        catch (error) {
            console.error('Failed to start streaming', error);
        }
    }
}
