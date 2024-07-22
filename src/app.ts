import express from 'express';
import Redis from 'ioredis';
import Meeting from "./Meeting";

const app = express();
const port = process.env.PORT || 3000;

const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;

app.use(express.json());

// Create a Redis client
const redis = new Redis(redisPort, redisHost);

app.get('/', (req, res) => {
    res.send('Hello Redis with Express.js and TypeScript!');
});


app.get('/create', (req, res) => {

    const rtmp = 'rtmp://a.rtmp.youtube.com/live2/4807-78rm-69u6-6912-2s09';
    const meeting = new Meeting('https://google.com', 'https://google.com', 'https://google.com', rtmp);
    meeting.startStreaming(1920, 1080);

});


// Example of caching data
// Middleware to check if data is in the cache
const checkCache = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const cachedData = await redis.get('cachedData');

    if (cachedData) {
        res.send(JSON.parse(cachedData));
    } else {
        next(); // Continue to the route handler if data is not in the cache
    }
};

// Use the checkCache middleware before the route handler
app.get('/cache', checkCache, async (req, res) => {
    const dataToCache = { message: 'Data to be cached' };
    await redis.set('cachedData', JSON.stringify(dataToCache), 'EX', 3600); // Cache for 1 hour
    res.send(dataToCache);
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

export default app;
