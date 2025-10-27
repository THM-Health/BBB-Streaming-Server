import { SandboxedJob } from 'bullmq';
import { BBBLiveStream } from "./BBBLiveStream";

module.exports = async (job: SandboxedJob) => {
    console.log("Starting job "+job.id);
    try {
        const livestream = new BBBLiveStream(job);
        const result = await livestream.startStream();
        console.log("Job "+job.id+" completed successfully with result: "+result);
        return result;
    } catch (error) {
        console.error("Job "+job.id+" failed with error:", error);
        if (error instanceof Error) {
            console.error("Error stack:", error.stack);
        }
        throw error;
    }
};
