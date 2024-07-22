import request from 'supertest';
import app from '../src/app';

describe('Express App', () => {
    it('responds with "Hello Redis with Express.js and TypeScript!" at the root URL', async () => {
        const response = await request(app).get('/');
        expect(response.status).toBe(200);
        expect(response.text).toBe('Hello Redis with Express.js and TypeScript!');
    });

    it('caches data when accessing the /cache route', async () => {
        const response1 = await request(app).get('/cache');
        expect(response1.status).toBe(200);

        const response2 = await request(app).get('/cache');
        expect(response2.status).toBe(200);
        expect(response2.body).toEqual(response1.body);
    });
});
