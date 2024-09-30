import { launch, getStream } from "puppeteer-stream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import fs from 'fs';
import client from 'https';
import { Job, SandboxedJob } from 'bullmq';
import { Browser, Page } from "puppeteer-core";

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const width = 1920;
const height = 1080;

export class BBBLiveStream{

    redis: Redis;
    job: SandboxedJob;
    joinUrl: string;
    pauseImageUrl: string;
    pauseImageFile: string;
    rtmpUrl: string;

    rtmpStream: ChildProcessWithoutNullStreams | undefined;
    videoConferenceStream: ChildProcessWithoutNullStreams | undefined;
    pauseImageStream: ChildProcessWithoutNullStreams | undefined;

    browser: Browser | undefined;
    page: Page | undefined;

    showPauseImage: boolean = false;
    streamEnded: (() => void) | undefined;
    
    bbbStream: any;

    constructor(job: SandboxedJob){
        this.job = job;
        this.joinUrl = job.data.joinUrl;
        this.pauseImageUrl = job.data.pauseImageUrl;
        this.pauseImageFile = '/tmp/pause-image-'+job.id+'.jpg';
        this.rtmpUrl = job.data.rtmpUrl;

        this.redis = new Redis({
            port: redisPort,
            host: redisHost,
            maxRetriesPerRequest: null
        });
    }

    log(message: string){
        this.job.log(message);
    }

    async downloadPauseImage(){
        this.log('Downloading pause image from '+this.pauseImageUrl+' to '+this.pauseImageFile);

        await downloadImage(this.pauseImageUrl, this.pauseImageFile).then((filepath) => {
            this.log('Pause image downloaded to '+filepath);
        }).catch((error) => {
            this.log('Failed to download pause image: '+error);
            throw new Error('Failed to download pause image');
        });
    }

    handleRedisMessages() {
        this.redis.subscribe("meeting-"+this.job.id, (err, count) => {
            if (err) {
                throw new Error("Failed to subscribe: "+err.message);
            } else {
                // `count` represents the number of channels this client are currently subscribed to.
                this.log(
                    `Subscribed successfully! This client is currently subscribed to ${count} channels.`
                );
            }
        });

        this.redis.on("message", async(channel, message) => {
            this.log(`Received ${message} from ${channel}`);
            const data = JSON.parse(message);

            if (data.action === "pause") {
                this.job.updateProgress({status: "paused"});
                this.showPauseImage = true;
            }

            if (data.action === "resume") {
                this.job.updateProgress({status: "running"});
                this.showPauseImage = false;
            }

            if (data.action === "stop") {
                this.job.updateProgress({status: "stopping"});
                this.stopStream();
            }
        });
    }

    async openBBBMeeting(){
        const options = {
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: { width, height },
            args: [
                '--no-sandbox',
                '--start-fullscreen',
                '--disable-gpu',
                `--window-size=${width},${height}`,
                '--disable-setuid-sandbox',
                `--ozone-override-screen-size=${width},${height}`,
                '--headless=new',
            ],
        };

        this.browser = await launch(options);

        this.page = await this.browser.newPage();

        await this.page.goto(this.joinUrl);
        await this.page.setViewport({width, height});

        await this.page.locator('[data-test="listenOnlyBtn"]').setTimeout(10000).click();

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
        this.bbbStream = await getStream(this.page, bbbStreamOptions);
        
    }

    async startStream(){
        this.log('Processing job '+ this.job.id);

        this.handleRedisMessages();

        return new Promise<void>(async (resolve) => {

            this.streamEnded = resolve;

            await this.downloadPauseImage();

            try {
                // Start streaming
                await this.job.updateProgress({status: "starting"});
                this.log('Starting streaming');

                await this.openBBBMeeting();

                await this.job.updateProgress({status: "running"});
                this.log('Started streaming');
    
                this.rtmpStream = await this.streamToRtmp();
                this.videoConferenceStream = await this.streamVideoconference()
                this.pauseImageStream = this.streamPauseImage();

                await this.job.updateProgress({status: "running"});

                this.videoConferenceStream.stdout.on("data", (videoData) => {
                    //this.log('Data from video conference stream: '+(this.showPauseImage ? 'paused' : 'sending'));
                     if(!this.showPauseImage && this.rtmpStream){
                        this.log(videoData);
                        this.rtmpStream.stdin.write(videoData);
                     }
                });
                

                this.pauseImageStream.stdout.on("data", (videoData) => {
                    //this.log('Data from pause image stream: '+(!this.showPauseImage ? 'paused' : 'sending'));
                     if(this.showPauseImage && this.rtmpStream)
                        this.rtmpStream.stdin.write(videoData);
                });

            } catch (error) {
                this.log('Error during streaming: '+JSON.stringify(error));
                // @ts-ignore
                this.log('Error during streaming: '+JSON.stringify(error?.message));
                // @ts-ignore
                this.log('Error during streaming: '+JSON.stringify(error?.stack));

                throw new Error('Error during streaming: '+JSON.stringify(error));
            }

        });
    }

