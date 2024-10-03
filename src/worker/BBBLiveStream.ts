import { launch, getStream, getStreamOptions } from "./PuppeteerStream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import fs from 'fs';
import client from 'https';
import { SandboxedJob } from 'bullmq';
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

    constructor(job: any){
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
                this.pause();
            }

            if (data.action === "resume") {
                this.job.updateProgress({status: "running"});
                this.resume();
            }

            if (data.action === "stop") {
                this.stopStream();
            }
        });
    }

    async openBBBMeeting(){
        const options = {
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: { width, height },
            //dumpio: true,
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

        const bbbStreamOptions: getStreamOptions = {
            audio: true,
            video: true,
            audioBitsPerSecond: 128000,
            videoBitsPerSecond: 2500000,
            frameSize: 30,
            mimeType: 'video/webm;codecs=h264'
        }

        this.page.on('console', (message: any) => {
            consoleLog(message.text());
        });

        const consoleLog = (msg: string) => {
            this.log("CONSOLE: "+msg);
        };

        this.bbbStream = await getStream(this.page, bbbStreamOptions, consoleLog);

        this.waitForMeetingEnded();
    }

    async waitForMeetingEnded(){
        if(!this.page)
            return;
        try{
            await this.page.waitForSelector('[data-test="meetingEndedModal"]');
            this.log("Meeting ended or user removed");
            this.stopStream();
        }
        catch(error){
            this.waitForMeetingEnded();
        }
    }

    pause(){
        this.page.evaluate(() => {
            // If no overlay exists, add new overlay
            if(!document.getElementById('block-overlay')){
                const g = document.createElement('div');
                g.setAttribute("id", "block-overlay");
                g.setAttribute("style",'position: fixed; top: 0; right: 0; left: 0; bottom: 0; background-image: url("https://marketplace.canva.com/EAExh819qUA/1/0/1600w/canva-schwarz-und-blau-modern-action-gaming-livestream-twitch-bildschirm-Vv7YJNIL2Jk.jpg"); background-size: cover; background-position: center; z-index: 100000');
                document.body.appendChild(g);   
            }
        }); 

        this.bbbStream.mute();
    }

    resume(){
        this.page.evaluate(() => {
            // Remove overlay if it exists
            if(document.getElementById('block-overlay')){
                document.getElementById('block-overlay').remove();
            }
        }); 

        this.bbbStream.unmute();
    }

    async startStream(){
        this.log('Processing job '+ this.job.id);

        this.handleRedisMessages();

        return new Promise<string>(async (resolve) => {

            this.streamEnded = () => resolve("ended");

            await this.downloadPauseImage();

            try {
                // Start streaming
                await this.job.updateProgress({status: "starting"});
                this.log('Starting streaming');

                await this.openBBBMeeting();

                await this.job.updateProgress({status: "running"});
                this.log('Started streaming');
    
                this.rtmpStream = this.streamToRtmp();

                await this.job.updateProgress({status: "running"});

                this.bbbStream.stream.pipe(this.rtmpStream.stdin);


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
        this.job.updateProgress({status: "stopping"});
   
        this.log("Close page");
        this.page.close();

        this.bbbStream.stream.on("close", async() => {
            this.log("Stream closed");
            this.log("Closing browser");
            await this.browser.close();

            this.log("Waiting for ffmpeg to close");
        });

        this.rtmpStream.on('close', (code, signal) => {
            this.log('FFmpeg rtmp output stream child process closed, code ' + code + ', signal ' + signal);
            
            if(this.streamEnded){
               this.log("Stream end callback");
               setTimeout(() => {
                this.streamEnded();
              }, 5000);
            }
        });
   }

   streamToRtmp(){
    const ffmpeg = spawn('ffmpeg', [
        "-y", "-nostats",
        "-thread_queue_size", "4096",

        '-i', '-',
        
        //'-vcodec', 'copy',
        
        "-b:v", "4000k",

        "-crf", "23", 
        '-bf', '2',
   
        '-vcodec', 'libx264',
        '-x264-params', 'keyint=30:scenecut=-1',
        '-profile:v', 'high',
        '-pix_fmt', "yuv420p",

        '-bufsize', '8000k',
        '-r', '30',
        '-g', '15',
        "-preset", "ultrafast",
        "-tune", "zerolatency",
 

        '-acodec', 'aac',
        "-b:a", "160k",
        "-ar", "48000",
        "-ac", "2",

        "-threads", "0",

        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        this.rtmpUrl
    ]);

    ffmpeg.on('close', (code, signal) => {
        // @ts-ignore
        if(this.job.progress.status !== "stopping"){
            this.log('ERROR Ending FFmpeg rtmp output stream child process closed, code ' + code + ', signal ' + signal);
            throw new Error('FFmpeg closed, code ' + code + ', signal ' + signal);
        }
    });

    ffmpeg.stdin.on('error', (e) => {
        this.log('FFmpeg rtmp output stream STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        this.log('FFmpeg rtmp output stream STDERR:'+ data.toString());
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