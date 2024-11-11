import { launch, getStream, getStreamOptions } from "./PuppeteerStream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
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
    rtmpUrl: string;

    rtmpStream: ChildProcessWithoutNullStreams | undefined;
    videoConferenceStream: ChildProcessWithoutNullStreams | undefined;
    pauseImageStream: ChildProcessWithoutNullStreams | undefined;

    browser: Browser | undefined;
    page: Page | undefined;

    showPauseImage: boolean = false;
    streamEnded: (() => void) | undefined;
    
    bbbStream: any;
    closing: boolean = false;

    constructor(job: any){
        this.job = job;
        this.joinUrl = job.data.joinUrl;
        this.pauseImageUrl = job.data.pauseImageUrl;
        this.rtmpUrl = job.data.rtmpUrl;
    
        this.redis = new Redis({
            port: redisPort,
            host: redisHost,
            maxRetriesPerRequest: null
        });
    }

    log(message: string){
        const dateTime = new Date().toLocaleString();
        console.log(dateTime+": ["+this.job.id+"] "+message);
    
        //this.job.log(message);
        
    }

    handleRedisMessages() {
        this.redis.subscribe("meeting-"+this.job.id, (err) => {
            if (err) {
                this.stopStream();
                throw new Error("Failed to subscribe to redis control ws: "+err.message);
            } else {
                this.log(
                    `Connected to redis control ws.`
                );
            }
        });

        this.redis.on("message", async(channel, message) => {
            this.log(`Received ${message} from ${channel}`);
            const data = JSON.parse(message);

            if (data.action === "pause") {
                this.pause();
            }

            if (data.action === "resume") {
                this.resume();
            }

            if (data.action === "stop") {
                this.stopStream().then(() => {
                    this.log("Stream ended successfully");
                    this.streamEnded();
                })
            }
        });
    }

    async openBBBMeeting(){
        const options = {
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: { width, height },
            //dumpio: true,
            args: [
                '--no-zygote',
                '--no-sandbox',
                '--start-fullscreen',
                '--disable-gpu',
                `--window-size=${width},${height}`,
                '--disable-setuid-sandbox',
                `--ozone-override-screen-size=${width},${height}`,
                '--headless=new',
            ],
            closeDelay: 100
        };

        this.browser = await launch(options);

        this.page = await this.browser.newPage();

        await this.page.goto(this.joinUrl);
        await this.page.setViewport({width, height});

        try{
            await this.page.locator('[data-test="listenOnlyBtn"]').setTimeout(30000).click();
        }
        catch(error){
            this.log("Could not found audio button");
            this.stopStream();
            return false;
        }

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
        if(this.closing)
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
        this.job.updateProgress({status: "paused"});
        this.page.evaluate((pauseImageUrl: string) => {
            // If no overlay exists, add new overlay
            if(!document.getElementById('block-overlay')){
                const g = document.createElement('div');
                g.setAttribute("id", "block-overlay");
                g.setAttribute("style",'position: fixed; top: 0; right: 0; left: 0; bottom: 0; background-image: url("'+pauseImageUrl+'"); background-size: cover; background-position: center; z-index: 100000');
                document.body.appendChild(g);   
            }
        }, this.pauseImageUrl); 

        this.bbbStream.mute();
    }

    resume(){
        this.job.updateProgress({status: "running"});
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

            try {
                // Start streaming
                await this.job.updateProgress({status: "starting"});
                this.log('Starting streaming');

                const openMeeting = await this.openBBBMeeting();
                if(openMeeting === false){
                    this.streamEnded();
                    return;
                }

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

                this.stopStream().then(() => {
                    throw new Error('Error during streaming: '+JSON.stringify(error));
                })
                
            }

        });
    }

    async stopStream(){
        if(this.closing)
            return;
        this.closing = true;

        this.job.updateProgress({status: "stopping"});
        this.log('Stopping streaming');
        

        await this.redis.quit();

        await new Promise(r => setTimeout(r, 2000));
        
        try{
            await this.page.close();
            this.log("Page closed");
        }
        catch(error){
            this.log('Error closing page:'+JSON.stringify(error));
        }

        try{
            this.bbbStream.stream.destroy();
            this.log("Stream stopped");
        }
        catch(error){
            this.log('Error stopping stream: '+JSON.stringify(error));
        }

        try{
            await this.browser.close();
            this.log("Browser closed");
        }
        catch(error){
            this.log("Error closing browser:" +JSON.stringify(error));
            
            if (this.browser && this.browser.process() != null){
                this.browser.process().kill('SIGKILL');
            }
        }

        try{
            this.rtmpStream.kill('SIGKILL');
            this.log("FFmpeg stopped");
        }
        catch(error){
            this.log('Error killing FFmpeg:'+JSON.stringify(error));
        }

        

        await new Promise(r => setTimeout(r, 2000));
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
    ],
    {
        detached: true
    });

    ffmpeg.on('close', (code, signal) => {
        this.log('ERROR FFmpeg child process closed, code ' + code + ', signal ' + signal);
            
        if(!this.closing){
            this.stopStream().then(() => {
                throw new Error('FFmpeg closed, code ' + code + ', signal ' + signal);
            })
        }
    });

    ffmpeg.stderr.on('data', (data) => {
        this.log('FFmpeg STDERR:'+ data.toString());
    });

   
     return ffmpeg;
}

}