    async stopStream(){

        this.log('Stopping streaming');
   
        await this.job.updateProgress({status: "stopped"});

        if(this.browser)
            await this.browser.close();
       
        if(this.videoConferenceStream)
            this.videoConferenceStream.kill('SIGKILL');

        if(this.pauseImageStream)
            this.pauseImageStream.kill('SIGKILL');
        
        if(this.rtmpStream)
            this.rtmpStream.kill('SIGKILL');
       
        if(this.streamEnded)
            this.streamEnded();
   }

   async streamToRtmp(){
    const ffmpeg = spawn('ffmpeg', [
        "-fflags", "+genpts+igndts+discardcorrupt",

        "-re",

        "-f", "mpegts",

        //"-y", "-nostats",
        //"-thread_queue_size", "4096",

        '-i', '-',

        // If we're encoding H.264 in-browser, we can set the video codec to 'copy'
        // so that we don't waste any CPU and quality with unnecessary transcoding.
        '-c', 'copy',

        '-fps_mode', '1',

        '-bsf:a', 'aac_adtstoasc',

        "-f", "flv",
        this.rtmpUrl
    ]);

    ffmpeg.on('close', (code, signal) => {
        this.log('FFmpeg rtmp output stream child process closed, code ' + code + ', signal ' + signal);
    });

    ffmpeg.stdin.on('error', (e) => {
        this.log('FFmpeg rtmp output stream STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        this.log('FFmpeg rtmp output stream STDERR:'+ data.toString());
    });

   
     return ffmpeg;
}

streamVideoconference(){
    const ffmpeg = spawn('ffmpeg', [
        "-y", "-nostats",
        "-thread_queue_size", "4096",

        '-i', '-',

        
        '-vcodec', 'libx264',
        '-x264-params', 'keyint=30:scenecut=-1',
        '-crf', '23',
        '-profile:v', 'high',
        '-pix_fmt', "yuv420p",
        "-b:v", "4000k",
        '-bf', '0',
        '-maxrate', '4000k',
        '-bufsize', '8000k',
        '-r', '30',
        '-g', '1',
        "-preset", "ultrafast",
        "-tune", "zerolatency",

        '-acodec', 'aac',
        "-b:a", "160k",
        "-ar", "48000",
        "-ac", "2",

        "-threads", "4",

        "-f", "mpegts", "-"
    ]);

    ffmpeg.on('close', (code, signal) => {
        this.log('FFmpeg video conf. child process closed, code ' + code + ', signal ' + signal);
    
    });

    ffmpeg.stdin.on('error', (e) => {
        this.log('FFmpeg video conf. STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        //this.log('FFmpeg video conf. STDERR:'+ data.toString());
    });

    this.bbbStream.pipe(ffmpeg.stdin);
   
    return ffmpeg;
}

streamPauseImage(){
    const ffmpeg = spawn('ffmpeg', [
        "-y", "-nostats",

        "-thread_queue_size", "4096",

        "-f", "image2",
        "-loop", "1",
        "-i", this.pauseImageFile,
        "-re",

        "-f", "lavfi",
        "-i", "anullsrc",

        '-vcodec', 'libx264',
        '-x264-params', 'keyint=30:scenecut=-1',
        '-crf', '23',
        '-profile:v', 'high',
        '-pix_fmt', "yuv420p",
        "-b:v", "4000k",
        '-bf', '0',
        '-maxrate', '4000k',
        '-minrate', '2000k',
        '-bufsize', '8000k',
        '-r', '30',
        '-g', '1',
        "-preset", "ultrafast",
        "-tune", "zerolatency",

        '-acodec', 'aac',
        "-b:a", "160k",
        "-ar", "48000",
        "-ac", "2",

        "-threads", "4",

        "-f", "mpegts", "-"
    ]);

    ffmpeg.on('close', (code, signal) => {
        this.log('FFmpeg pause image child process closed, code ' + code + ', signal ' + signal);
    });

    ffmpeg.stdin.on('error', (e) => {
        this.log('FFmpeg pause image STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        //this.log('FFmpeg pause image STDERR:'+ data.toString());
    });

    return ffmpeg;
}


}


function downloadImage(url: string, filepath: string) {
    return new Promise((resolve, reject) => {
        client.get(url, (res) => {
            if (res.statusCode === 200) {
                res.pipe(fs.createWriteStream(filepath))
                    .on('error', reject)
                    .once('close', () => resolve(filepath));
            } else {
                // Consume response data to free up memory
                res.resume();
                reject(new Error(`Request Failed With a Status Code: ${res.statusCode}`));

            }
        });
    });
}