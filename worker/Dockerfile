FROM node:22-slim AS EXTENSION

WORKDIR /app

COPY ./extension .

RUN npm install
RUN npm run build

RUN ls -la
RUN ls -la src
